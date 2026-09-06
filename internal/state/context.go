package state

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"sort"
	"strings"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
)

const (
	// DefaultContextLimit bounds a human-context response when a caller does
	// not request a specific limit.
	DefaultContextLimit = 50
	// MaxContextLimit prevents free-text context from making API or Pi
	// responses unbounded.
	MaxContextLimit = 200
)

var (
	ErrContextNotFound = errors.New("human context entry not found")
	ErrContextConflict = errors.New("human context revision conflict")
)

// ContextQuery selects confirmed human context records. Since is inclusive
// and Until is exclusive; both bounds select records whose reporting window
// overlaps the query window.
type ContextQuery struct {
	Since  time.Time
	Until  time.Time
	ItemID string
	Kind   string
	// Milestone filters explicitly scoped entries; entries without a
	// milestone remain eligible as broader-scope context.
	Milestone string
	Limit     int
}

// ContextCoverage describes the boundary and provenance of human-provided
// context. It is deliberately separate from GitLab history coverage.
type ContextCoverage struct {
	ContextStartedAt *time.Time `json:"context_started_at,omitempty"`
	RetainedFrom     *time.Time `json:"retained_from,omitempty"`
	LastUpdatedAt    *time.Time `json:"last_updated_at,omitempty"`
	Records          int        `json:"records"`
	Revisions        int        `json:"revisions"`
	Retention        string     `json:"retention,omitempty"`
	Scope            string     `json:"scope,omitempty"`
	Provenance       string     `json:"provenance,omitempty"`
	Uncertainties    []string   `json:"uncertainties,omitempty"`
}

// ContextAuditEvent records the secret-free approval and redaction trail for
// human context. It intentionally contains no free-text context payload.
type ContextAuditEvent struct {
	ID           string    `json:"id"`
	RecordedAt   time.Time `json:"recorded_at"`
	Action       string    `json:"action"`
	ContextID    string    `json:"context_id"`
	Revision     int       `json:"revision"`
	ActorSubject string    `json:"actor_subject,omitempty"`
	Outcome      string    `json:"outcome"`
	ContentHash  string    `json:"content_hash,omitempty"`
	OriginalHash string    `json:"original_hash,omitempty"`
}

// ContextResult is the bounded read model for confirmed human context.
type ContextResult struct {
	Entries  []domain.HumanContext `json:"entries"`
	Coverage ContextCoverage       `json:"coverage"`
}

// ContextHistoryResult returns all retained revisions for one context ID.
type ContextHistoryResult struct {
	ID            string                `json:"id"`
	Revisions     []domain.HumanContext `json:"revisions"`
	Audits        []ContextAuditEvent   `json:"audits,omitempty"`
	Coverage      ContextCoverage       `json:"coverage"`
	Truncated     bool                  `json:"truncated"`
	Uncertainties []string              `json:"uncertainties,omitempty"`
}

// ContextReader supplies confirmed human context to read-only API clients.
type ContextReader interface {
	ListContext(ContextQuery) (ContextResult, error)
	ContextHistory(string) (ContextHistoryResult, error)
}

// ContextStore appends a confirmed human context record and serves it to
// read-only clients.
type ContextStore interface {
	ContextReader
	RecordContext(domain.HumanContext) error
}

// ContextRedactor appends a redaction revision and scrubs retained free text
// for the target context ID.
type ContextRedactor interface {
	RedactContext(domain.HumanContext) error
}

// cloneHumanContext prevents callers from mutating slices or optional times
// held by the store.
func cloneHumanContext(entry domain.HumanContext) domain.HumanContext {
	copyOf := entry
	copyOf.ItemIDs = append([]string(nil), entry.ItemIDs...)
	copyOf.SourceURLs = append([]string(nil), entry.SourceURLs...)
	copyOf.ReportingFrom = cloneTimePointer(entry.ReportingFrom)
	copyOf.ReportingUntil = cloneTimePointer(entry.ReportingUntil)
	copyOf.EffectiveAt = cloneTimePointer(entry.EffectiveAt)
	return copyOf
}

func cloneTimePointer(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copyOf := value.UTC()
	return &copyOf
}

