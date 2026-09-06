package web

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewHandlerServesCockpitAndDelegatesAPI(t *testing.T) {
	apiHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Flux-Delegated", r.URL.Path)
		w.WriteHeader(http.StatusTeapot)
	})
	handler := NewHandler(apiHandler)

	tests := []struct {
		name       string
		path       string
		wantStatus int
		wantHeader string
		wantBody   string
	}{
		{name: "cockpit", path: "/", wantStatus: http.StatusOK, wantBody: "theme-toggle"},
		{name: "reload control", path: "/", wantStatus: http.StatusOK, wantBody: "Reload view"},
		{name: "sync control", path: "/", wantStatus: http.StatusOK, wantBody: "Sync now"},
		{name: "sync status", path: "/", wantStatus: http.StatusOK, wantBody: "sync-status-text"},
		{name: "cockpit actions", path: "/", wantStatus: http.StatusOK, wantBody: "Choose an existing GitLab label"},
		{name: "confirm starts disabled", path: "/", wantStatus: http.StatusOK, wantBody: `id="label-confirm-button" type="button" disabled`},
		{name: "mutation status", path: "/", wantStatus: http.StatusOK, wantBody: "mutation-status"},
		{name: "human context", path: "/", wantStatus: http.StatusOK, wantBody: "Record delivery context"},
		{name: "ceremony reports", path: "/", wantStatus: http.StatusOK, wantBody: "Ceremony reports"},
		{name: "report tabs", path: "/", wantStatus: http.StatusOK, wantBody: "data-report-kind=\"retrospective\""},
		{name: "context script", path: "/app.js", wantStatus: http.StatusOK, wantBody: "loadContext"},
		{name: "report script", path: "/app.js", wantStatus: http.StatusOK, wantBody: "loadReport"},
		{name: "script", path: "/app.js", wantStatus: http.StatusOK, wantBody: "reloadView"},
		{name: "api", path: "/api/today", wantStatus: http.StatusTeapot, wantHeader: "/api/today"},
		{name: "milestones", path: "/api/milestones", wantStatus: http.StatusTeapot, wantHeader: "/api/milestones"},
		{name: "action API", path: "/api/actions/csrf", wantStatus: http.StatusTeapot, wantHeader: "/api/actions/csrf"},
		{name: "health", path: "/healthz", wantStatus: http.StatusTeapot, wantHeader: "/healthz"},
		{name: "webhook", path: "/webhooks/gitlab", wantStatus: http.StatusTeapot, wantHeader: "/webhooks/gitlab"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, test.path, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d", response.Code, test.wantStatus)
			}
			if test.wantHeader != "" && response.Header().Get("X-Flux-Delegated") != test.wantHeader {
				t.Fatalf("delegated path = %q, want %q", response.Header().Get("X-Flux-Delegated"), test.wantHeader)
			}
			if test.wantBody != "" {
				body, err := io.ReadAll(response.Body)
				if err != nil {
					t.Fatalf("read body: %v", err)
				}
				if !strings.Contains(string(body), test.wantBody) {
					t.Fatalf("body does not contain %q", test.wantBody)
				}
			}
		})
	}
}

func TestNewHandlerReturnsNotFoundForUnknownAsset(t *testing.T) {
	handler := NewHandler(http.NotFoundHandler())
	request := httptest.NewRequest(http.MethodGet, "/does-not-exist", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusNotFound)
	}
}
