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

func TestFileStoreRecordsAndReloadsDerivedHistory(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenFileStoreWithStaleAfter(directory, 24*time.Hour)
	if err != nil {
		t.Fatalf("OpenFileStoreWithStaleAfter() error = %v", err)
	}
	firstAt := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	first := domain.Snapshot{
		GeneratedAt: firstAt,
		Sprint: domain.Sprint{
			Name: "Flow 01",
			WorkItems: []domain.WorkItem{{
				ID:           "team/project#12",
				ProjectID:    42,
				ProjectPath:  "team/project",
				Title:        "Original title",
				State:        domain.IssueOpen,
				Assignee:     "alex",
				Labels:       []string{"priority::high", "team::core"},
				LastActivity: firstAt,
			}},
		},
	}
	if err := store.Put(first); err != nil {
		t.Fatalf("first Put() error = %v", err)
	}
	second := first
	second.GeneratedAt = firstAt.Add(time.Hour)
	second.Sprint.WorkItems = []domain.WorkItem{first.Sprint.WorkItems[0]}
	second.Sprint.WorkItems[0].Title = "Changed title"
	second.Sprint.WorkItems[0].Blocked = true
	second.Sprint.WorkItems[0].Labels = []string{"team::core", "priority::high"}
	if err := store.Put(second); err != nil {
		t.Fatalf("second Put() error = %v", err)
	}

	result, err := store.Changes(ChangeQuery{ItemID: "team/project#12"})
	if err != nil {
		t.Fatalf("Changes() error = %v", err)
	}
	if result.Observations != 2 || len(result.Changes) != 1 {
		t.Fatalf("history result = observations %d, changes %d; want 2 and 1", result.Observations, len(result.Changes))
	}
	change := result.Changes[0]
	if change.Kind != ChangeKindUpdated || change.EntityKey != "project/42#12" || change.Before == nil || change.After == nil || change.RevisionHash == "" || change.SourceUpdatedAt == nil || change.SyncRunID != "" {
		t.Fatalf("change = %+v", change)
	}
	fields := make(map[string]bool)
	for _, field := range change.ChangedFields {
		fields[field.Field] = true
	}
	if !fields["title"] || !fields["blocked"] || !fields["status"] || fields["labels"] {
		t.Fatalf("changed fields = %v", fields)
	}
	if result.HistoryStartedAt == nil || result.LastObservedAt == nil {
		t.Fatalf("history coverage = %+v", result)
	}

	baseline, err := store.Changes(ChangeQuery{ItemID: "team/project#12", IncludeBaseline: true})
	if err != nil {
		t.Fatalf("baseline Changes() error = %v", err)
	}
	if len(baseline.Changes) != 2 || baseline.Changes[1].Kind != ChangeKindBaseline {
		t.Fatalf("baseline changes = %+v", baseline.Changes)
	}

	reopened, err := OpenFileStoreWithStaleAfter(directory, 24*time.Hour)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	third := second
	third.GeneratedAt = second.GeneratedAt.Add(time.Hour)
	third.Sprint.WorkItems = []domain.WorkItem{second.Sprint.WorkItems[0]}
	third.Sprint.WorkItems[0].Title = "Third title"
	if err := reopened.Put(third); err != nil {
		t.Fatalf("third Put() error = %v", err)
	}
	result, err = reopened.Changes(ChangeQuery{ItemID: "team/project#12"})
	if err != nil {
		t.Fatalf("reopened Changes() error = %v", err)
	}
	if len(result.Changes) != 2 || result.Changes[0].After == nil || result.Changes[0].After.Title != "Third title" {
		t.Fatalf("reopened history = %+v", result.Changes)
	}
}