func (s *FileStore) loadContext() error {
	file, err := os.Open(s.contextPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()

	s.contextEntries = make(map[string][]domain.HumanContext)
	s.contextStartedAt = time.Time{}
	s.lastContextAt = time.Time{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	for line := 1; scanner.Scan(); line++ {
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}
		var entry domain.HumanContext
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			return fmt.Errorf("decode context line %d: %w", line, err)
		}
		s.applyContextLocked(entry)
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read context: %w", err)
	}
	return nil
}

func (s *FileStore) loadContextAudits() error {
	file, err := os.Open(s.contextAuditPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()

	if s.contextAudits == nil {
		s.contextAudits = make(map[string][]ContextAuditEvent)
	}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 16<<10), 256<<10)
	for line := 1; scanner.Scan(); line++ {
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}
		var event ContextAuditEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			return fmt.Errorf("decode context audit line %d: %w", line, err)
		}
		if strings.TrimSpace(event.ContextID) == "" {
			continue
		}
		s.contextAudits[event.ContextID] = append(s.contextAudits[event.ContextID], event)
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read context audit: %w", err)
	}
	for id := range s.contextAudits {
		sort.SliceStable(s.contextAudits[id], func(i, j int) bool {
			return s.contextAudits[id][i].RecordedAt.Before(s.contextAudits[id][j].RecordedAt)
		})
	}
	return nil
}

func (s *FileStore) applyContextLocked(entry domain.HumanContext) {
	id := strings.TrimSpace(entry.ID)
	if id == "" {
		return
	}
	entry = cloneHumanContext(entry)
	entries := s.contextEntries[id]
	for _, existing := range entries {
		if existing.Revision == entry.Revision {
			return
		}
	}
	entries = append(entries, entry)
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Revision != entries[j].Revision {
			return entries[i].Revision < entries[j].Revision
		}
		return entries[i].UpdatedAt.Before(entries[j].UpdatedAt)
	})
	s.contextEntries[id] = entries
	if !entry.CreatedAt.IsZero() && (s.contextStartedAt.IsZero() || entry.CreatedAt.Before(s.contextStartedAt)) {
		s.contextStartedAt = entry.CreatedAt.UTC()
	}
	if entry.UpdatedAt.After(s.lastContextAt) {
		s.lastContextAt = entry.UpdatedAt.UTC()
	}
}

// RecordContext appends one confirmed context revision. Service-level
// validation is stricter, but the store rejects malformed direct callers too.
func (s *FileStore) RecordContext(entry domain.HumanContext) error {
	if strings.TrimSpace(entry.ID) == "" {
		return errors.New("context ID is required")
	}
	if entry.Revision < 1 {
		return errors.New("context revision must be positive")
	}
	if strings.TrimSpace(string(entry.Kind)) == "" {
		return errors.New("context kind is required")
	}
	if entry.Status != domain.ContextStatusConfirmed {
		return errors.New("context status must be confirmed")
	}
	if entry.CreatedAt.IsZero() || entry.UpdatedAt.IsZero() {
		return errors.New("context timestamps are required")
	}
	if strings.TrimSpace(entry.Statement) == "" {
		return errors.New("context statement is required")
	}
	data, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("encode context: %w", err)
	}
	data = append(data, '\n')
	action := "record"
	if entry.Revision > 1 {
		action = "correction"
	}
	audit := newContextAudit(entry, action, string(entry.Status), "")

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.contextEntries == nil {
		s.contextEntries = make(map[string][]domain.HumanContext)
	}
	if revisions := s.contextEntries[entry.ID]; len(revisions) > 0 {
		latest := revisions[len(revisions)-1]
		if latest.Status == domain.ContextStatusRedacted || entry.Revision != latest.Revision+1 {
			return ErrContextConflict
		}
		audit.OriginalHash = latest.ContentHash
	} else if entry.Revision != 1 {
		return ErrContextConflict
	}
	if s.contextAudits == nil {
		s.contextAudits = make(map[string][]ContextAuditEvent)
	}
	if err := appendBytesLocked(s.contextPath(), data, "context"); err != nil {
		return err
	}
	s.applyContextLocked(entry)
	if err := appendContextAuditLocked(s.contextAuditPath(), s.contextAudits, audit); err != nil {
		return err
	}
	if s.contextRetention > 0 {
		if err := s.pruneContextLocked(entry.UpdatedAt); err != nil {
			return fmt.Errorf("prune context: %w", err)
		}
	}
	return nil
}

