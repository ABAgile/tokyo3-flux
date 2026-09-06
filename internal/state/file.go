package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
)

const (
	snapshotFilename = "snapshot.json"
	eventsFilename   = "events.jsonl"
	auditFilename    = "audit.jsonl"
	historyFilename  = "history.jsonl"
	syncRunsFilename = "sync_runs.jsonl"
)

const defaultHistoryStaleAfter = 7 * 24 * time.Hour

// FileStoreOptions controls the durable file-backed read model.
type FileStoreOptions struct {
	StaleAfter       time.Duration
	HistoryRetention time.Duration
}

// FileStore is a small, single-process durable store for the first Flux
// deployment. Snapshot replacement is atomic; derived history, webhook, and
// mutation metadata are appended as JSON Lines. It is intentionally replaceable
// by a database-backed Store later.
type FileStore struct {
	mu               sync.RWMutex
	directory        string
	staleAfter       time.Duration
	snapshot         domain.Snapshot
	populated        bool
	latest           map[string]historyVersion
	historyStartedAt time.Time
	lastObservedAt   time.Time
	observationCount int
	historyRetention time.Duration
	syncRuns         []domain.SyncRun
	sourceWatermark  time.Time
	lastFullSyncAt   time.Time
}

// OpenFileStore creates or opens a store rooted at directory. An existing
// snapshot is loaded into memory so the status API can serve cached data while
// GitLab is temporarily unavailable.
func OpenFileStore(directory string) (*FileStore, error) {
	return OpenFileStoreWithOptions(directory, FileStoreOptions{StaleAfter: defaultHistoryStaleAfter})
}

// OpenFileStoreWithStaleAfter opens a durable store and uses staleAfter when
// recording derived status changes in historical work-item revisions.
func OpenFileStoreWithStaleAfter(directory string, staleAfter time.Duration) (*FileStore, error) {
	return OpenFileStoreWithOptions(directory, FileStoreOptions{StaleAfter: staleAfter})
}

// OpenFileStoreWithOptions opens a durable file-backed read model.
func OpenFileStoreWithOptions(directory string, options FileStoreOptions) (*FileStore, error) {
	directory = strings.TrimSpace(directory)
	if directory == "" {
		return nil, errors.New("state directory is required")
	}
	if options.HistoryRetention < 0 {
		return nil, errors.New("history retention must not be negative")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create state directory: %w", err)
	}

	store := &FileStore{
		directory:        directory,
		staleAfter:       options.StaleAfter,
		historyRetention: options.HistoryRetention,
		latest:           make(map[string]historyVersion),
	}
	data, err := os.ReadFile(store.snapshotPath())
	if err == nil {
		if err := json.Unmarshal(data, &store.snapshot); err != nil {
			return nil, fmt.Errorf("decode snapshot: %w", err)
		}
		store.snapshot = cloneSnapshot(store.snapshot)
		store.populated = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read snapshot: %w", err)
	}
	if err := store.loadSyncRuns(); err != nil {
		return nil, fmt.Errorf("read sync runs: %w", err)
	}
	if err := store.loadHistory(); err != nil {
		return nil, fmt.Errorf("read history: %w", err)
	}
	if store.historyRetention > 0 {
		now := time.Now().UTC()
		if err := store.pruneHistoryLocked(now); err != nil {
			return nil, fmt.Errorf("prune history: %w", err)
		}
		if err := store.pruneSyncRunsLocked(now); err != nil {
			return nil, fmt.Errorf("prune sync runs: %w", err)
		}
	}
	return store, nil
}

// Put atomically replaces the durable and in-memory snapshot, then records the
// derived historical observation.
func (s *FileStore) Put(snapshot domain.Snapshot) error {
	return s.PutObserved(snapshot, "", time.Now().UTC())
}

// PutObserved stores a snapshot with the reconciliation provenance attached to
// its history records.
func (s *FileStore) PutObserved(snapshot domain.Snapshot, syncRunID string, observedAt time.Time) error {
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return fmt.Errorf("encode snapshot: %w", err)
	}
	if observedAt.IsZero() {
		observedAt = time.Now().UTC()
	}
	observedAt = observedAt.UTC()

	s.mu.Lock()
	defer s.mu.Unlock()
	records, nextLatest := s.historyRecordsLocked(snapshot, observedAt, strings.TrimSpace(syncRunID))
	if err := writeAtomic(s.snapshotPath(), data, 0o600); err != nil {
		return fmt.Errorf("write snapshot: %w", err)
	}
	s.snapshot = cloneSnapshot(snapshot)
	s.populated = true
	if err := appendHistoryRecordsLocked(s.historyPath(), records); err != nil {
		return err
	}
	s.latest = nextLatest
	s.observationCount++
	if s.historyStartedAt.IsZero() {
		s.historyStartedAt = observedAt
	}
	s.lastObservedAt = observedAt
	if watermark := maxSourceUpdatedAt(snapshot); watermark.After(s.sourceWatermark) {
		s.sourceWatermark = watermark
	}
	if s.historyRetention > 0 {
		if err := s.pruneHistoryLocked(observedAt); err != nil {
			return fmt.Errorf("prune history: %w", err)
		}
	}
	return nil
}

