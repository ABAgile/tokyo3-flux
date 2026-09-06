package state

import (
	"sync"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
)

// Reader holds the latest authoritative snapshot used by the status API.
type Reader interface {
	Get() (domain.Snapshot, bool)
}

// Store receives successful snapshots from reconciliation.
type Store interface {
	Put(domain.Snapshot) error
}

// EventRecorder persists webhook metadata without retaining untrusted webhook
// payloads.
type EventRecorder interface {
	RecordEvent(Event) error
}

// AuditRecorder persists metadata for Flux-approved GitLab mutations.
type AuditRecorder interface {
	RecordAudit(AuditEvent) error
}

// Event is the durable metadata recorded for an accepted webhook.
type Event struct {
	Kind        string    `json:"kind"`
	DeliveryID  string    `json:"delivery_id,omitempty"`
	ProjectID   int       `json:"project_id,omitempty"`
	ProjectPath string    `json:"project_path,omitempty"`
	GroupID     int       `json:"group_id,omitempty"`
	GroupPath   string    `json:"group_path,omitempty"`
	ReceivedAt  time.Time `json:"received_at"`
}

// AuditEvent is the durable, secret-free record of an approved action attempt.
type AuditEvent struct {
	ID           string    `json:"id"`
	RecordedAt   time.Time `json:"recorded_at"`
	Action       string    `json:"action"`
	PlanID       string    `json:"plan_id"`
	ActorSubject string    `json:"actor_subject"`
	ActorName    string    `json:"actor_name,omitempty"`
	ItemID       string    `json:"item_id"`
	ProjectPath  string    `json:"project_path"`
	ProjectID    int       `json:"project_id"`
	IssueIID     int       `json:"issue_iid"`
	Label        string    `json:"label"`
	Outcome      string    `json:"outcome"`
	Error        string    `json:"error,omitempty"`
}

// MemoryStore is the first read model for Flux. Reconciliation can rebuild it
// after a restart; a durable store can implement Store without changing the
// GitLab or HTTP layers.
type MemoryStore struct {
	mu        sync.RWMutex
	snapshot  domain.Snapshot
	populated bool
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{}
}

// Put replaces the current snapshot atomically.
func (s *MemoryStore) Put(snapshot domain.Snapshot) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshot = cloneSnapshot(snapshot)
	s.populated = true
	return nil
}

// RecordEvent satisfies EventRecorder for tests and local, non-durable use.
func (s *MemoryStore) RecordEvent(Event) error {
	return nil
}

// RecordAudit satisfies AuditRecorder for tests and local, non-durable use.
func (s *MemoryStore) RecordAudit(AuditEvent) error {
	return nil
}

// Get returns a copy of the current snapshot and whether reconciliation has
// populated the store at least once.
func (s *MemoryStore) Get() (domain.Snapshot, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.populated {
		return domain.Snapshot{}, false
	}
	return cloneSnapshot(s.snapshot), true
}

func cloneSnapshot(snapshot domain.Snapshot) domain.Snapshot {
	copyOf := snapshot
	copyOf.Sprint.WorkItems = make([]domain.WorkItem, len(snapshot.Sprint.WorkItems))
	for i, item := range snapshot.Sprint.WorkItems {
		copyOf.Sprint.WorkItems[i] = item
		copyOf.Sprint.WorkItems[i].Labels = append([]string(nil), item.Labels...)
		copyOf.Sprint.WorkItems[i].MergeRequests = append([]domain.MergeRequest(nil), item.MergeRequests...)
	}
	return copyOf
}