func TestFileStoreTracksMilestoneChanges(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenFileStore(directory)
	if err != nil {
		t.Fatalf("OpenFileStore() error = %v", err)
	}
	item := domain.WorkItem{ID: "team/project#12", ProjectID: 42, Title: "Carry over", State: domain.IssueOpen}
	if err := store.Put(domain.Snapshot{GeneratedAt: time.Now().UTC(), Sprint: domain.Sprint{Name: "Flow 01", WorkItems: []domain.WorkItem{item}}}); err != nil {
		t.Fatalf("first Put() error = %v", err)
	}
	if err := store.Put(domain.Snapshot{GeneratedAt: time.Now().UTC(), Sprint: domain.Sprint{Name: "Flow 02", WorkItems: []domain.WorkItem{item}}}); err != nil {
		t.Fatalf("second Put() error = %v", err)
	}
	result, err := store.Changes(ChangeQuery{ItemID: item.ID})
	if err != nil {
		t.Fatalf("Changes() error = %v", err)
	}
	if len(result.Changes) != 1 || result.Changes[0].Kind != ChangeKindMilestoneChanged || len(result.Changes[0].ChangedFields) != 1 || result.Changes[0].ChangedFields[0].Field != "milestone" {
		t.Fatalf("milestone history = %+v", result.Changes)
	}
}

func TestFileStoreHistoricalSnapshotAndFlow(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenFileStore(directory)
	if err != nil {
		t.Fatalf("OpenFileStore() error = %v", err)
	}
	firstObserved := time.Date(2026, time.March, 1, 9, 0, 0, 0, time.UTC)
	secondObserved := firstObserved.Add(24 * time.Hour)
	thirdObserved := secondObserved.Add(24 * time.Hour)
	itemA := domain.WorkItem{ID: "team/project#12", ProjectID: 42, ProjectPath: "team/project", Title: "Flow item", State: domain.IssueOpen, Assignee: "alex", LastActivity: firstObserved}
	itemB := domain.WorkItem{ID: "team/project#13", ProjectID: 42, ProjectPath: "team/project", Title: "Second item", State: domain.IssueOpen, LastActivity: secondObserved}
	first := domain.Snapshot{GeneratedAt: firstObserved, Sprint: domain.Sprint{Name: "Flow 01", Goal: "Ship safely", WorkItems: []domain.WorkItem{itemA}}}
	itemA.Blocked = true
	secondBlocked := domain.Snapshot{GeneratedAt: secondObserved, Sprint: domain.Sprint{Name: "Flow 01", Goal: "Ship safely", WorkItems: []domain.WorkItem{itemA, itemB}}}
	if err := store.PutObserved(first, "run-1", firstObserved); err != nil {
		t.Fatalf("first PutObserved() error = %v", err)
	}
	if err := store.PutObserved(secondBlocked, "run-2", secondObserved); err != nil {
		t.Fatalf("second PutObserved() error = %v", err)
	}
	itemA.State = domain.IssueClosed
	itemB.Assignee = "sam"
	third := domain.Snapshot{GeneratedAt: thirdObserved, Sprint: domain.Sprint{Name: "Flow 01", Goal: "Ship safely", WorkItems: []domain.WorkItem{itemA, itemB}}}
	if err := store.PutObserved(third, "run-3", thirdObserved); err != nil {
		t.Fatalf("third PutObserved() error = %v", err)
	}

	historical, err := store.SnapshotAt(secondObserved.Add(time.Hour))
	if err != nil {
		t.Fatalf("SnapshotAt() error = %v", err)
	}
	if !historical.ObservedAt.Equal(secondObserved) || historical.SyncRunID != "run-2" || historical.Snapshot.Sprint.Name != "Flow 01" || len(historical.Snapshot.Sprint.WorkItems) != 2 || historical.Snapshot.Sprint.WorkItems[0].ID != itemA.ID || historical.Snapshot.Sprint.WorkItems[0].Blocked != true || len(historical.Uncertainties) == 0 {
		// Coverage uncertainty is expected because this test uses direct puts,
		// but the reconstructed entity set must still be complete.
		t.Fatalf("historical snapshot = %+v", historical)
	}
	if len(historical.Snapshot.Sprint.WorkItems) != 2 || historical.Snapshot.Sprint.WorkItems[1].ID != itemB.ID {
		t.Fatalf("historical items = %+v", historical.Snapshot.Sprint.WorkItems)
	}

	flow, err := store.Flow(FlowQuery{From: firstObserved, Until: thirdObserved.Add(time.Hour)})
	if err != nil {
		t.Fatalf("Flow() error = %v", err)
	}
	if flow.Changes != 4 || flow.Added != 1 || flow.Started != 2 || flow.Completed != 1 || flow.Blocked != 1 || flow.StatusTransitions != 3 || len(flow.Buckets) != 2 {
		t.Fatalf("flow = %+v", flow)
	}
}

