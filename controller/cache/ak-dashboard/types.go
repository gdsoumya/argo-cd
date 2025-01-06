package ak_dashboard

import (
	"encoding/json"

	clustercache "github.com/argoproj/gitops-engine/pkg/cache"
	"github.com/argoproj/gitops-engine/pkg/health"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/argoproj/argo-cd/v3/pkg/client/listers/application/v1alpha1"
)

type ClusterInfo struct {
	K8sVersion       string        `json:"k8sVersion,omitempty"`
	APIResources     []APIResource `json:"apiResources,omitempty"`
	APIResourceCount int           `json:"apiResourceCount,omitempty"`
	ObjectCount      int           `json:"objectCount,omitempty"`
}

type APIResource struct {
	Group         string   `json:"group,omitempty"`
	Version       string   `json:"version,omitempty"`
	Kind          string   `json:"kind,omitempty"`
	Columns       []Column `json:"columns,omitempty"`
	ClusterScoped bool     `json:"clusterScoped,omitempty"`
}

type Column struct {
	Name     string `json:"name,omitempty"`
	JSONPath string `json:"jsonPath,omitempty"`
}

func NewClusterInfo(info clustercache.ClusterInfo, crds *apiextensionsv1.CustomResourceDefinitionList) ClusterInfo {
	columnsByGVK := map[metav1.GroupVersionKind][]Column{}
	for _, crd := range crds.Items {
		for _, v := range crd.Spec.Versions {
			columns := make([]Column, 0, len(v.AdditionalPrinterColumns))
			for _, col := range v.AdditionalPrinterColumns {
				columns = append(columns, Column{
					Name:     col.Name,
					JSONPath: col.JSONPath,
				})
			}
			columnsByGVK[metav1.GroupVersionKind{Group: crd.Spec.Group, Kind: crd.Spec.Names.Kind, Version: v.Name}] = columns
		}
	}

	apiResources := make([]APIResource, 0, len(info.APIResources))
	for _, resource := range info.APIResources {
		apiResources = append(apiResources, APIResource{
			Group:         resource.GroupKind.Group,
			Version:       resource.GroupVersionResource.Version,
			Kind:          resource.GroupKind.Kind,
			Columns:       columnsByGVK[metav1.GroupVersionKind{Group: resource.GroupKind.Group, Kind: resource.GroupKind.Kind, Version: resource.GroupVersionResource.Version}],
			ClusterScoped: !resource.Meta.Namespaced,
		})
	}

	return ClusterInfo{
		K8sVersion:       info.K8SVersion,
		APIResources:     apiResources,
		APIResourceCount: info.APIsCount,
		ObjectCount:      info.ResourcesCount,
	}
}

func (c *ClusterInfo) Marshal() ([]byte, error) {
	return json.Marshal(c)
}

type ResourceEvents struct {
	ReplaceGK        *schema.GroupKind           `json:"replaceGk,omitempty"`
	DeletedResources []unstructured.Unstructured `json:"deletedResources,omitempty"`
	UpdatedResources []UpdatedResource           `json:"updatedResources,omitempty"`
}

type UpdatedResource struct {
	ApplicationInfo ApplicationInfo           `json:"applicationInfo,omitempty"`
	Resource        unstructured.Unstructured `json:"resource,omitempty"`
}

type ApplicationInfo struct {
	Name         string `json:"name,omitempty"`
	SyncStatus   string `json:"syncStatus,omitempty"`
	HealthStatus string `json:"healthStatus,omitempty"`
}

func NewResourceEvent(events gkEvents, appLister v1alpha1.ApplicationNamespaceLister, override health.HealthOverride) ResourceEvents {
	resourceEvents := ResourceEvents{
		ReplaceGK: events.replaceGk,
	}
	deletedObjs := make([]unstructured.Unstructured, 0, len(events.deleted))
	for _, res := range events.deleted {
		ref := res.Ref
		obj := unstructured.Unstructured{}
		obj.SetUID(ref.UID)
		obj.SetName(ref.Name)
		obj.SetNamespace(ref.Namespace)
		obj.SetAPIVersion(ref.APIVersion)
		obj.SetKind(ref.Kind)
		obj.SetOwnerReferences(res.OwnerRefs)
		deletedObjs = append(deletedObjs, obj)
	}
	resourceEvents.DeletedResources = deletedObjs
	updatedObjs := make([]UpdatedResource, 0, len(events.updated))
	for _, event := range events.updated {
		if event.res == nil {
			continue
		}
		applicationInfo := ApplicationInfo{
			Name: event.appName,
		}
		healthStatus, err := health.GetResourceHealth(event.res, override)
		if err != nil {
			continue
		}
		if healthStatus != nil {
			applicationInfo.HealthStatus = string(healthStatus.Status)
		}
		updatedObjs = append(updatedObjs, UpdatedResource{
			ApplicationInfo: applicationInfo,
			Resource:        *event.res,
		})
	}
	resourceEvents.UpdatedResources = updatedObjs
	return resourceEvents
}

func (r *ResourceEvents) Marshal() ([]byte, error) {
	return json.Marshal(r)
}
