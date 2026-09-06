package state

import (
	"os"
	"strings"
	"testing"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
)

func TestFileStoreContextRoundTripAndFilters(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenFileStore(directory)
	if err != nil {
		t.Fatalf("OpenFileStore() error = %v", err)
	}
	first := contextTestEntry("ctx-1", 1, domain.ContextStatusConfirmed, time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC))
	second := contextTestEntry("ctx-2", 1, domain.ContextStatusConfirmed, time.Date(2026, time.February, 3, 12, 0, 0, 0, time.UTC))
	second.ItemIDs = []string{"team/project#22"}
	if err := store.RecordContext(first); err != nil {
		t.Fatalf("RecordContext(first) error = %v", err)
	}
	if err := store.RecordContext(second); err != nil {
		t.Fatalf("RecordContext(second) error = %v", err)
	}
	correction := contextTestEntry("ctx-1", 2, domain.ContextStatusConfirmed, first.UpdatedAt.Add(time.Hour))
	correction.SupersedesID = first.ID
	if err := store.RecordContext(correction); err != nil {
		t.Fatalf("RecordContext(correction) error = %v", err)
	}

	result, err := store.ListContext(ContextQuery{ItemID: "team/project#22", Limit: 10})
	if err != nil {
		t.Fatalf("ListContext() error = %v", err)
	}
	if len(result.Entries) != 1 || result.Entries[0].ID != second.ID {
		t.Fatalf("filtered context = %+v, want ctx-2", result.Entries)
	}
	if result.Coverage.Records != 2 || result.Coverage.Revisions != 3 {
		t.Fatalf("coverage = %+v, want two current records and three revisions", result.Coverage)
	}

	history, err := store.ContextHistory(first.ID)
	if err != nil {
		t.Fatalf("ContextHistory() error = %v", err)
	}
	if len(history.Revisions) != 2 || history.Revisions[1].Status != domain.ContextStatusConfirmed || len(history.Audits) != 2 || history.Audits[1].OriginalHash != "" {
		t.Fatalf("context history = %+v audits = %+v", history.Revisions, history.Audits)
	}

	reopened, err := OpenFileStore(directory)
	if err != nil {
		t.Fatalf("reopen FileStore() error = %v", err)
	}
	reopenedResult, err := reopened.ListContext(ContextQuery{Since: second.ReportingFrom.Add(-time.Hour), Until: second.ReportingUntil.Add(time.Hour), ItemID: "team/project#22", Limit: 10})
	if err != nil {
		t.Fatalf("reopened ListContext() error = %v", err)
	}
	if len(reopenedResult.Entries) != 1 || reopenedResult.Entries[0].ID != second.ID {
		t.Fatalf("reopened context = %+v", reopenedResult.Entries)
	}
	reopenedHistory, err := reopened.ContextHistory(first.ID)
	if err != nil {
		t.Fatalf("reopened ContextHistory() error = %v", err)
	}
	if len(reopenedHistory.Audits) != 2 {
		t.Fatalf("reopened context audits = %+v", reopenedHistory.Audits)
	}
}

func TestFileStoreContextRetentionPrunesContextAndAudit(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenFileStoreWithOptions(directory, FileStoreOptions{ContextRetention: time.Hour})
	if err != nil {
		t.Fatalf("OpenFileStoreWithOptions() error = %v", err)
	}
	old := time.Now().UTC().Add(-48 * time.Hour)
	entry := contextTestEntry("ctx-old", 1, domain.ContextStatusConfirmed, old)
	entry.Statement = "sensitive delivery note"
	if err := store.RecordContext(entry); err != nil {
		t.Fatalf("RecordContext() error = %v", err)
	}
	reopened, err := OpenFileStoreWithOptions(directory, FileStoreOptions{ContextRetention: time.Hour})
	if err != nil {
		t.Fatalf("reopen FileStore() error = %v", err)
	}
	if _, err := reopened.ContextHistory(entry.ID); err != ErrContextNotFound {
		t.Fatalf("pruned ContextHistory() error = %v, want ErrContextNotFound", err)
	}
	data, err := os.ReadFile(reopened.ContextPath())
	if err != nil {
		t.Fatalf("read context log: %v", err)
	}
	if strings.Contains(string(data), entry.Statement) {
		t.Fatalf("pruned context log still contains statement: %s", data)
	}
	data, err = os.ReadFile(reopened.ContextAuditPath())
	if err != nil {
		t.Fatalf("read context audit log: %v", err)
	}
	if len(strings.TrimSpace(string(data))) != 0 {
		t.Fatalf("pruned context audit log = %s, want empty", data)
	}
}

func TestFileStoreContextQueryWindowOverlap(t *testing.T) {
	store, err := OpenFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("OpenFileStore() error = %v", err)
	}
	entry := contextTestEntry("ctx-window", 1, domain.ContextStatusConfirmed, time.Date(2026, time.March, 2, 12, 0, 0, 0, time.UTC))
	if err := store.RecordContext(entry); err != nil {
		t.Fatalf("RecordContext() error = %v", err)
	}
	result, err := store.ListContext(ContextQuery{
		Since: time.Date(2026, time.March, 1, 0, 0, 0, 0, time.UTC),
		Until: time.Date(2026, time.March, 1, 12, 0, 0, 0, time.UTC),
		Limit: 10,
	})
	if err != nil {
		t.Fatalf("ListContext() error = %v", err)
	}
	if len(result.Entries) != 0 {
		t.Fatalf("context at exclusive boundary = %+v, want none", result.Entries)
	}
	result, err = store.ListContext(ContextQuery{
		Since: time.Date(2026, time.March, 1, 12, 0, 0, 0, time.UTC),
		Until: time.Date(2026, time.March, 3, 0, 0, 0, 0, time.UTC),
		Limit: 10,
	})
	if err != nil {
		t.Fatalf("overlapping ListContext() error = %v", err)
	}
	if len(result.Entries) != 1 {
		t.Fatalf("overlapping context = %+v, want one entry", result.Entries)
	}
}

func contextTestEntry(id string, revision int, status domain.ContextStatus, updatedAt time.Time) domain.HumanContext {
	from := updatedAt.Add(-24 * time.Hour)
	until := updatedAt.Add(24 * time.Hour)
	return domain.HumanContext{
		ID:             id,
		Revision:       revision,
		Kind:           domain.ContextKindDelayExplanation,
		Status:         status,
		Confidence:     domain.ContextConfidenceConfirmed,
		CreatedAt:      updatedAt,
		UpdatedAt:      updatedAt,
		AuthorSubject:  "user-1",
		Statement:      "A dependency was not available.",
		Category:       "dependency",
		ItemIDs:        []string{"team/project#12"},
		ReportingFrom:  &from,
		ReportingUntil: &until,
	}
}
