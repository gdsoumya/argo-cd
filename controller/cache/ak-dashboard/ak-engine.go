//go:build akengine

package ak_dashboard

import (
	"os"

	clustercache "github.com/argoproj/gitops-engine/pkg/cache"
)

func init() {
	clusterCacheSetReplaceGKHandler = clustercache.SetReplaceGKHandler

	dashboardEnabled = os.Getenv("AK_DASHBOARD_ENABLED") == "true"
}
