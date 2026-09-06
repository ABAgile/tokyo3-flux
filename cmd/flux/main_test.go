package main

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
)

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
	if item.ID != "tokyo3/flux#7" || item.ProjectPath != "tokyo3/flux" || item.Status != domain.StatusBlocked {
		t.Fatalf("item = %#v", item)
	}
}
