package fixture

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
)

func TestSourceReloadsSnapshotAndImplementsViews(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "today.json")
	generatedAt := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	first := domain.Snapshot{
		GeneratedAt: generatedAt,
		Sprint: domain.Sprint{
			Name: "Flow 01",
			Goal: "Ship the fixture",
			WorkItems: []domain.WorkItem{{
				ID:           "tokyo3/flux#12",
				ProjectID:    42,
				ProjectPath:  "tokyo3/flux",
				Title:        "Test the cockpit",
				State:        domain.IssueOpen,
				Labels:       []string{"priority::high"},
				LastActivity: generatedAt,
			}},
		},
	}
	writeFixture(t, path, first)

	source, err := New(path)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if source.Path() != path {
		t.Fatalf("Path() = %q, want %q", source.Path(), path)
	}

	snapshot, err := source.Snapshot(context.Background(), "ignored", "Override goal")
	if err != nil {
		t.Fatalf("Snapshot() error = %v", err)
	}
	if snapshot.Sprint.Name != "Flow 01" || snapshot.Sprint.Goal != "Override goal" || snapshot.Sprint.WorkItems[0].Labels[0] != "priority::high" {
		t.Fatalf("snapshot = %+v", snapshot)
	}

	milestones, err := source.ListMilestones(context.Background(), "ignored")
	if err != nil {
		t.Fatalf("ListMilestones() error = %v", err)
	}
	if len(milestones) != 1 || milestones[0].Name != "Flow 01" || milestones[0].State != "active" {
		t.Fatalf("milestones = %+v", milestones)
	}

	issue, err := source.GetIssue(context.Background(), 42, 12)
	if err != nil {
		t.Fatalf("GetIssue() error = %v", err)
	}
	if issue.Title != "Test the cockpit" || issue.ProjectID != 42 || issue.IID != 12 {
		t.Fatalf("issue = %+v", issue)
	}

	labels, err := source.ListProjectLabels(context.Background(), 42)
	if err != nil {
		t.Fatalf("ListProjectLabels() error = %v", err)
	}
	if len(labels) != 1 || labels[0] != "priority::high" {
		t.Fatalf("labels = %v", labels)
	}

	first.Sprint.Name = "Flow 02"
	first.Sprint.WorkItems[0].Title = "Reload the fixture"
	writeFixture(t, path, first)
	updated, err := source.SnapshotForMilestone(context.Background(), "ignored", "Flow 02", "")
	if err != nil {
		t.Fatalf("SnapshotForMilestone() error = %v", err)
	}
	if updated.Sprint.Name != "Flow 02" || updated.Sprint.WorkItems[0].Title != "Reload the fixture" {
		t.Fatalf("updated snapshot = %+v", updated)
	}
}

func TestNewRejectsMissingOrDirectoryFixture(t *testing.T) {
	if _, err := New(filepath.Join(t.TempDir(), "missing.json")); err == nil {
		t.Fatal("New(missing) error = nil")
	}
	directory := t.TempDir()
	if _, err := New(directory); err == nil {
		t.Fatal("New(directory) error = nil")
	}
}

func writeFixture(t *testing.T, path string, snapshot domain.Snapshot) {
	t.Helper()
	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
}
