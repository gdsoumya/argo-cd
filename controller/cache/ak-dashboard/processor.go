package ak_dashboard

import (
	"bytes"
	"context"
	"net/http"
	"sync"
	"time"

	clustercache "github.com/argoproj/argo-cd/gitops-engine/pkg/cache"
	"github.com/argoproj/argo-cd/gitops-engine/pkg/health"
	"github.com/argoproj/argo-cd/gitops-engine/pkg/utils/kube"
	log "github.com/sirupsen/logrus"
	apiextensions "k8s.io/apiextensions-apiserver/pkg/client/clientset/clientset/typed/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/cache"

	"github.com/argoproj/argo-cd/v3/pkg/client/listers/application/v1alpha1"
)

var (
	clusterCacheSetReplaceGKHandler func(handler func(gk schema.GroupKind) func()) clustercache.UpdateSettingsFunc
	dashboardEnabled                bool

	collectClusterInfoInterval = 5 * time.Minute

	httpClientTimeout     = 30 * time.Second
	maxPendingRequests    = 1000
	maxConcurrentRequests = 100

	clusterInfoURL = "http://localhost:8002/k8s-info"
	resourceURL    = "http://localhost:8002/k8s-resources"
)

type Processor interface {
	OnResourceUpdated(res *unstructured.Unstructured, appName string, override health.HealthOverride)
	OnResourceDeleted(res *clustercache.Resource, override health.HealthOverride)
	GetCacheSettings(override health.HealthOverride) []clustercache.UpdateSettingsFunc
	StartInfoCollector(cache clustercache.ClusterCache)
}

type gkEvents struct {
	replaceGk *schema.GroupKind
	deleted   []*clustercache.Resource
	updated   []struct {
		appName string
		res     *unstructured.Unstructured
	}
}

var stopPrevCollector func()

type akProcessor struct {
	replacingGk      sync.Map
	appListener      v1alpha1.ApplicationLister
	extensionsClient *apiextensions.ApiextensionsV1Client
	appsNs           string
	initAppsNs       sync.Mutex
	client           *http.Client
	outReqs          chan *http.Request
	initOutReqs      sync.Once
}

func (p *akProcessor) getAppsNsLister() v1alpha1.ApplicationNamespaceLister {
	if p.appsNs == "" {
		p.initAppsNs.Lock()
		if apps, err := p.appListener.List(labels.Everything()); err == nil && len(apps) > 0 {
			p.appsNs = apps[0].Namespace
		}
		p.initAppsNs.Unlock()
	}
	return p.appListener.Applications(p.appsNs)
}

func (p *akProcessor) processOutReqs() {
	for r := range p.outReqs {
		resp, err := p.client.Do(r)
		if err != nil {
			log.Errorf("failed to send request: %v", err)
			continue
		}
		if resp.StatusCode != http.StatusOK {
			log.Errorf("received non-OK response: %s", resp.Status)
		}
		_ = resp.Body.Close()
	}
}

func (p *akProcessor) sendReq(req *http.Request) {
	p.initOutReqs.Do(func() {
		p.outReqs = make(chan *http.Request, maxPendingRequests)
		for range maxConcurrentRequests {
			go func() {
				p.processOutReqs()
			}()
		}
	})
	select {
	case p.outReqs <- req:
	default:
		log.Warn("outgoing request channel is full, dropping request")
		return
	}
}

func (p *akProcessor) sendEvents(events *gkEvents, override health.HealthOverride) {
	resources := NewResourceEvent(*events, p.getAppsNsLister(), override)
	jsonData, err := resources.Marshal()
	if err != nil {
		log.Errorf("failed to marshal resource events: %v", err)
	}
	log.Debug("sending resource events", string(jsonData))
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, resourceURL, bytes.NewBuffer(jsonData))
	if err != nil {
		log.Errorf("failed to create request: %v", err)
		return
	}
	p.sendReq(req)
}

