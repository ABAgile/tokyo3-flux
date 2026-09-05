package gitlab

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
)

func TestSnapshot(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got, want := r.Header.Get("PRIVATE-TOKEN"), "test-token"; got != want {
			t.Errorf("PRIVATE-TOKEN = %q, want %q", got, want)
		}
		if got, want := r.Header.Get("Accept"), "application/json"; got != want {
			t.Errorf("Accept = %q, want %q", got, want)
		}

		switch r.URL.Path {
		case "/api/v4/groups/team/platform/milestones":
			if got, want := r.URL.Query().Get("state"), "active"; got != want {
				t.Errorf("milestone state = %q, want %q", got, want)
			}
			writeJSON(t, w, []map[string]any{{
				"title":       "Flow 01",
				"description": "Ship the first slice",
				"state":       "active",
			}})
		case "/api/v4/groups/team/platform/issues":
			if got, want := r.URL.Query().Get("milestone"), "Flow 01"; got != want {
				t.Errorf("milestone = %q, want %q", got, want)
			}
			if got, want := r.URL.Query().Get("state"), "all"; got != want {
				t.Errorf("state = %q, want %q", got, want)
			}
			if got, want := r.URL.Query().Get("include_subgroups"), "true"; got != want {
				t.Errorf("include_subgroups = %q, want %q", got, want)
			}
			if r.URL.Query().Get("page") == "1" {
				w.Header().Set("X-Next-Page", "2")
				writeJSON(t, w, []map[string]any{{
					"iid":        12,
					"project_id": 42,
					"title":      "Implement synchronization",
					"state":      "opened",
					"references": map[string]string{"full": "team/platform/service#12"},
					"assignees":  []map[string]string{{"username": "alex"}},
					"labels":     []string{"status::blocked"},
					"updated_at": "2026-01-12T10:30:00Z",
				}})
				return
			}
			writeJSON(t, w, []map[string]any{})
		case "/api/v4/projects/42/issues/12/related_merge_requests":
			writeJSON(t, w, []map[string]any{{"iid": 7}})
		case "/api/v4/projects/42/merge_requests/7":
			writeJSON(t, w, map[string]any{
				"iid":           7,
				"title":         "Add synchronization",
				"state":         "opened",
				"draft":         false,
				"reviewers":     []map[string]string{{"username": "sam"}},
				"head_pipeline": map[string]string{"status": "failed"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client, err := New(Config{URL: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	snapshot, err := client.Snapshot(context.Background(), "team/platform", "Ship the first slice")
	if err != nil {
		t.Fatalf("Snapshot() error = %v", err)
	}

	if got, want := snapshot.Sprint.Name, "Flow 01"; got != want {
		t.Errorf("sprint name = %q, want %q", got, want)
	}
	if got, want := snapshot.Sprint.Goal, "Ship the first slice"; got != want {
		t.Errorf("sprint goal = %q, want %q", got, want)
	}
	if got, want := len(snapshot.Sprint.WorkItems), 1; got != want {
		t.Fatalf("work item count = %d, want %d", got, want)
	}

	item := snapshot.Sprint.WorkItems[0]
	if got, want := item.ID, "team/platform/service#12"; got != want {
		t.Errorf("item ID = %q, want %q", got, want)
	}
	if got, want := item.ProjectID, 42; got != want {
		t.Errorf("project ID = %d, want %d", got, want)
	}
	if got, want := item.ProjectPath, "team/platform/service"; got != want {
		t.Errorf("project path = %q, want %q", got, want)
	}
	if got, want := item.Assignee, "alex"; got != want {
		t.Errorf("assignee = %q, want %q", got, want)
	}
	if !item.Blocked {
		t.Error("item should be blocked by its label")
	}
	if got, want := len(item.MergeRequests), 1; got != want {
		t.Fatalf("merge request count = %d, want %d", got, want)
	}
	request := item.MergeRequests[0]
	if got, want := request.ID, "!7"; got != want {
		t.Errorf("merge request ID = %q, want %q", got, want)
	}
	if got, want := request.Pipeline, domain.PipelineFailed; got != want {
		t.Errorf("pipeline = %q, want %q", got, want)
	}
	if !request.ReviewRequested {
		t.Error("merge request should have a requested reviewer")
	}
	if snapshot.GeneratedAt.IsZero() {
		t.Error("snapshot should have a generation time")
	}
}

func TestGroupSnapshotUsesProjectIdentityForRelatedData(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v4/groups/team/platform/milestones":
			writeJSON(t, w, []map[string]any{{
				"title": "Flow 01",
				"state": "active",
			}})
		case "/api/v4/groups/team/platform/issues":
			if got, want := r.URL.Query().Get("milestone"), "Flow 01"; got != want {
				t.Errorf("milestone = %q, want %q", got, want)
			}
			if got, want := r.URL.Query().Get("include_subgroups"), "true"; got != want {
				t.Errorf("include_subgroups = %q, want %q", got, want)
			}
			writeJSON(t, w, []map[string]any{{
				"iid":        12,
				"project_id": 42,
				"title":      "Implement synchronization",
				"state":      "opened",
				"references": map[string]string{"full": "team/platform/service#12"},
				"updated_at": "2026-01-12T10:30:00Z",
			}})
		case "/api/v4/projects/42/issues/12/related_merge_requests":
			writeJSON(t, w, []map[string]any{{"iid": 7}})
		case "/api/v4/projects/42/merge_requests/7":
			writeJSON(t, w, map[string]any{
				"iid":           7,
				"title":         "Add synchronization",
				"state":         "opened",
				"head_pipeline": map[string]string{"status": "success"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client, err := New(Config{URL: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	snapshot, err := client.Snapshot(context.Background(), "team/platform", "Ship the slice")
	if err != nil {
		t.Fatalf("Snapshot() error = %v", err)
	}
	if got, want := len(snapshot.Sprint.WorkItems), 1; got != want {
		t.Fatalf("work item count = %d, want %d", got, want)
	}
	item := snapshot.Sprint.WorkItems[0]
	if got, want := item.ID, "team/platform/service#12"; got != want {
		t.Errorf("item ID = %q, want %q", got, want)
	}
	if got, want := item.ProjectID, 42; got != want {
		t.Errorf("project ID = %d, want %d", got, want)
	}
	if got, want := item.ProjectPath, "team/platform/service"; got != want {
		t.Errorf("project path = %q, want %q", got, want)
	}
	if got, want := len(item.MergeRequests), 1; got != want {
		t.Fatalf("merge request count = %d, want %d", got, want)
	}
}

func TestSelectCurrentMilestone(t *testing.T) {
	now := time.Date(2026, 2, 20, 12, 0, 0, 0, time.UTC)
	milestones := []milestoneResponse{
		{Title: "Flow 01", State: "active", StartDate: "2026-01-01", DueDate: "2026-02-14"},
		{Title: "Flow 02", State: "active", StartDate: "2026-02-15", DueDate: "2026-02-28"},
		{Title: "Flow 03", State: "active", StartDate: "2026-03-01", DueDate: "2026-03-31"},
	}

	milestone, err := selectCurrentMilestone(milestones, now)
	if err != nil {
		t.Fatalf("selectCurrentMilestone() error = %v", err)
	}
	if got, want := milestone.Title, "Flow 02"; got != want {
		t.Fatalf("current milestone = %q, want %q", got, want)
	}

	milestone, err = selectCurrentMilestone(milestones, time.Date(2026, 3, 15, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("selectCurrentMilestone() error = %v", err)
	}
	if got, want := milestone.Title, "Flow 03"; got != want {
		t.Fatalf("current milestone after rollover = %q, want %q", got, want)
	}
}

func TestSelectCurrentMilestoneRequiresActiveMilestone(t *testing.T) {
	_, err := selectCurrentMilestone([]milestoneResponse{{Title: "Closed", State: "closed"}}, time.Now())
	if err == nil {
		t.Fatal("selectCurrentMilestone() error = nil, want error")
	}
}

func TestGroupPathIsEscaped(t *testing.T) {
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		writeJSON(t, w, []map[string]any{})
	}))
	defer server.Close()

	client, err := New(Config{URL: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if _, err := client.listIssues(context.Background(), "team/platform", "Flow 01"); err != nil {
		t.Fatalf("listIssues() error = %v", err)
	}

	want := "/api/v4/groups/team%2Fplatform/issues"
	if gotPath != want {
		t.Fatalf("escaped request path = %q, want %q", gotPath, want)
	}
}

func TestNewValidation(t *testing.T) {
	tests := []struct {
		name string
		cfg  Config
	}{
		{name: "missing URL", cfg: Config{Token: "token"}},
		{name: "missing token", cfg: Config{URL: "https://gitlab.example"}},
		{name: "unsupported scheme", cfg: Config{URL: "ftp://gitlab.example", Token: "token"}},
		{name: "query in URL", cfg: Config{URL: "https://gitlab.example?x=1", Token: "token"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := New(test.cfg); err == nil {
				t.Fatal("New() error = nil, want validation error")
			}
		})
	}
}

func TestAPIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"message":"401 Unauthorized"}`))
	}))
	defer server.Close()

	client, err := New(Config{URL: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	_, err = client.listIssues(context.Background(), "42", "Flow 01")
	if err == nil {
		t.Fatal("listIssues() error = nil, want API error")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error type = %T, want *APIError", err)
	}
	if got, want := apiErr.StatusCode, http.StatusUnauthorized; got != want {
		t.Errorf("status code = %d, want %d", got, want)
	}
}

func writeJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Errorf("encode response: %v", err)
	}
}
