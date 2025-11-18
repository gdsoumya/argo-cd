package webhook

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/argoproj/argo-cd/v3/reposerver/cache"
	cacheutil "github.com/argoproj/argo-cd/v3/util/cache"
	"github.com/argoproj/argo-cd/v3/util/env"
	"github.com/argoproj/argo-cd/v3/util/io"
)

type client struct {
	*redis.Client
	password  string
	createdAt time.Time
}

var (
	prevACLFileStat        *os.FileInfo
	passwordsByClusterName = map[string]string{}
	clientsByCluster       map[string]*client
	clientsLock            = sync.Mutex{}
	aclFileLocation        = env.StringFromEnv("ARGOCD_REDIS_ACL_FILE_LOCATION", "/etc/redis-acl/data")
)

func setNewRevisionManifestsOnManagedCluster(clusterName string, oldKey, newKey cache.ManifestKey) error {
	redisClient, err := getRedisClientForCluster(clusterName)
	if err != nil {
		return fmt.Errorf("failed to get redis client for cluster %s: %w", clusterName, err)
	}

	redisCacheClient := cacheutil.NewRedisCache(redisClient, 24*time.Hour, cacheutil.RedisCompressionGZip)
	cacheClient := cacheutil.NewCache(redisCacheClient)
	repoCache := cache.NewCache(cacheClient, 24*time.Hour, 3*time.Minute, 10*time.Second)

	return repoCache.SetNewRevisionManifests(oldKey, newKey)
}

func getRedisClientForCluster(clusterName string) (*redis.Client, error) {
	clientsLock.Lock()
	defer clientsLock.Unlock()
	redisPassword, err := getRedisPasswordFromACLSecretFile(clusterName)
	if err != nil {
		return nil, err
	}
	if clientsByCluster == nil {
		clientsByCluster = map[string]*client{}
	}
	var prevClient *client
	if c, ok := clientsByCluster[clusterName]; ok {
		prevClient = c
	}
	if prevClient != nil && prevClient.password == redisPassword && time.Since(prevClient.createdAt) < 10*time.Minute {
		return prevClient.Client, nil
	}
	if prevClient != nil {
		io.Close(prevClient)
	}
	redisClient := redis.NewClient(&redis.Options{
		Addr:     fmt.Sprintf("cluster-%s:6379", clusterName),
		Password: redisPassword,
		DB:       0,
		Username: "",
	})
	clientsByCluster[clusterName] = &client{Client: redisClient, password: redisPassword, createdAt: time.Now()}
	return redisClient, nil
}

func getRedisPasswordFromACLSecretFile(clusterName string) (string, error) {
	stats, err := os.Stat(aclFileLocation)
	if err != nil {
		return "", fmt.Errorf("failed to stat redis-acl secret file: %w", err)
	}

	// If the file has changed since last read invalidate the cache
	if prevACLFileStat == nil || !stats.ModTime().Equal((*prevACLFileStat).ModTime()) || stats.Size() != (*prevACLFileStat).Size() {
		passwordsByClusterName = nil
	}

	if passwordsByClusterName == nil {
		data, err := os.ReadFile(aclFileLocation)
		if err != nil {
			return "", fmt.Errorf("failed to read redis-acl secret file: %w", err)
		}
		prevACLFileStat = &stats
		passwordsByClusterName, err = parseRedisPasswords(data)
		if err != nil {
			return "", fmt.Errorf("failed to parse redis-acl secret file: %w", err)
		}
	}
	pwd, ok := passwordsByClusterName[clusterName]
	if !ok {
		return "", fmt.Errorf("no redis password found for cluster %s in redis-acl secret", clusterName)
	}
	return pwd, nil
}

// parseRedisPasswords returns (map of cluster -> password, error) matching the pattern used in agent/pkg/client/cluster.go GetRedisACLEntry.
func parseRedisPasswords(data []byte) (map[string]string, error) {
	users := strings.Split(strings.TrimSpace(string(data)), "\n")

	// Pattern to match rotation suffix like ".rot-1", ".rot-2", etc. (matches GetAgentSuffix pattern)
	rotSuffixPattern := regexp.MustCompile(`\.rot-\d+$`)
	res := map[string]string{}

	for _, user := range users {
		user = strings.TrimSpace(user)
		if user == "" {
			continue
		}
		permissions := strings.Split(user, " ")
		if len(permissions) < 3 {
			return nil, fmt.Errorf("failed to parse acl entry in redis-acl secret, error=invalid no. of parts: %q", user)
		}
		aclUsername := rotSuffixPattern.ReplaceAllString(permissions[1], "")
		res[aclUsername] = strings.TrimPrefix(permissions[len(permissions)-1], ">")
	}

	return res, nil
}