func (p *akProcessor) sendClusterInfo(info clustercache.ClusterInfo) {
	crds, err := p.extensionsClient.CustomResourceDefinitions().List(context.Background(), metav1.ListOptions{})
	if err != nil {
		log.Errorf("failed to list CRDs: %v", err)
	}
	clusterInfo := NewClusterInfo(info, crds)
	jsonData, err := clusterInfo.Marshal()
	log.Debug("sending resource events", string(jsonData))
	if err != nil {
		log.Errorf("failed to marshal cluster info: %v", err)
		return
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, clusterInfoURL, bytes.NewBuffer(jsonData))
	if err != nil {
		log.Errorf("failed to create request: %v", err)
		return
	}
	p.sendReq(req)
}

func (p *akProcessor) StartInfoCollector(cache clustercache.ClusterCache) {
	if stopPrevCollector != nil {
		stopPrevCollector()
	}
	ctx, cancel := context.WithCancel(context.Background())
	stopPrevCollector = cancel

	go func() {
		ticker := time.NewTicker(collectClusterInfoInterval)
		defer ticker.Stop()
		if err := cache.EnsureSynced(); err == nil {
			p.sendClusterInfo(cache.GetClusterInfo())
		}
		for {
			select {
			case <-ticker.C:
				p.sendClusterInfo(cache.GetClusterInfo())
			case <-ctx.Done():
			}
		}
	}()
}

func (p *akProcessor) OnResourceDeleted(res *clustercache.Resource, override health.HealthOverride) {
	if val, isReplacing := p.replacingGk.Load(res.ResourceKey().GroupKind()); isReplacing {
		events := val.(*gkEvents)
		events.deleted = append(events.deleted, res)
	} else {
		p.sendEvents(&gkEvents{deleted: []*clustercache.Resource{res}}, override)
	}
}

func (p *akProcessor) OnResourceUpdated(res *unstructured.Unstructured, appName string, override health.HealthOverride) {
	item := struct {
		appName string
		res     *unstructured.Unstructured
	}{
		appName: appName,
		res:     res,
	}
	if val, isReplacing := p.replacingGk.Load(kube.GetResourceKey(res).GroupKind()); isReplacing {
		events := val.(*gkEvents)
		events.updated = append(events.updated, item)
	} else {
		p.sendEvents(&gkEvents{updated: []struct {
			appName string
			res     *unstructured.Unstructured
		}{item}}, override)
	}
}

func (p *akProcessor) GetCacheSettings(override health.HealthOverride) []clustercache.UpdateSettingsFunc {
	return []clustercache.UpdateSettingsFunc{clusterCacheSetReplaceGKHandler(func(gk schema.GroupKind) func() {
		p.replacingGk.Store(gk, &gkEvents{replaceGk: &gk})
		return func() {
			if val, loaded := p.replacingGk.LoadAndDelete(gk); loaded {
				p.sendEvents(val.(*gkEvents), override)
			}
		}
	})}
}

func NewProcessor(appInformer cache.SharedIndexInformer, config *rest.Config) (Processor, error) {
	log.Infof("AK Dashboard enabled: %v", dashboardEnabled)
	if !dashboardEnabled {
		return &noopProcessor{}, nil
	}

	extensionsClient, err := apiextensions.NewForConfig(config)
	if err != nil {
		return nil, err
	}

	return &akProcessor{
		client: &http.Client{
			Timeout: httpClientTimeout,
		},
		appListener:      v1alpha1.NewApplicationLister(appInformer.GetIndexer()),
		extensionsClient: extensionsClient,
	}, nil
}

type noopProcessor struct{}

func (n noopProcessor) StartInfoCollector(_ clustercache.ClusterCache) {
}

func (n noopProcessor) OnResourceUpdated(_ *unstructured.Unstructured, _ string, _ health.HealthOverride) {
}

func (n noopProcessor) OnResourceDeleted(_ *clustercache.Resource, _ health.HealthOverride) {
}

func (n noopProcessor) GetCacheSettings(_ health.HealthOverride) []clustercache.UpdateSettingsFunc {
	return nil
}