func newContextAudit(entry domain.HumanContext, action, outcome, originalHash string) ContextAuditEvent {
	return ContextAuditEvent{
		ID:           fmt.Sprintf("%s:%d:%d", entry.ID, entry.Revision, entry.UpdatedAt.UnixNano()),
		RecordedAt:   entry.UpdatedAt.UTC(),
		Action:       action,
		ContextID:    entry.ID,
		Revision:     entry.Revision,
		ActorSubject: entry.AuthorSubject,
		Outcome:      outcome,
		ContentHash:  entry.ContentHash,
		OriginalHash: originalHash,
	}
}

func appendContextAuditLocked(path string, audits map[string][]ContextAuditEvent, event ContextAuditEvent) error {
	for _, existing := range audits[event.ContextID] {
		if existing.ID == event.ID {
			return nil
		}
	}
	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("encode context audit: %w", err)
	}
	data = append(data, '\n')
	if err := appendBytesLocked(path, data, "context audit"); err != nil {
		return err
	}
	audits[event.ContextID] = append(audits[event.ContextID], event)
	return nil
}

// RedactContext appends a redacted revision and rewrites retained records for
// the target ID so free-text fields are no longer present on disk. The audit
// event retains only operation metadata and a one-way original content hash.
func (s *FileStore) RedactContext(entry domain.HumanContext) error {
	if strings.TrimSpace(entry.ID) == "" {
		return errors.New("context ID is required")
	}
	if entry.Revision < 1 || entry.Status != domain.ContextStatusRedacted {
		return errors.New("redacted context revision is invalid")
	}
	if entry.CreatedAt.IsZero() || entry.UpdatedAt.IsZero() {
		return errors.New("redacted context timestamps are required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	revisions, ok := s.contextEntries[entry.ID]
	if !ok || len(revisions) == 0 {
		return ErrContextNotFound
	}
	latest := revisions[len(revisions)-1]
	if latest.Status == domain.ContextStatusRedacted {
		return errors.New("context entry is already redacted")
	}
	if entry.Revision != latest.Revision+1 {
		return errors.New("redacted context revision is not the next revision")
	}

	all := make([]domain.HumanContext, 0)
	for id, values := range s.contextEntries {
		for _, value := range values {
			if id == entry.ID {
				value = scrubContext(value)
			}
			all = append(all, value)
		}
	}
	actorSubject := entry.AuthorSubject
	redacted := scrubContext(entry)
	redacted.Statement = "[redacted]"
	redacted.Status = domain.ContextStatusRedacted
	redacted.Revision = entry.Revision
	all = append(all, redacted)
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].UpdatedAt.Equal(all[j].UpdatedAt) {
			if all[i].ID == all[j].ID {
				return all[i].Revision < all[j].Revision
			}
			return all[i].ID < all[j].ID
		}
		return all[i].UpdatedAt.Before(all[j].UpdatedAt)
	})
	data := make([]byte, 0, len(all)*256)
	for _, value := range all {
		encoded, err := json.Marshal(value)
		if err != nil {
			return fmt.Errorf("encode redacted context: %w", err)
		}
		data = append(data, encoded...)
		data = append(data, '\n')
	}
	if err := writeAtomic(s.contextPath(), data, 0o600); err != nil {
		return err
	}
	s.contextEntries = make(map[string][]domain.HumanContext)
	s.contextStartedAt = time.Time{}
	s.lastContextAt = time.Time{}
	for _, value := range all {
		s.applyContextLocked(value)
	}
	if s.contextAudits == nil {
		s.contextAudits = make(map[string][]ContextAuditEvent)
	}
	audit := newContextAudit(redacted, "redact", "redacted", latest.ContentHash)
	audit.ActorSubject = actorSubject
	if err := appendContextAuditLocked(s.contextAuditPath(), s.contextAudits, audit); err != nil {
		// The scrubbed context is already durable; keep the in-memory view
		// scrubbed rather than allowing sensitive text to reappear until restart.
		return err
	}
	if s.contextRetention > 0 {
		if err := s.pruneContextLocked(entry.UpdatedAt); err != nil {
			return fmt.Errorf("prune context after redaction: %w", err)
		}
	}
	return nil
}

func scrubContext(entry domain.HumanContext) domain.HumanContext {
	entry.Statement = "[redacted]"
	entry.Milestone = ""
	entry.DecisionOwner = ""
	entry.SourceURLs = nil
	entry.AuthorSubject = ""
	entry.ContentHash = ""
	return entry
}

