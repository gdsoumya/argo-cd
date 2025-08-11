package applicationset

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/argoproj/argo-cd/v3/pkg/apis/application/v1alpha1"
)

const (
	// customAppsetGeneratePath is the path for the custom ApplicationSet generation handler.
	customAppsetGeneratePath = "/api/akuity/generate"
)

func (s *Server) DelegatedAppsetGenerate(ctx context.Context, appsetSvc string, appset *v1alpha1.ApplicationSet) ([]v1alpha1.Application, error) {
	if appsetSvc != "" {
		appSetJson, err := json.Marshal(appset)
		if err != nil {
			return nil, fmt.Errorf("error marshalling ApplicationSet: %w", err)
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, appsetSvc+customAppsetGeneratePath, bytes.NewBuffer(appSetJson))
		if err != nil {
			return nil, fmt.Errorf("error creating request to delegate service: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
		if err != nil {
			return nil, fmt.Errorf("error calling delegate service: %w", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("error calling delegate service: %s", resp.Status)
		}
		var apps []v1alpha1.Application
		if err := json.NewDecoder(resp.Body).Decode(&apps); err != nil {
			return nil, fmt.Errorf("error decoding response from delegate service: %w", err)
		}
		return apps, nil
	}
	return nil, nil
}
