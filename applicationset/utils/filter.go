package utils

import (
	"context"
	gosync "sync"
	"time"

	utilskube "github.com/argoproj/gitops-engine/pkg/utils/kube"
	"github.com/argoproj/pkg/sync"
	"github.com/golang-jwt/jwt/v5"
	log "github.com/sirupsen/logrus"
	"google.golang.org/grpc"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/cache"

	"github.com/argoproj/argo-cd/v3/util/kube"

	"github.com/argoproj/argo-cd/v3/applicationset/services"
	"github.com/argoproj/argo-cd/v3/common"
	appapi "github.com/argoproj/argo-cd/v3/pkg/apiclient/application"
	"github.com/argoproj/argo-cd/v3/pkg/apis/application/v1alpha1"
	"github.com/argoproj/argo-cd/v3/reposerver/apiclient"
	servercache "github.com/argoproj/argo-cd/v3/server/cache"
	cacheutil "github.com/argoproj/argo-cd/v3/util/cache"
	"github.com/argoproj/argo-cd/v3/util/cache/appstate"
	"github.com/argoproj/argo-cd/v3/util/db"
	"github.com/argoproj/argo-cd/v3/util/io"
	"github.com/argoproj/argo-cd/v3/util/rbac"
	"github.com/argoproj/argo-cd/v3/util/settings"

	appclientset "github.com/argoproj/argo-cd/v3/pkg/client/clientset/versioned"

	"github.com/expr-lang/expr"
	"github.com/expr-lang/expr/vm"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/yaml"

	alpha1 "github.com/argoproj/argo-cd/v3/pkg/client/listers/application/v1alpha1"
	"github.com/argoproj/argo-cd/v3/server/application"
)

type repoClientSetAdapter struct {
	apiclient.RepoServerServiceClient
	repoService services.Repos
}

func (r *repoClientSetAdapter) GenerateManifest(ctx context.Context, q *apiclient.ManifestRequest, _ ...grpc.CallOption) (*apiclient.ManifestResponse, error) {
	return r.repoService.GenerateManifest(ctx, q)
}

func (r *repoClientSetAdapter) NewRepoServerClient() (io.Closer, apiclient.RepoServerServiceClient, error) {
	return io.NopCloser, r, nil
}

func NewAppsMatcher(repoService services.Repos, kubeClientSet kubernetes.Interface, db db.ArgoDB, namespace string, settingsManager *settings.SettingsManager, projInformer cache.SharedIndexInformer) *AppsMatcher {
	return &AppsMatcher{
		repoService:     repoService,
		kubeClientSet:   kubeClientSet,
		db:              db,
		namespace:       namespace,
		settingsManager: settingsManager,
		projInformer:    projInformer,
	}
}

type AppsMatcher struct {
	repoService     services.Repos
	kubeClientSet   kubernetes.Interface
	appClientSet    appclientset.Interface
	db              db.ArgoDB
	namespace       string
	settingsManager *settings.SettingsManager
	projInformer    cache.SharedIndexInformer
}

func exprFunc(fn func() (interface{}, error)) func() interface{} {
	once := gosync.Once{}
	return func() interface{} {
		var res interface{}
		var err error
		once.Do(func() {
			res, err = fn()
		})
		if err != nil {
			panic(err)
		}
		return res
	}
}

type srvAdapter struct {
	cache.SharedIndexInformer
	alpha1.ApplicationLister
	app *v1alpha1.Application
	utilskube.Kubectl
}

func (i *srvAdapter) Get(_ string) (*v1alpha1.Application, error) {
	return i.app, nil
}

func (i *srvAdapter) Applications(_ string) alpha1.ApplicationNamespaceLister {
	return i
}

func (i *srvAdapter) AddEventHandler(_ cache.ResourceEventHandler) (cache.ResourceEventHandlerRegistration, error) {
	return nil, nil
}

func (i *srvAdapter) GetAPIResources(config *rest.Config, preferred bool, resourceFilter utilskube.ResourceFilter) ([]utilskube.APIResourceInfo, error) {
	return nil, nil
}

func (i *srvAdapter) GetServerVersion(config *rest.Config) (string, error) {
	return "", nil
}

func (f *AppsMatcher) getContext(ctx context.Context, app *v1alpha1.Application) interface{} {
	enforcer := rbac.NewEnforcer(f.kubeClientSet, f.namespace, common.ArgoCDRBACConfigMapName, func(claims jwt.Claims, rvals ...interface{}) bool {
		return true
	})
	enforcer.EnableEnforce(false)

	d := time.Minute
	adapter := &srvAdapter{app: app}
	srv, _ := application.NewServer(f.namespace,
		f.kubeClientSet,
		f.appClientSet,
		adapter,
		adapter,
		nil,
		&repoClientSetAdapter{repoService: f.repoService},
		servercache.NewCache(appstate.NewCache(cacheutil.NewCache(cacheutil.NewInMemoryCache(d)), d), d, d),
		kube.NewKubectl(),
		f.db,
		enforcer,
		sync.NewKeyLock(),
		f.settingsManager,
		f.projInformer,
		nil, nil, true)
	getManagedResources := func() (interface{}, error) {
		resp, err := srv.GetManifests(ctx, &appapi.ApplicationManifestQuery{Name: &app.Name, AppNamespace: &app.Namespace})
		if err != nil {
			return nil, err
		}
		var objs []interface{}
		for _, item := range resp.Manifests {
			obj := unstructured.Unstructured{}
			if err := yaml.Unmarshal([]byte(item), &obj); err != nil {
				return nil, err
			}
			objs = append(objs, obj.Object)
		}
		return objs, nil
	}
	return map[string]interface{}{
		"app": app,
		"appInfo": map[string]interface{}{
			"GetManagedResources": exprFunc(getManagedResources),
		},
	}
}

// FilterApps filters applications based on the filter
func (f *AppsMatcher) FilterApps(ctx context.Context, logCtx *log.Entry, filter v1alpha1.ApplicationSetFilter, apps []v1alpha1.Application) ([]v1alpha1.Application, error) {
	var res []v1alpha1.Application
	for _, app := range apps {
		match, err := f.Check(ctx, filter, app)
		if err != nil {
			if filter.SkipOnFailure {
				logCtx.WithError(err).Error("SkipOnFailure set to True, skipping error")
				continue
			}
			return nil, err
		}
		if match {
			res = append(res, app)
		}
	}
	return res, nil
}

// Check evaluates the filter against the application
func (f *AppsMatcher) Check(ctx context.Context, filter v1alpha1.ApplicationSetFilter, app v1alpha1.Application) (bool, error) {
	var programs []*vm.Program
	for _, item := range filter.Expressions {
		program, err := expr.Compile(item)
		if err != nil {
			return false, err
		}
		programs = append(programs, program)
	}

	programCtx := f.getContext(ctx, &app)
	for _, program := range programs {
		out, err := expr.Run(program, programCtx)
		if err != nil {
			return false, err
		}
		switch condResult := out.(type) {
		case bool:
			return condResult, nil
		default:
			return false, nil
		}
	}
	return false, nil
}
