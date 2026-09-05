package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"abagile.com/tokyo3/flux/internal/domain"
)

const (
	snapshotFilename = "snapshot.json"
	eventsFilename   = "events.jsonl"
)

// FileStore is a small, single-process durable store for the first Flux
// deployment. Snapshot replacement is atomic; webhook metadata is appended as
// JSON Lines. It is intentionally replaceable by a database-backed Store later.
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
	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("encode event: %w", err)
	}
	data = append(data, '\n')

	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := os.OpenFile(s.eventsPath(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open event log: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return fmt.Errorf("write event: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return fmt.Errorf("sync event log: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close event log: %w", err)
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

func (s *FileStore) snapshotPath() string {
	return filepath.Join(s.directory, snapshotFilename)
}

func (s *FileStore) eventsPath() string {
	return filepath.Join(s.directory, eventsFilename)
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
