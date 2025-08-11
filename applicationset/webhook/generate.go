package webhook

import (
	"encoding/json"
	"fmt"
	"net/http"

	log "github.com/sirupsen/logrus"

	appsettemplate "github.com/argoproj/argo-cd/v3/applicationset/controllers/template"
	appsetutils "github.com/argoproj/argo-cd/v3/applicationset/utils"
	"github.com/argoproj/argo-cd/v3/pkg/apis/application/v1alpha1"
)

func (h *WebhookHandler) AppsetGenerateHandler(w http.ResponseWriter, r *http.Request) {
	var appset v1alpha1.ApplicationSet
	if err := json.NewDecoder(r.Body).Decode(&appset); err != nil {
		http.Error(w, fmt.Sprintf("failed to decode ApplicationSet: %v", err), http.StatusBadRequest)
		return
	}
	apps, _, err := appsettemplate.GenerateApplications(log.WithField("applicationset", appset.Name), appset, h.generators, &appsetutils.Render{}, h.client)
	if err != nil {
		http.Error(w, fmt.Sprintf("error generating applications: %v", err), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(apps); err != nil {
		http.Error(w, fmt.Sprintf("failed to encode applications: %v", err), http.StatusInternalServerError)
		return
	}
}
