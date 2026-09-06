package state

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
)

func TestFileStorePersistsSnapshotAndEvents(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenFileStore(directory)
	if err != nil {
		t.Fatalf("OpenFileStore() error = %v", err)
	}
	if _, ok := store.Get(); ok {
		t.Fatal("new store should not be ready")
	}

	generatedAt := time.Date(2026, time.January, 12, 12, 0, 0, 0, time.UTC)
	wantSnapshot := domain.Snapshot{
		GeneratedAt: generatedAt,
		Sprint: domain.Sprint{
			Name: "Flow 01",
			WorkItems: []domain.WorkItem{{
				ID:       "#12",
				Title:    "Persist the read model",
				State:    domain.IssueOpen,
				Assignee: "alex",
				Labels:   []string{"priority::high"},
			}},
		},
	}
	if err := store.Put(wantSnapshot); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	if err := store.RecordEvent(Event{
		Kind:        "Issue Hook",
		DeliveryID:  "delivery-1",
		ProjectID:   42,
		ProjectPath: "team/project",
		ReceivedAt:  generatedAt,
	}); err != nil {
		t.Fatalf("RecordEvent() error = %v", err)
	}
	if err := store.RecordAudit(AuditEvent{
		ID:           "audit-1",
		RecordedAt:   generatedAt,
		Action:       "add_label",
		PlanID:       "plan-1",
		ActorSubject: "user-1",
		ItemID:       "team/project#12",
		ProjectPath:  "team/project",
		ProjectID:    42,
		IssueIID:     12,
		Label:        "status::blocked",
		Outcome:      "planned",
	}); err != nil {
		t.Fatalf("RecordAudit() error = %v", err)
	}

	gotSnapshot, ok := store.Get()
	if !ok {
		t.Fatal("store should be ready after Put")
	}
	if gotSnapshot.Sprint.Name != wantSnapshot.Sprint.Name || len(gotSnapshot.Sprint.WorkItems) != 1 || len(gotSnapshot.Sprint.WorkItems[0].Labels) != 1 || gotSnapshot.Sprint.WorkItems[0].Labels[0] != "priority::high" {
		t.Fatalf("snapshot = %+v, want %+v", gotSnapshot, wantSnapshot)
	}

	reopened, err := OpenFileStore(directory)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	gotSnapshot, ok = reopened.Get()
	if !ok {
		t.Fatal("reopened store should load the snapshot")
	}
	if gotSnapshot.GeneratedAt != generatedAt || gotSnapshot.Sprint.WorkItems[0].ID != "#12" || len(gotSnapshot.Sprint.WorkItems[0].Labels) != 1 || gotSnapshot.Sprint.WorkItems[0].Labels[0] != "priority::high" {
		t.Fatalf("reopened snapshot = %+v, want %+v", gotSnapshot, wantSnapshot)
	}

	file, err := os.Open(filepath.Join(directory, eventsFilename))
	if err != nil {
		t.Fatalf("open event log: %v", err)
	}
	defer file.Close()
	var event Event
	scanner := bufio.NewScanner(file)
	if !scanner.Scan() {
		t.Fatal("event log is empty")
	}
	if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
		t.Fatalf("decode event: %v", err)
	}
	if event.Kind != "Issue Hook" || event.DeliveryID != "delivery-1" || event.ProjectID != 42 {
		t.Fatalf("event = %+v, want persisted metadata", event)
	}
	if scanner.Scan() {
		t.Fatal("expected one event")
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan event log: %v", err)
	}

	auditFile, err := os.Open(filepath.Join(directory, auditFilename))
	if err != nil {
		t.Fatalf("open audit log: %v", err)
	}
	defer auditFile.Close()
	var audit AuditEvent
	auditScanner := bufio.NewScanner(auditFile)
	if !auditScanner.Scan() {
		t.Fatal("audit log is empty")
	}
	if err := json.Unmarshal(auditScanner.Bytes(), &audit); err != nil {
		t.Fatalf("decode audit: %v", err)
	}
	if audit.ID != "audit-1" || audit.Action != "add_label" || audit.Outcome != "planned" || audit.ActorSubject != "user-1" {
		t.Fatalf("audit = %+v, want persisted action metadata", audit)
	}
	if auditScanner.Scan() {
		t.Fatal("expected one audit event")
	}
	if err := auditScanner.Err(); err != nil {
		t.Fatalf("scan audit log: %v", err)
	}
}

func TestOpenFileStoreRejectsCorruptSnapshot(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, snapshotFilename), []byte("not-json"), 0o600); err != nil {
		t.Fatalf("write corrupt snapshot: %v", err)
	}
	if _, err := OpenFileStore(directory); err == nil {
		t.Fatal("OpenFileStore() error = nil, want corrupt snapshot error")
	}
}