// ListContext returns the latest retained revision for each confirmed context
// entry, newest first.
func (s *FileStore) ListContext(query ContextQuery) (ContextResult, error) {
	if query.Limit < 0 {
		return ContextResult{}, errors.New("context limit must not be negative")
	}
	limit := query.Limit
	if limit == 0 {
		limit = DefaultContextLimit
	}
	if limit > MaxContextLimit {
		limit = MaxContextLimit
	}
	query.ItemID = strings.TrimSpace(query.ItemID)
	query.Kind = strings.TrimSpace(query.Kind)
	query.Milestone = strings.TrimSpace(query.Milestone)

	s.mu.RLock()
	defer s.mu.RUnlock()
	result := ContextResult{Entries: make([]domain.HumanContext, 0), Coverage: s.contextCoverageLocked()}
	for _, revisions := range s.contextEntries {
		if len(revisions) == 0 {
			continue
		}
		entry := revisions[len(revisions)-1]
		if entry.Status != domain.ContextStatusConfirmed || !contextMatches(entry, query) {
			continue
		}
		result.Entries = append(result.Entries, cloneHumanContext(entry))
	}
	sort.SliceStable(result.Entries, func(i, j int) bool {
		if result.Entries[i].UpdatedAt.Equal(result.Entries[j].UpdatedAt) {
			return result.Entries[i].ID > result.Entries[j].ID
		}
		return result.Entries[i].UpdatedAt.After(result.Entries[j].UpdatedAt)
	})
	if limit > 0 && len(result.Entries) > limit {
		result.Entries = result.Entries[:limit]
	}
	return result, nil
}

func contextMatches(entry domain.HumanContext, query ContextQuery) bool {
	if !query.Since.IsZero() && entry.ReportingUntil != nil && !entry.ReportingUntil.After(query.Since) {
		return false
	}
	if !query.Until.IsZero() && entry.ReportingFrom != nil && !entry.ReportingFrom.Before(query.Until) {
		return false
	}
	if query.ItemID != "" && !slices.Contains(entry.ItemIDs, query.ItemID) {
		return false
	}
	if query.Milestone != "" && entry.Milestone != "" && strings.TrimSpace(entry.Milestone) != query.Milestone {
		return false
	}
	return query.Kind == "" || string(entry.Kind) == query.Kind
}

// ContextHistory returns retained revisions for one context ID in ascending
// revision order.
func (s *FileStore) ContextHistory(id string) (ContextHistoryResult, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return ContextHistoryResult{}, ErrContextNotFound
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	revisions, ok := s.contextEntries[id]
	if !ok || len(revisions) == 0 {
		return ContextHistoryResult{}, ErrContextNotFound
	}
	result := ContextHistoryResult{
		ID:        id,
		Revisions: make([]domain.HumanContext, 0, len(revisions)),
		Audits:    make([]ContextAuditEvent, 0, len(s.contextAudits[id])),
		Coverage:  s.contextCoverageLocked(),
	}
	for _, entry := range revisions {
		result.Revisions = append(result.Revisions, cloneHumanContext(entry))
	}
	result.Audits = append(result.Audits, s.contextAudits[id]...)
	sort.SliceStable(result.Audits, func(i, j int) bool {
		if result.Audits[i].RecordedAt.Equal(result.Audits[j].RecordedAt) {
			return result.Audits[i].ID < result.Audits[j].ID
		}
		return result.Audits[i].RecordedAt.Before(result.Audits[j].RecordedAt)
	})
	if len(result.Revisions) > MaxContextLimit {
		result.Truncated = true
		result.Revisions = result.Revisions[len(result.Revisions)-MaxContextLimit:]
		result.Uncertainties = append(result.Uncertainties, fmt.Sprintf("context history was capped at the %d most recent revisions", MaxContextLimit))
	}
	if len(result.Audits) > MaxContextLimit {
		result.Truncated = true
		result.Audits = result.Audits[len(result.Audits)-MaxContextLimit:]
		result.Uncertainties = append(result.Uncertainties, fmt.Sprintf("context audit history was capped at the %d most recent events", MaxContextLimit))
	}
	return result, nil
}