// Get returns a copy of the latest snapshot and whether one has been stored.
func (s *FileStore) Get() (domain.Snapshot, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.populated {
		return domain.Snapshot{}, false
	}
	return cloneSnapshot(s.snapshot), true
}

// RecordEvent appends authenticated webhook metadata. The webhook payload is
// deliberately not stored because GitLab remains the authoritative source.
func (s *FileStore) RecordEvent(event Event) error {
	if strings.TrimSpace(event.Kind) == "" {
		return errors.New("event kind is required")
	}
	return s.appendJSONLine(s.eventsPath(), event, "event")
}

// RecordAudit appends secret-free metadata for a GitLab action attempt.
func (s *FileStore) RecordAudit(event AuditEvent) error {
	if strings.TrimSpace(event.Action) == "" {
		return errors.New("audit action is required")
	}
	if strings.TrimSpace(event.Outcome) == "" {
		return errors.New("audit outcome is required")
	}
	if event.RecordedAt.IsZero() {
		event.RecordedAt = time.Now().UTC()
	}
	return s.appendJSONLine(s.auditPath(), event, "audit")
}

// RecordSyncRun appends pull provenance and updates the in-memory coverage
// watermark only after the record is durable.
func (s *FileStore) RecordSyncRun(run domain.SyncRun) error {
	if strings.TrimSpace(run.ID) == "" {
		return errors.New("sync run ID is required")
	}
	if strings.TrimSpace(run.Status) == "" {
		return errors.New("sync run status is required")
	}
	data, err := json.Marshal(run)
	if err != nil {
		return fmt.Errorf("encode sync run: %w", err)
	}
	data = append(data, '\n')

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := appendBytesLocked(s.syncRunsPath(), data, "sync run"); err != nil {
		return err
	}
	s.syncRuns = append(s.syncRuns, run)
	if run.Status == "success" {
		if run.SourceWatermark != nil && run.SourceWatermark.After(s.sourceWatermark) {
			s.sourceWatermark = *run.SourceWatermark
		}
		if run.FullScan && run.CompletedAt.After(s.lastFullSyncAt) {
			s.lastFullSyncAt = run.CompletedAt
		}
	}
	if s.historyRetention > 0 {
		if err := s.pruneSyncRunsLocked(run.CompletedAt); err != nil {
			return fmt.Errorf("prune sync runs: %w", err)
		}
	}
	return nil
}

// SourceWatermark returns the greatest source-side activity timestamp observed
// in a successful snapshot.
func (s *FileStore) SourceWatermark() time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sourceWatermark
}

// LastFullSyncAt returns the completion time of the latest successful full
// reconciliation.
func (s *FileStore) LastFullSyncAt() time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lastFullSyncAt
}

func (s *FileStore) appendJSONLine(path string, value any, kind string) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode %s: %w", kind, err)
	}
	data = append(data, '\n')

	s.mu.Lock()
	defer s.mu.Unlock()
	return appendBytesLocked(path, data, kind)
}

func appendBytesLocked(path string, data []byte, kind string) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open %s log: %w", kind, err)
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return fmt.Errorf("write %s: %w", kind, err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return fmt.Errorf("sync %s: %w", kind, err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close %s: %w", kind, err)
	}
	return nil
}

// SnapshotPath returns the file used for the latest snapshot.
func (s *FileStore) SnapshotPath() string {
	return s.snapshotPath()
}

// EventsPath returns the append-only webhook event log path.
func (s *FileStore) EventsPath() string {
	return s.eventsPath()
}

// AuditPath returns the append-only mutation audit log path.
func (s *FileStore) AuditPath() string {
	return s.auditPath()
}

// HistoryPath returns the append-only derived change log path.
func (s *FileStore) HistoryPath() string {
	return s.historyPath()
}

// SyncRunsPath returns the append-only pull provenance log path.
func (s *FileStore) SyncRunsPath() string {
	return s.syncRunsPath()
}

func (s *FileStore) snapshotPath() string {
	return filepath.Join(s.directory, snapshotFilename)
}

func (s *FileStore) eventsPath() string {
	return filepath.Join(s.directory, eventsFilename)
}

func (s *FileStore) auditPath() string {
	return filepath.Join(s.directory, auditFilename)
}

func (s *FileStore) historyPath() string {
	return filepath.Join(s.directory, historyFilename)
}

func (s *FileStore) syncRunsPath() string {
	return filepath.Join(s.directory, syncRunsFilename)
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".flux-state-*")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer func() { _ = os.Remove(temporary) }()

	if err := file.Chmod(mode); err != nil {
		_ = file.Close()
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}
