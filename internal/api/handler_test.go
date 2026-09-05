package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
	"abagile.com/tokyo3/flux/internal/state"
)

func TestTodayAndReadiness(t *testing.T) {
	store := state.NewMemoryStore()
	handler := NewHandler(store, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}), 7*24*time.Hour)

	request := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if got, want := response.Code, http.StatusServiceUnavailable; got != want {
		t.Fatalf("ready status = %d, want %d", got, want)
	}

	generatedAt := time.Date(2026, time.January, 12, 12, 0, 0, 0, time.UTC)
	store.Put(domain.Snapshot{
		GeneratedAt: generatedAt,
		Sprint: domain.Sprint{
			Name: "Flow 01",
			Goal: "Keep delivery visible",
			WorkItems: []domain.WorkItem{{
				ID:          "team/project#12",
				ProjectID:   42,
				ProjectPath: "team/project",
				Title:       "Build the cockpit",
				State:       domain.IssueOpen,
				Assignee:    "alex",
			}},
		},
	})

	request = httptest.NewRequest(http.MethodGet, "/api/today", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if got, want := response.Code, http.StatusOK; got != want {
		t.Fatalf("today status = %d, want %d", got, want)
	}

	var body struct {
		GeneratedAt time.Time `json:"generated_at"`
		Sprint      struct {
			Name string `json:"name"`
		} `json:"sprint"`
		Items []struct {
			ID          string `json:"id"`
			ProjectPath string `json:"project_path"`
			Status      string `json:"status"`
		} `json:"items"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode today response: %v", err)
	}
	if !body.GeneratedAt.Equal(generatedAt) {
		t.Errorf("generated_at = %s, want %s", body.GeneratedAt, generatedAt)
	}
	if body.Sprint.Name != "Flow 01" {
		t.Errorf("sprint name = %q, want %q", body.Sprint.Name, "Flow 01")
	}
	if len(body.Items) != 1 || body.Items[0].ID != "team/project#12" || body.Items[0].ProjectPath != "team/project" || body.Items[0].Status != "in progress" {
		t.Fatalf("items = %+v, want one in-progress item", body.Items)
	}
}

func TestHealth(t *testing.T) {
	handler := NewHandler(state.NewMemoryStore(), http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}), time.Hour)
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("health status = %d, want %d", response.Code, http.StatusOK)
	}
}