func TestFileStoreRetentionKeepsCheckpointState(t *testing.T) {
	directory := t.TempDir()
	retention := time.Hour
	store, err := OpenFileStoreWithOptions(directory, FileStoreOptions{StaleAfter: 24 * time.Hour, HistoryRetention: retention})
	if err != nil {
		t.Fatalf("OpenFileStoreWithOptions() error = %v", err)
	}
	now := time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC)
	old := now.Add(-2 * time.Hour)
	item := domain.WorkItem{ID: "team/project#12", ProjectID: 42, Title: "Retained item", State: domain.IssueOpen, Assignee: "alex", LastActivity: old}
	if err := store.PutObserved(domain.Snapshot{GeneratedAt: old, Sprint: domain.Sprint{Name: "Flow 01", WorkItems: []domain.WorkItem{item}}}, "run-old", old); err != nil {
		t.Fatalf("old PutObserved() error = %v", err)
	}
	if err := store.PutObserved(domain.Snapshot{GeneratedAt: now, Sprint: domain.Sprint{Name: "Flow 01", WorkItems: []domain.WorkItem{item}}}, "run-new", now); err != nil {
		t.Fatalf("new PutObserved() error = %v", err)
	}
	result, err := store.Changes(ChangeQuery{ItemID: item.ID})
	if err != nil {
		t.Fatalf("Changes() error = %v", err)
	}
	if len(result.Changes) != 0 || result.Coverage.Retention != retention.String() || result.Coverage.RetainedFrom == nil || !result.Coverage.RetainedFrom.Equal(now.Add(-retention)) {
		t.Fatalf("retained history = %+v", result)
	}
	historical, err := store.SnapshotAt(now)
	if err != nil {
		t.Fatalf("SnapshotAt() after retention error = %v", err)
	}
	if len(historical.Snapshot.Sprint.WorkItems) != 1 || historical.Snapshot.Sprint.WorkItems[0].ID != item.ID {
		t.Fatalf("checkpoint snapshot = %+v", historical)
	}
}

func TestFileStorePersistsSyncRuns(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenFileStore(directory)
	if err != nil {
		t.Fatalf("OpenFileStore() error = %v", err)
	}
	watermark := time.Date(2026, time.May, 1, 12, 0, 0, 0, time.UTC)
	completed := watermark.Add(time.Minute)
	run := domain.SyncRun{
		ID:                  "run-1",
		Target:              "tokyo3",
		Mode:                "full",
		FullScan:            true,
		Status:              "success",
		StartedAt:           watermark,
		CompletedAt:         completed,
		ObservedAt:          timePointer(watermark),
		SnapshotGeneratedAt: timePointer(watermark),
		SourceWatermark:     timePointer(watermark),
		ItemCount:           3,
		Coverage:            "complete_current_milestone",
	}
	if err := store.RecordSyncRun(run); err != nil {
		t.Fatalf("RecordSyncRun() error = %v", err)
	}
	reopened, err := OpenFileStore(directory)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	if !reopened.SourceWatermark().Equal(watermark) || !reopened.LastFullSyncAt().Equal(completed) {
		t.Fatalf("reopened watermark = %s, full sync = %s", reopened.SourceWatermark(), reopened.LastFullSyncAt())
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