func (s *FileStore) contextCoverageLocked() ContextCoverage {
	coverage := ContextCoverage{
		Scope:      "human_reported",
		Provenance: "browser_confirmed_human_input",
		Records:    0,
	}
	if !s.contextStartedAt.IsZero() {
		value := s.contextStartedAt
		coverage.ContextStartedAt = &value
	}
	var retainedFrom time.Time
	for _, revisions := range s.contextEntries {
		for _, entry := range revisions {
			if !entry.UpdatedAt.IsZero() && (retainedFrom.IsZero() || entry.UpdatedAt.Before(retainedFrom)) {
				retainedFrom = entry.UpdatedAt.UTC()
			}
		}
	}
	if !retainedFrom.IsZero() {
		coverage.RetainedFrom = &retainedFrom
	}
	if !s.lastContextAt.IsZero() {
		value := s.lastContextAt
		coverage.LastUpdatedAt = &value
	}
	for _, revisions := range s.contextEntries {
		coverage.Revisions += len(revisions)
		if len(revisions) > 0 && revisions[len(revisions)-1].Status == domain.ContextStatusConfirmed {
			coverage.Records++
		}
	}
	coverage.Retention = "unbounded"
	if s.contextRetention > 0 {
		coverage.Retention = s.contextRetention.String()
	}
	if coverage.Revisions > 0 {
		coverage.Uncertainties = []string{
			"context is human-reported and is not GitLab evidence",
			"context is an overlay and does not change derived status or counts",
		}
		if s.contextRetention > 0 {
			coverage.Uncertainties = append(coverage.Uncertainties, "context older than the configured retention window is unavailable")
		}
	}
	return coverage
}

func (s *FileStore) pruneContextLocked(now time.Time) error {
	if s.contextRetention <= 0 {
		return nil
	}
	cutoff := now.UTC().Add(-s.contextRetention)
	if len(s.contextEntries) == 0 {
		return s.pruneContextAuditsLocked(cutoff)
	}
	kept := make([]domain.HumanContext, 0)
	for _, revisions := range s.contextEntries {
		for _, entry := range revisions {
			if entry.UpdatedAt.IsZero() || !entry.UpdatedAt.Before(cutoff) {
				kept = append(kept, entry)
			}
		}
	}
	all := 0
	for _, revisions := range s.contextEntries {
		all += len(revisions)
	}
	if len(kept) == all {
		return nil
	}
	sort.SliceStable(kept, func(i, j int) bool {
		if kept[i].UpdatedAt.Equal(kept[j].UpdatedAt) {
			return kept[i].ID < kept[j].ID
		}
		return kept[i].UpdatedAt.Before(kept[j].UpdatedAt)
	})
	data := make([]byte, 0, len(kept)*256)
	for _, entry := range kept {
		encoded, err := json.Marshal(entry)
		if err != nil {
			return fmt.Errorf("encode context: %w", err)
		}
		data = append(data, encoded...)
		data = append(data, '\n')
	}
	if err := writeAtomic(s.contextPath(), data, 0o600); err != nil {
		return err
	}
	s.contextEntries = make(map[string][]domain.HumanContext)
	s.contextStartedAt = time.Time{}
	s.lastContextAt = time.Time{}
	for _, entry := range kept {
		s.applyContextLocked(entry)
	}
	return s.pruneContextAuditsLocked(cutoff)
}

func (s *FileStore) pruneContextAuditsLocked(cutoff time.Time) error {
	if len(s.contextAudits) == 0 {
		return nil
	}
	kept := make([]ContextAuditEvent, 0)
	all := 0
	for _, events := range s.contextAudits {
		all += len(events)
		for _, event := range events {
			if event.RecordedAt.IsZero() || !event.RecordedAt.Before(cutoff) {
				kept = append(kept, event)
			}
		}
	}
	if len(kept) == all {
		return nil
	}
	sort.SliceStable(kept, func(i, j int) bool {
		return kept[i].RecordedAt.Before(kept[j].RecordedAt)
	})
	data := make([]byte, 0, len(kept)*160)
	for _, event := range kept {
		encoded, err := json.Marshal(event)
		if err != nil {
			return fmt.Errorf("encode context audit: %w", err)
		}
		data = append(data, encoded...)
		data = append(data, '\n')
	}
	if err := writeAtomic(s.contextAuditPath(), data, 0o600); err != nil {
		return err
	}
	s.contextAudits = make(map[string][]ContextAuditEvent)
	for _, event := range kept {
		s.contextAudits[event.ContextID] = append(s.contextAudits[event.ContextID], event)
	}
	return nil
}
