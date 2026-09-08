package api

import (
	"context"
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
				ID:           "team/project#12",
				ProjectID:    42,
				ProjectPath:  "team/project",
				Title:        "Build the cockpit",
				State:        domain.IssueOpen,
				Assignee:     "alex",
				Labels:       []string{"priority::high", "customer"},
				LastActivity: generatedAt,
				MergeRequests: []domain.MergeRequest{{
					ID:       "!7",
					Title:    "Cockpit UI",
					State:    domain.MergeRequestOpen,
					Pipeline: domain.PipelineSuccess,
				}},
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
		Total  int            `json:"total"`
		Counts map[string]int `json:"counts"`
		Items  []struct {
			ID            string                `json:"id"`
			ProjectPath   string                `json:"project_path"`
			Labels        []string              `json:"labels"`
			State         domain.IssueState     `json:"state"`
			Assignee      string                `json:"assignee"`
			LastActivity  time.Time             `json:"last_activity"`
			Status        string                `json:"status"`
			MergeRequests []domain.MergeRequest `json:"merge_requests"`
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
	if body.Total != 1 || body.Counts[string(domain.StatusInProgress)] != 1 {
		t.Fatalf("summary = total %d counts %+v, want one in-progress item", body.Total, body.Counts)
	}
	if len(body.Items) != 1 || body.Items[0].ID != "team/project#12" || body.Items[0].ProjectPath != "team/project" || body.Items[0].State != domain.IssueOpen || body.Items[0].Assignee != "alex" || len(body.Items[0].Labels) != 2 || body.Items[0].Labels[0] != "priority::high" || !body.Items[0].LastActivity.Equal(generatedAt) || body.Items[0].Status != "in progress" {
		t.Fatalf("items = %+v, want enriched in-progress item", body.Items)
	}
	if len(body.Items[0].MergeRequests) != 1 || body.Items[0].MergeRequests[0].ID != "!7" || body.Items[0].MergeRequests[0].Pipeline != domain.PipelineSuccess {
		t.Fatalf("merge requests = %+v, want linked merge request", body.Items[0].MergeRequests)
	}
}

type fakeMilestoneSource struct {
	milestones []domain.Milestone
	snapshots  map[string]domain.Snapshot
	target     string
	name       string
	goal       string
}

func (f *fakeMilestoneSource) ListMilestones(_ context.Context, target string) ([]domain.Milestone, error) {
	f.target = target
	return f.milestones, nil
}

func (f *fakeMilestoneSource) SnapshotForMilestone(_ context.Context, target, name, goal string) (domain.Snapshot, error) {
	f.target = target
	f.name = name
	f.goal = goal
	return f.snapshots[name], nil
}

func TestMilestonePickerAPI(t *testing.T) {
	generatedAt := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	store := state.NewMemoryStore()
	store.Put(domain.Snapshot{
		GeneratedAt: generatedAt,
		Sprint:      domain.Sprint{Name: "Flow 01"},
	})
	source := &fakeMilestoneSource{
		milestones: []domain.Milestone{
			{Name: "Flow 01", Goal: "First slice", State: "active"},
			{Name: "Flow 02", Goal: "Second slice", State: "active"},
		},
		snapshots: map[string]domain.Snapshot{
			"Flow 02": {
				GeneratedAt: generatedAt.Add(time.Hour),
				Sprint:      domain.Sprint{Name: "Flow 02", Goal: "Second slice"},
			},
		},
	}
	handler := NewHandlerWithMilestones(store, http.NotFoundHandler(), time.Hour, source, "team/platform", "")

	request := httptest.NewRequest(http.MethodGet, "/api/milestones", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("milestones status = %d, want %d", response.Code, http.StatusOK)
	}
	var milestones struct {
		Current    string `json:"current"`
		Milestones []struct {
			Name      string `json:"name"`
			Goal      string `json:"goal"`
			StartDate string `json:"start_date"`
		} `json:"milestones"`
	}
	if err := json.NewDecoder(response.Body).Decode(&milestones); err != nil {
		t.Fatalf("decode milestones: %v", err)
	}
	if milestones.Current != "Flow 01" || len(milestones.Milestones) != 2 || milestones.Milestones[1].Name != "Flow 02" || milestones.Milestones[1].Goal != "Second slice" {
		t.Fatalf("milestones = %+v", milestones)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/today?milestone=Flow+02", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("selected today status = %d, want %d", response.Code, http.StatusOK)
	}
	var today struct {
		Sprint struct {
			Name string `json:"name"`
		} `json:"sprint"`
	}
	if err := json.NewDecoder(response.Body).Decode(&today); err != nil {
		t.Fatalf("decode selected today: %v", err)
	}
	if today.Sprint.Name != "Flow 02" || source.target != "team/platform" || source.name != "Flow 02" {
		t.Fatalf("selected snapshot = %+v, source = %+v", today, source)
	}
}

type fakeSyncStatusSource struct {
	status domain.SyncStatus
}

func (f fakeSyncStatusSource) SyncStatus() domain.SyncStatus {
	return f.status
}

func TestSyncStatus(t *testing.T) {
	generatedAt := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	startedAt := generatedAt.Add(-time.Second)
	completedAt := generatedAt
	store := state.NewMemoryStore()
	if err := store.Put(domain.Snapshot{GeneratedAt: generatedAt}); err != nil {
		t.Fatalf("store.Put() error = %v", err)
	}
	handler := NewHandlerWithSync(
		store,
		http.NotFoundHandler(),
		time.Hour,
		nil,
		"",
		"",
		fakeSyncStatusSource{status: domain.SyncStatus{
			State:           domain.SyncStateError,
			LastStartedAt:   startedAt,
			LastCompletedAt: completedAt,
			LastDuration:    1500 * time.Millisecond,
			LastError:       "GitLab unavailable",
		}},
	)
	request := httptest.NewRequest(http.MethodGet, "/api/sync/status", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("sync status = %d, want %d", response.Code, http.StatusOK)
	}
	var body struct {
		State               string    `json:"state"`
		LastStartedAt       time.Time `json:"last_started_at"`
		LastCompletedAt     time.Time `json:"last_completed_at"`
		LastDurationMS      int64     `json:"last_duration_ms"`
		LastError           string    `json:"last_error"`
		SnapshotGeneratedAt time.Time `json:"snapshot_generated_at"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode sync status: %v", err)
	}
	if body.State != string(domain.SyncStateError) || !body.LastStartedAt.Equal(startedAt) || !body.LastCompletedAt.Equal(completedAt) || body.LastDurationMS != 1500 || body.LastError != "GitLab unavailable" || !body.SnapshotGeneratedAt.Equal(generatedAt) {
		t.Fatalf("sync status = %+v", body)
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
