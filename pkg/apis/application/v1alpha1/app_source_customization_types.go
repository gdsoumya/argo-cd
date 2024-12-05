package v1alpha1

import "github.com/argoproj/gitops-engine/pkg/utils/kube"

// ApplicationSourceCustomization holds the customization for the application source
type ApplicationSourceCustomization struct {
	Include []ResourceMatcher `json:"include,omitempty" protobuf:"bytes,1,opt,name=include"`
	Exclude []ResourceMatcher `json:"exclude,omitempty" protobuf:"bytes,2,opt,name=exclude"`
}

// IsResourceIncluded checks if the resource is included in the customization
func (c *ApplicationSourceCustomization) IsResourceIncluded(key kube.ResourceKey) bool {
	if len(c.Include) > 0 {
		included := false
		for _, include := range c.Include {
			if include.Match(key) {
				included = true
				break
			}
		}
		if !included {
			return false
		}
	}
	for _, exclude := range c.Exclude {
		if exclude.Match(key) {
			return false
		}
	}
	return true
}

// ResourceMatcher holds the filter for the resource
type ResourceMatcher struct {
	Group     *string `json:"group,omitempty" protobuf:"bytes,1,opt,name=group"`
	Kind      string  `json:"kind,omitempty" protobuf:"bytes,2,opt,name=kind"`
	Name      string  `json:"name,omitempty" protobuf:"bytes,3,opt,name=name"`
	Namespace string  `json:"namespace,omitempty" protobuf:"bytes,4,opt,name=namespace"`
}

func (r *ResourceMatcher) Match(key kube.ResourceKey) bool {
	if r.Group != nil && !globMatch(*r.Group, key.Group, false) {
		return false
	}
	if r.Kind != "" && !globMatch(r.Kind, key.Kind, false) {
		return false
	}
	if r.Name != "" && !globMatch(r.Name, key.Name, false) {
		return false
	}
	if r.Namespace != "" && !globMatch(r.Namespace, key.Namespace, false) {
		return false
	}
	return true
}
