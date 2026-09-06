package main

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
	"abagile.com/tokyo3/flux/internal/state"
)

func TestIsLoopbackAddress(t *testing.T) {
	for _, address := range []string{"127.0.0.1:8080", "[::1]:8080", "localhost:8080"} {
		if !isLoopbackAddress(address) {
			t.Errorf("isLoopbackAddress(%q) = false, want true", address)
		}
	}
	for _, address := range []string{"0.0.0.0:8080", ":8080", "192.0.2.10:8080", "bad-address"} {
		if isLoopbackAddress(address) {
			t.Errorf("isLoopbackAddress(%q) = true, want false", address)
		}
	}
}

func TestServeSessionKey(t *testing.T) {
	key, err := serveSessionKey("", true)
	if err != nil {
		t.Fatalf("fixture session key error = %v", err)
	}
	if len(key) != 32 {
		t.Fatalf("fixture session key length = %d, want 32", len(key))
	}
	if _, err := serveSessionKey("", false); err == nil {
		t.Fatal("live session key error = nil")
	}
}

func TestRunChangesJSON(t *testing.T) {
	directory := t.TempDir()
	store, err := state.OpenFileStore(directory)
	if err != nil {
		t.Fatalf("OpenFileStore() error = %v", err)
	}
	item := domain.WorkItem{ID: "team/project#12", ProjectID: 42, Title: "Original", State: domain.IssueOpen}
	if err := store.Put(domain.Snapshot{GeneratedAt: time.Now().UTC(), Sprint: domain.Sprint{Name: "Flow 01", WorkItems: []domain.WorkItem{item}}}); err != nil {
		t.Fatalf("first Put() error = %v", err)
	}
	item.Title = "Changed"
	if err := store.Put(domain.Snapshot{GeneratedAt: time.Now().UTC(), Sprint: domain.Sprint{Name: "Flow 01", WorkItems: []domain.WorkItem{item}}}); err != nil {
		t.Fatalf("second Put() error = %v", err)
	}

	var output bytes.Buffer
	if err := runChanges([]string{"--state-dir", directory, "--json"}, &output, &output); err != nil {
		t.Fatalf("runChanges() error = %v", err)
	}
	var result state.ChangeResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatalf("decode changes: %v\n%s", err, output.String())
	}
	if result.Observations != 2 || len(result.Changes) != 1 || result.Changes[0].After == nil || result.Changes[0].After.Title != "Changed" {
		t.Fatalf("changes result = %+v", result)
	}
}

func TestRunHistoricalViewsJSON(t *testing.T) {
	directory := t.TempDir()
	store, err := state.OpenFileStore(directory)
	if err != nil {
		t.Fatalf("OpenFileStore() error = %v", err)
	}
	first := time.Date(2026, time.June, 1, 9, 0, 0, 0, time.UTC)
	second := first.Add(time.Hour)
	item := domain.WorkItem{ID: "team/project#12", ProjectID: 42, Title: "Historical item", State: domain.IssueOpen, Assignee: "alex", LastActivity: first}
	if err := store.PutObserved(domain.Snapshot{GeneratedAt: first, Sprint: domain.Sprint{Name: "Flow 01", WorkItems: []domain.WorkItem{item}}}, "run-1", first); err != nil {
		t.Fatalf("first PutObserved() error = %v", err)
	}
	item.State = domain.IssueClosed
	if err := store.PutObserved(domain.Snapshot{GeneratedAt: second, Sprint: domain.Sprint{Name: "Flow 01", WorkItems: []domain.WorkItem{item}}}, "run-2", second); err != nil {
		t.Fatalf("second PutObserved() error = %v", err)
	}

	var snapshotOutput bytes.Buffer
	if err := runHistoricalSnapshot([]string{"--state-dir", directory, "--at", second.Format(time.RFC3339), "--json"}, &snapshotOutput, &snapshotOutput); err != nil {
		t.Fatalf("runHistoricalSnapshot() error = %v", err)
	}
	var snapshot state.SnapshotResult
	if err := json.Unmarshal(snapshotOutput.Bytes(), &snapshot); err != nil {
		t.Fatalf("decode historical snapshot: %v\n%s", err, snapshotOutput.String())
	}
	if len(snapshot.Snapshot.Sprint.WorkItems) != 1 || snapshot.Snapshot.Sprint.WorkItems[0].State != domain.IssueClosed {
		t.Fatalf("historical snapshot = %+v", snapshot)
	}

	var historyOutput bytes.Buffer
	if err := runHistory([]string{"--state-dir", directory, "--item", item.ID, "--json"}, &historyOutput, &historyOutput); err != nil {
		t.Fatalf("runHistory() error = %v", err)
	}
	var history state.ChangeResult
	if err := json.Unmarshal(historyOutput.Bytes(), &history); err != nil {
		t.Fatalf("decode item history: %v\n%s", err, historyOutput.String())
	}
	if len(history.Changes) != 2 || history.Changes[0].Kind != state.ChangeKindUpdated {
		t.Fatalf("item history = %+v", history)
	}

	var flowOutput bytes.Buffer
	if err := runFlow([]string{"--state-dir", directory, "--from", first.Format(time.RFC3339), "--to", second.Add(time.Hour).Format(time.RFC3339), "--json"}, &flowOutput, &flowOutput); err != nil {
		t.Fatalf("runFlow() error = %v", err)
	}
	var flow state.FlowResult
	if err := json.Unmarshal(flowOutput.Bytes(), &flow); err != nil {
		t.Fatalf("decode flow: %v\n%s", err, flowOutput.String())
	}
	if flow.Changes != 1 || flow.Completed != 1 {
		t.Fatalf("flow = %+v", flow)
	}
}

