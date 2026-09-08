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
)

// FileStore is a small, single-process durable store for the first Flux
// deployment. Snapshot replacement is atomic; webhook and mutation metadata are
// appended as JSON Lines. It is intentionally replaceable by a database-backed
// Store later.
type FileStore struct {
	mu        sync.RWMutex
	directory string
	snapshot  domain.Snapshot
	populated bool
}

// OpenFileStore creates or opens a store rooted at directory. An existing
// snapshot is loaded into memory so the status API can serve cached data while
// GitLab is temporarily unavailable.
func OpenFileStore(directory string) (*FileStore, error) {
	directory = strings.TrimSpace(directory)
	if directory == "" {
		return nil, errors.New("state directory is required")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create state directory: %w", err)
	}

	store := &FileStore{directory: directory}
	data, err := os.ReadFile(store.snapshotPath())
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read snapshot: %w", err)
	}
	if err := json.Unmarshal(data, &store.snapshot); err != nil {
		return nil, fmt.Errorf("decode snapshot: %w", err)
	}
	store.snapshot = cloneSnapshot(store.snapshot)
	store.populated = true
	return store, nil
}

// Put atomically replaces the durable and in-memory snapshot.
func (s *FileStore) Put(snapshot domain.Snapshot) error {
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return fmt.Errorf("encode snapshot: %w", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := writeAtomic(s.snapshotPath(), data, 0o600); err != nil {
		return fmt.Errorf("write snapshot: %w", err)
	}
	s.snapshot = cloneSnapshot(snapshot)
	s.populated = true
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

func (s *FileStore) appendJSONLine(path string, value any, kind string) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode %s: %w", kind, err)
	}
	data = append(data, '\n')

	s.mu.Lock()
	defer s.mu.Unlock()
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

func (s *FileStore) snapshotPath() string {
	return filepath.Join(s.directory, snapshotFilename)
}

func (s *FileStore) eventsPath() string {
	return filepath.Join(s.directory, eventsFilename)
}

func (s *FileStore) auditPath() string {
	return filepath.Join(s.directory, auditFilename)
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