func TestRenderTodayJSON(t *testing.T) {
	generatedAt := time.Date(2025, 9, 5, 12, 0, 0, 0, time.UTC)
	snapshot := domain.Snapshot{
		GeneratedAt: generatedAt,
		Sprint: domain.Sprint{
			Name: "2025-W36",
			Goal: "Ship the cockpit",
			WorkItems: []domain.WorkItem{
				{
					ID:           "tokyo3/flux#7",
					ProjectID:    42,
					ProjectPath:  "tokyo3/flux",
					Title:        "Add the first agent tool",
					State:        domain.IssueOpen,
					Labels:       []string{"status::blocked", "priority::high"},
					Blocked:      true,
					LastActivity: generatedAt,
				},
			},
		},
	}
	summary := domain.Summarize(snapshot.Sprint, generatedAt, 7*24*time.Hour)

	var output bytes.Buffer
	if err := renderTodayJSON(&output, snapshot, summary); err != nil {
		t.Fatalf("render JSON: %v", err)
	}

	var response struct {
		GeneratedAt string `json:"generated_at"`
		Sprint      struct {
			Name string `json:"name"`
			Goal string `json:"goal"`
		} `json:"sprint"`
		Summary struct {
			Total  int            `json:"total"`
			Counts map[string]int `json:"counts"`
			Items  []struct {
				ID          string        `json:"id"`
				ProjectPath string        `json:"project_path"`
				Labels      []string      `json:"labels"`
				Status      domain.Status `json:"status"`
			} `json:"items"`
		} `json:"summary"`
	}
	if err := json.Unmarshal(output.Bytes(), &response); err != nil {
		t.Fatalf("decode JSON: %v\n%s", err, output.String())
	}

	if response.GeneratedAt != generatedAt.Format(time.RFC3339Nano) {
		t.Fatalf("generated_at = %q, want %q", response.GeneratedAt, generatedAt.Format(time.RFC3339Nano))
	}
	if response.Sprint.Name != "2025-W36" || response.Sprint.Goal != "Ship the cockpit" {
		t.Fatalf("sprint = %#v", response.Sprint)
	}
	if response.Summary.Total != 1 || response.Summary.Counts[string(domain.StatusBlocked)] != 1 {
		t.Fatalf("summary = %#v", response.Summary)
	}
	if len(response.Summary.Items) != 1 {
		t.Fatalf("items = %#v", response.Summary.Items)
	}
	item := response.Summary.Items[0]
	if item.ID != "tokyo3/flux#7" || item.ProjectPath != "tokyo3/flux" || item.Status != domain.StatusBlocked || len(item.Labels) != 2 || item.Labels[0] != "status::blocked" {
		t.Fatalf("item = %#v", item)
	}
}
