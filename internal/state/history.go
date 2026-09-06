package state

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
)

const (
	historyRecordObservation = "observation"
	historyRecordCheckpoint  = "checkpoint"
	historyRecordChange      = "change"

	// DefaultHistoryLimit bounds a history response when a caller does not
	// request a specific limit.
	DefaultHistoryLimit = 200
	// MaxHistoryLimit prevents an unbounded history response from consuming
	// the API or Pi tool budget.
	MaxHistoryLimit = 1000
)

// ChangeKind identifies the reason a historical work-item record was emitted.
type ChangeKind string

const (
	ChangeKindBaseline         ChangeKind = "baseline"
	ChangeKindAdded            ChangeKind = "added"
	ChangeKindUpdated          ChangeKind = "updated"
	ChangeKindMilestoneChanged ChangeKind = "milestone_changed"
	ChangeKindRemoved          ChangeKind = "removed"
)

// FieldChange is one deterministic before/after field difference. Before and
// After intentionally remain JSON values so labels, merge requests, and
// timestamps retain their useful shape for agents.
type FieldChange struct {
	Field  string `json:"field"`
	Before any    `json:"before"`
	After  any    `json:"after"`
}

// Change is a derived historical record. It describes what Flux observed, not
// an assertion that GitLab emitted an event at exactly that time.
type Change struct {
	ID                  string           `json:"id"`
	Kind                ChangeKind       `json:"kind"`
	ObservedAt          time.Time        `json:"observed_at"`
	SnapshotGeneratedAt time.Time        `json:"snapshot_generated_at"`
	SourceUpdatedAt     *time.Time       `json:"source_updated_at,omitempty"`
	RevisionHash        string           `json:"revision_hash,omitempty"`
	SyncRunID           string           `json:"sync_run_id,omitempty"`
	Milestone           string           `json:"milestone,omitempty"`
	EntityKey           string           `json:"entity_key"`
	ItemID              string           `json:"item_id"`
	ProjectID           int              `json:"project_id,omitempty"`
	ProjectPath         string           `json:"project_path,omitempty"`
	ChangedFields       []FieldChange    `json:"changed_fields,omitempty"`
	Before              *domain.WorkItem `json:"before,omitempty"`
	After               *domain.WorkItem `json:"after,omitempty"`
}

// ChangeQuery selects historical records. Since is inclusive and Until is
// exclusive. An empty time bound is unbounded.
type ChangeQuery struct {
	Since           time.Time
	Until           time.Time
	ItemID          string
	Milestone       string
	Limit           int
	IncludeBaseline bool
}

// HistoryCoverage describes the completeness boundary of a historical result.
type HistoryCoverage struct {
	HistoryStartedAt     *time.Time `json:"history_started_at,omitempty"`
	RetainedFrom         *time.Time `json:"retained_from,omitempty"`
	LastObservedAt       *time.Time `json:"last_observed_at,omitempty"`
	Observations         int        `json:"observations"`
	SuccessfulRuns       int        `json:"successful_runs"`
	FailedRuns           int        `json:"failed_runs"`
	LastSyncRunID        string     `json:"last_sync_run_id,omitempty"`
	LastRunStatus        string     `json:"last_run_status,omitempty"`
	SourceWatermark      *time.Time `json:"source_watermark,omitempty"`
	Retention            string     `json:"retention,omitempty"`
	Scope                string     `json:"scope,omitempty"`
	CurrentScopeComplete bool       `json:"current_scope_complete"`
	Uncertainties        []string   `json:"uncertainties,omitempty"`
}

// ChangeResult contains changes plus enough coverage metadata for an agent to
// avoid presenting an incomplete history as complete. The top-level legacy
// fields remain for clients that consumed the first history API version.
type ChangeResult struct {
	HistoryStartedAt *time.Time      `json:"history_started_at,omitempty"`
	LastObservedAt   *time.Time      `json:"last_observed_at,omitempty"`
	Observations     int             `json:"observations"`
	Changes          []Change        `json:"changes"`
	Coverage         HistoryCoverage `json:"coverage"`
}

// HistoryReader supplies derived change history to read-only API clients.
type HistoryReader interface {
	Changes(ChangeQuery) (ChangeResult, error)
}

// SnapshotResult is a reconstructed normalized snapshot at an observation
// boundary. It carries uncertainty when old records predate entity coverage.
type SnapshotResult struct {
	AsOf            time.Time       `json:"as_of"`
	ObservedAt      time.Time       `json:"observed_at"`
	SyncRunID       string          `json:"sync_run_id,omitempty"`
	SourceWatermark *time.Time      `json:"source_watermark,omitempty"`
	Snapshot        domain.Snapshot `json:"snapshot"`
	Coverage        HistoryCoverage `json:"coverage"`
	Uncertainties   []string        `json:"uncertainties,omitempty"`
}

// SnapshotReader supplies point-in-time historical views.
type SnapshotReader interface {
	SnapshotAt(time.Time) (SnapshotResult, error)
}

// FlowQuery selects the observation window and optional scope for flow metrics.
type FlowQuery struct {
	From      time.Time
	Until     time.Time
	ItemID    string
	Milestone string
}

// FlowBucket groups observed transitions by UTC calendar day.
type FlowBucket struct {
	Date              string `json:"date"`
	Changes           int    `json:"changes"`
	Added             int    `json:"added"`
	Started           int    `json:"started"`
	Completed         int    `json:"completed"`
	Reopened          int    `json:"reopened"`
	Blocked           int    `json:"blocked"`
	Unblocked         int    `json:"unblocked"`
	StatusTransitions int    `json:"status_transitions"`
	MilestoneChanges  int    `json:"milestone_changes"`
}

// FlowResult contains bounded, observation-based delivery flow metrics. It is
// deliberately not presented as cycle time, capacity, or causal analysis.
type FlowResult struct {
	From              *time.Time      `json:"from,omitempty"`
	Until             *time.Time      `json:"until,omitempty"`
	Changes           int             `json:"changes"`
	Added             int             `json:"added"`
	Started           int             `json:"started"`
	Completed         int             `json:"completed"`
	Reopened          int             `json:"reopened"`
	Blocked           int             `json:"blocked"`
	Unblocked         int             `json:"unblocked"`
	StatusTransitions int             `json:"status_transitions"`
	MilestoneChanges  int             `json:"milestone_changes"`
	Buckets           []FlowBucket    `json:"buckets"`
	Truncated         bool            `json:"truncated"`
	Coverage          HistoryCoverage `json:"coverage"`
	Uncertainties     []string        `json:"uncertainties,omitempty"`
}

// FlowReader supplies read-only flow metrics.
type FlowReader interface {
	Flow(FlowQuery) (FlowResult, error)
}

type historyRecord struct {
	Type                string     `json:"type"`
	SyncRunID           string     `json:"sync_run_id,omitempty"`
	ObservedAt          time.Time  `json:"observed_at"`
	SnapshotGeneratedAt time.Time  `json:"snapshot_generated_at"`
	Milestone           string     `json:"milestone,omitempty"`
	Goal                string     `json:"goal,omitempty"`
	ItemCount           int        `json:"item_count"`
	EntityKeys          []string   `json:"entity_keys,omitempty"`
	EntitiesRecorded    bool       `json:"entities_recorded"`
	SourceWatermark     *time.Time `json:"source_watermark,omitempty"`
	Change              *Change    `json:"change,omitempty"`
}

type historyVersion struct {
	item                domain.WorkItem
	milestone           string
	observedAt          time.Time
	snapshotGeneratedAt time.Time
}

func (s *FileStore) historyRecordsLocked(snapshot domain.Snapshot, observedAt time.Time, syncRunID string) ([]historyRecord, map[string]historyVersion) {
	milestone := strings.TrimSpace(snapshot.Sprint.Name)
	snapshotAt := snapshot.GeneratedAt
	if snapshotAt.IsZero() {
		snapshotAt = observedAt
	}
	snapshotAt = snapshotAt.UTC()
	entityKeys := make([]string, 0, len(snapshot.Sprint.WorkItems))
	for _, item := range snapshot.Sprint.WorkItems {
		entityKeys = append(entityKeys, historyItemKey(item))
	}
	sort.Strings(entityKeys)
	var watermark *time.Time
	if value := maxSourceUpdatedAt(snapshot); !value.IsZero() {
		watermark = timePointer(value)
	}

	records := []historyRecord{{
		Type:                historyRecordObservation,
		SyncRunID:           syncRunID,
		ObservedAt:          observedAt,
		SnapshotGeneratedAt: snapshotAt,
		Milestone:           milestone,
		Goal:                snapshot.Sprint.Goal,
		ItemCount:           len(snapshot.Sprint.WorkItems),
		EntityKeys:          entityKeys,
		EntitiesRecorded:    true,
		SourceWatermark:     watermark,
	}}
	nextLatest := make(map[string]historyVersion, len(s.latest)+len(snapshot.Sprint.WorkItems))
	maps.Copy(nextLatest, s.latest)

	items := append([]domain.WorkItem(nil), snapshot.Sprint.WorkItems...)
	sort.SliceStable(items, func(i, j int) bool {
		left, right := historyItemKey(items[i]), historyItemKey(items[j])
		if left == right {
			return items[i].ID < items[j].ID
		}
		return left < right
	})
	firstObservation := s.observationCount == 0
	for _, item := range items {
		key := historyItemKey(item)
		current := historyVersion{
			item:                cloneWorkItem(item),
			milestone:           milestone,
			observedAt:          observedAt,
			snapshotGeneratedAt: snapshotAt,
		}
		before, found := s.latest[key]
		var changed []FieldChange
		kind := ChangeKindAdded
		var beforeItem *domain.WorkItem
		if found {
			beforeItemValue := cloneWorkItem(before.item)
			beforeItem = &beforeItemValue
			changed = fieldChanges(
				canonicalWorkItem(before.item, before.milestone, before.snapshotGeneratedAt, before.observedAt, s.staleAfter),
				canonicalWorkItem(item, milestone, snapshotAt, observedAt, s.staleAfter),
			)
			if len(changed) == 0 {
				nextLatest[key] = current
				continue
			}
			kind = ChangeKindUpdated
			if len(changed) == 1 && changed[0].Field == "milestone" {
				kind = ChangeKindMilestoneChanged
			}
		} else {
			changed = fieldChanges(nil, canonicalWorkItem(item, milestone, snapshotAt, observedAt, s.staleAfter))
			if firstObservation {
				kind = ChangeKindBaseline
			}
		}

		afterItem := cloneWorkItem(item)
		change := Change{
			Kind:                kind,
			ObservedAt:          observedAt,
			SnapshotGeneratedAt: snapshotAt,
			SourceUpdatedAt:     sourceUpdatedAt(item.LastActivity),
			RevisionHash:        canonicalRevisionHash(item, milestone, snapshotAt, observedAt, s.staleAfter),
			SyncRunID:           syncRunID,
			Milestone:           milestone,
			EntityKey:           key,
			ItemID:              strings.TrimSpace(item.ID),
			ProjectID:           item.ProjectID,
			ProjectPath:         strings.TrimSpace(item.ProjectPath),
			ChangedFields:       changed,
			Before:              beforeItem,
			After:               &afterItem,
		}
		change.ID = historyChangeID(change)
		records = append(records, historyRecord{
			Type:                historyRecordChange,
			SyncRunID:           syncRunID,
			ObservedAt:          observedAt,
			SnapshotGeneratedAt: snapshotAt,
			Milestone:           milestone,
			SourceWatermark:     watermark,
			Change:              &change,
		})
		nextLatest[key] = current
	}
	return records, nextLatest
}

func historyItemKey(item domain.WorkItem) string {
	id := strings.TrimSpace(item.ID)
	if item.ProjectID > 0 {
		separator := strings.LastIndexByte(id, '#')
		if separator >= 0 && separator < len(id)-1 {
			if iid, err := strconv.Atoi(id[separator+1:]); err == nil && iid > 0 {
				return fmt.Sprintf("project/%d#%d", item.ProjectID, iid)
			}
		}
	}
	if id != "" {
		return id
	}
	return fmt.Sprintf("project/%d:%s", item.ProjectID, strings.TrimSpace(item.Title))
}

func historyChangeID(change Change) string {
	value := struct {
		Kind       ChangeKind    `json:"kind"`
		ObservedAt time.Time     `json:"observed_at"`
		EntityKey  string        `json:"entity_key"`
		Milestone  string        `json:"milestone"`
		Fields     []FieldChange `json:"fields"`
	}{
		Kind:       change.Kind,
		ObservedAt: change.ObservedAt,
		EntityKey:  change.EntityKey,
		Milestone:  change.Milestone,
		Fields:     change.ChangedFields,
	}
	data, _ := json.Marshal(value)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:16])
}

func canonicalRevisionHash(item domain.WorkItem, milestone string, snapshotAt, observedAt time.Time, staleAfter time.Duration) string {
	data, _ := json.Marshal(canonicalWorkItem(item, milestone, snapshotAt, observedAt, staleAfter))
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func sourceUpdatedAt(value time.Time) *time.Time {
	if value.IsZero() {
		return nil
	}
	return timePointer(value)
}

func canonicalWorkItem(item domain.WorkItem, milestone string, snapshotAt, observedAt time.Time, staleAfter time.Duration) map[string]any {
	statusAt := snapshotAt
	if statusAt.IsZero() {
		statusAt = observedAt
	}
	return map[string]any{
		"item_id":        strings.TrimSpace(item.ID),
		"project_id":     item.ProjectID,
		"project_path":   strings.TrimSpace(item.ProjectPath),
		"title":          item.Title,
		"state":          string(item.State),
		"assignee":       strings.TrimSpace(item.Assignee),
		"labels":         canonicalLabels(item.Labels),
		"blocked":        item.Blocked,
		"last_activity":  canonicalTime(item.LastActivity),
		"merge_requests": canonicalMergeRequests(item.MergeRequests),
		"status":         string(domain.DeriveStatus(item, statusAt, staleAfter)),
		"milestone":      milestone,
	}
}

func canonicalLabels(labels []string) []string {
	result := make([]string, 0, len(labels))
	seen := make(map[string]struct{}, len(labels))
	for _, label := range labels {
		label = strings.TrimSpace(label)
		if label == "" {
			continue
		}
		if _, ok := seen[label]; ok {
			continue
		}
		seen[label] = struct{}{}
		result = append(result, label)
	}
	sort.Strings(result)
	return result
}

func canonicalMergeRequests(requests []domain.MergeRequest) []map[string]any {
	result := make([]map[string]any, 0, len(requests))
	for _, request := range requests {
		result = append(result, map[string]any{
			"id":               strings.TrimSpace(request.ID),
			"title":            request.Title,
			"state":            string(request.State),
			"draft":            request.Draft,
			"review_requested": request.ReviewRequested,
			"pipeline":         string(request.Pipeline),
		})
	}
	sort.SliceStable(result, func(i, j int) bool {
		left, right := result[i], result[j]
		leftID, rightID := left["id"].(string), right["id"].(string)
		if leftID == rightID {
			return left["title"].(string) < right["title"].(string)
		}
		return leftID < rightID
	})
	return result
}

func canonicalTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func fieldChanges(before, after map[string]any) []FieldChange {
	keys := make(map[string]struct{}, len(before)+len(after))
	for key := range before {
		keys[key] = struct{}{}
	}
	for key := range after {
		keys[key] = struct{}{}
	}
	ordered := make([]string, 0, len(keys))
	for key := range keys {
		ordered = append(ordered, key)
	}
	sort.Strings(ordered)
	changes := make([]FieldChange, 0, len(ordered))
	for _, key := range ordered {
		left, right := before[key], after[key]
		if reflect.DeepEqual(left, right) {
			continue
		}
		changes = append(changes, FieldChange{Field: key, Before: left, After: right})
	}
	return changes
}

func cloneWorkItem(item domain.WorkItem) domain.WorkItem {
	copyOf := item
	copyOf.Labels = append([]string(nil), item.Labels...)
	copyOf.MergeRequests = append([]domain.MergeRequest(nil), item.MergeRequests...)
	return copyOf
}

func maxSourceUpdatedAt(snapshot domain.Snapshot) time.Time {
	var watermark time.Time
	for _, item := range snapshot.Sprint.WorkItems {
		if item.LastActivity.After(watermark) {
			watermark = item.LastActivity.UTC()
		}
	}
	return watermark
}

func (s *FileStore) loadHistory() error {
	records, err := s.readHistoryRecordsLocked()
	if err != nil {
		return err
	}
	s.resetHistoryState()
	for _, record := range records {
		s.applyHistoryRecord(record)
	}
	return nil
}

func (s *FileStore) readHistoryRecordsLocked() ([]historyRecord, error) {
	file, err := os.Open(s.historyPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()

	records := make([]historyRecord, 0)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)
	for line := 1; scanner.Scan(); line++ {
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}
		var record historyRecord
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			return nil, fmt.Errorf("decode history line %d: %w", line, err)
		}
		records = append(records, record)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read history: %w", err)
	}
	return records, nil
}

func (s *FileStore) resetHistoryState() {
	s.latest = make(map[string]historyVersion)
	s.historyStartedAt = time.Time{}
	s.lastObservedAt = time.Time{}
	s.observationCount = 0
}

func (s *FileStore) applyHistoryRecord(record historyRecord) {
	observedAt := historyRecordObservedAt(record)
	if !observedAt.IsZero() {
		if s.historyStartedAt.IsZero() || observedAt.Before(s.historyStartedAt) {
			s.historyStartedAt = observedAt
		}
		if observedAt.After(s.lastObservedAt) {
			s.lastObservedAt = observedAt
		}
	}
	if record.SourceWatermark != nil && record.SourceWatermark.After(s.sourceWatermark) {
		s.sourceWatermark = *record.SourceWatermark
	}
	if record.Type == historyRecordObservation {
		s.observationCount++
		return
	}
	if record.Type != historyRecordChange || record.Change == nil {
		return
	}
	change := record.Change
	key := strings.TrimSpace(change.EntityKey)
	if key == "" && change.After != nil {
		key = historyItemKey(*change.After)
	}
	if key == "" {
		return
	}
	if change.Kind == ChangeKindRemoved || change.After == nil {
		delete(s.latest, key)
		return
	}
	s.latest[key] = historyVersion{
		item:                cloneWorkItem(*change.After),
		milestone:           change.Milestone,
		observedAt:          change.ObservedAt,
		snapshotGeneratedAt: change.SnapshotGeneratedAt,
	}
}

func historyRecordObservedAt(record historyRecord) time.Time {
	if !record.ObservedAt.IsZero() {
		return record.ObservedAt
	}
	if record.Change != nil {
		return record.Change.ObservedAt
	}
	return time.Time{}
}

func appendHistoryRecordsLocked(path string, records []historyRecord) error {
	if len(records) == 0 {
		return nil
	}
	data, err := marshalHistoryRecords(records)
	if err != nil {
		return err
	}
	return appendBytesLocked(path, data, "history")
}

func marshalHistoryRecords(records []historyRecord) ([]byte, error) {
	var data bytes.Buffer
	for _, record := range records {
		encoded, err := json.Marshal(record)
		if err != nil {
			return nil, fmt.Errorf("encode history: %w", err)
		}
		data.Write(encoded)
		data.WriteByte('\n')
	}
	return data.Bytes(), nil
}

func (s *FileStore) loadSyncRuns() error {
	file, err := os.Open(s.syncRunsPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()

	s.syncRuns = make([]domain.SyncRun, 0)
	sourceWatermark := time.Time{}
	lastFullSyncAt := time.Time{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	for line := 1; scanner.Scan(); line++ {
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}
		var run domain.SyncRun
		if err := json.Unmarshal(scanner.Bytes(), &run); err != nil {
			return fmt.Errorf("decode sync run line %d: %w", line, err)
		}
		s.syncRuns = append(s.syncRuns, run)
		if run.Status == "success" {
			if run.SourceWatermark != nil && run.SourceWatermark.After(sourceWatermark) {
				sourceWatermark = *run.SourceWatermark
			}
			if run.FullScan && run.CompletedAt.After(lastFullSyncAt) {
				lastFullSyncAt = run.CompletedAt
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read sync runs: %w", err)
	}
	s.sourceWatermark = sourceWatermark
	s.lastFullSyncAt = lastFullSyncAt
	return nil
}

func retentionCheckpoint(records []historyRecord, cutoff time.Time, staleAfter time.Duration) []historyRecord {
	versions := make(map[string]historyVersion)
	var observation historyRecord
	hasObservation := false
	for _, record := range records {
		observedAt := historyRecordObservedAt(record)
		if observedAt.IsZero() || !observedAt.Before(cutoff) {
			continue
		}
		if record.Type == historyRecordObservation || record.Type == historyRecordCheckpoint {
			if !hasObservation || !observedAt.Before(historyRecordObservedAt(observation)) {
				observation = record
				hasObservation = true
			}
			continue
		}
		if record.Type != historyRecordChange || record.Change == nil {
			continue
		}
		change := record.Change
		key := strings.TrimSpace(change.EntityKey)
		if key == "" && change.After != nil {
			key = historyItemKey(*change.After)
		}
		if key == "" {
			continue
		}
		if change.Kind == ChangeKindRemoved || change.After == nil {
			delete(versions, key)
			continue
		}
		versions[key] = historyVersion{
			item:                cloneWorkItem(*change.After),
			milestone:           change.Milestone,
			observedAt:          observedAt,
			snapshotGeneratedAt: change.SnapshotGeneratedAt,
		}
	}
	if !hasObservation && len(versions) == 0 {
		return nil
	}
	keys := make([]string, 0, len(versions))
	for key := range versions {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if hasObservation && observation.EntitiesRecorded {
		keys = append(keys[:0], observation.EntityKeys...)
		sort.Strings(keys)
	}
	checkpoint := historyRecord{
		Type:             historyRecordCheckpoint,
		SyncRunID:        "retention-checkpoint",
		ObservedAt:       cutoff,
		Milestone:        observation.Milestone,
		Goal:             observation.Goal,
		ItemCount:        len(keys),
		EntityKeys:       keys,
		EntitiesRecorded: hasObservation && observation.EntitiesRecorded,
	}
	checkpoint.SnapshotGeneratedAt = observation.SnapshotGeneratedAt
	if checkpoint.SnapshotGeneratedAt.IsZero() {
		checkpoint.SnapshotGeneratedAt = cutoff
	}
	var watermark time.Time
	for _, key := range keys {
		version, ok := versions[key]
		if ok && version.item.LastActivity.After(watermark) {
			watermark = version.item.LastActivity.UTC()
		}
	}
	if !watermark.IsZero() {
		checkpoint.SourceWatermark = timePointer(watermark)
	}
	// The checkpoint is followed by its baseline revisions so a historical
	// snapshot can reconstruct items that were unchanged across the boundary.
	if len(keys) == 0 {
		return []historyRecord{checkpoint}
	}
	recordsOut := []historyRecord{checkpoint}
	for _, key := range keys {
		version, ok := versions[key]
		if !ok {
			continue
		}
		after := cloneWorkItem(version.item)
		change := Change{
			Kind:                ChangeKindBaseline,
			ObservedAt:          cutoff,
			SnapshotGeneratedAt: checkpoint.SnapshotGeneratedAt,
			SourceUpdatedAt:     sourceUpdatedAt(version.item.LastActivity),
			RevisionHash:        canonicalRevisionHash(version.item, version.milestone, checkpoint.SnapshotGeneratedAt, cutoff, staleAfter),
			SyncRunID:           checkpoint.SyncRunID,
			Milestone:           version.milestone,
			EntityKey:           key,
			ItemID:              strings.TrimSpace(version.item.ID),
			ProjectID:           version.item.ProjectID,
			ProjectPath:         strings.TrimSpace(version.item.ProjectPath),
			ChangedFields:       fieldChanges(nil, canonicalWorkItem(version.item, version.milestone, checkpoint.SnapshotGeneratedAt, cutoff, staleAfter)),
			After:               &after,
		}
		change.ID = historyChangeID(change)
		recordsOut = append(recordsOut, historyRecord{
			Type:                historyRecordChange,
			SyncRunID:           checkpoint.SyncRunID,
			ObservedAt:          cutoff,
			SnapshotGeneratedAt: checkpoint.SnapshotGeneratedAt,
			Milestone:           version.milestone,
			SourceWatermark:     checkpoint.SourceWatermark,
			Change:              &change,
		})
	}
	return recordsOut
}

func (s *FileStore) pruneHistoryLocked(now time.Time) error {
	if s.historyRetention <= 0 {
		return nil
	}
	records, err := s.readHistoryRecordsLocked()
	if err != nil || len(records) == 0 {
		return err
	}
	cutoff := now.UTC().Add(-s.historyRetention)
	kept := make([]historyRecord, 0, len(records))
	pruned := false
	for _, record := range records {
		observedAt := historyRecordObservedAt(record)
		if !observedAt.IsZero() && observedAt.Before(cutoff) {
			pruned = true
			continue
		}
		kept = append(kept, record)
	}
	if !pruned {
		return nil
	}
	checkpoint := retentionCheckpoint(records, cutoff, s.staleAfter)
	retained := append(checkpoint, kept...)
	data, err := marshalHistoryRecords(retained)
	if err != nil {
		return err
	}
	if err := writeAtomic(s.historyPath(), data, 0o600); err != nil {
		return err
	}
	s.resetHistoryState()
	for _, record := range retained {
		s.applyHistoryRecord(record)
	}
	return nil
}

func (s *FileStore) pruneSyncRunsLocked(now time.Time) error {
	if s.historyRetention <= 0 || len(s.syncRuns) == 0 {
		return nil
	}
	cutoff := now.UTC().Add(-s.historyRetention)
	kept := make([]domain.SyncRun, 0, len(s.syncRuns))
	pruned := false
	for _, run := range s.syncRuns {
		if !run.CompletedAt.IsZero() && run.CompletedAt.Before(cutoff) {
			pruned = true
			continue
		}
		kept = append(kept, run)
	}
	if !pruned {
		return nil
	}
	data := make([]byte, 0, len(kept)*128)
	for _, run := range kept {
		encoded, err := json.Marshal(run)
		if err != nil {
			return fmt.Errorf("encode sync run: %w", err)
		}
		data = append(data, encoded...)
		data = append(data, '\n')
	}
	if err := writeAtomic(s.syncRunsPath(), data, 0o600); err != nil {
		return err
	}
	s.syncRuns = kept
	s.recalculateRunMetadata()
	return nil
}

func (s *FileStore) recalculateRunMetadata() {
	sourceWatermark := time.Time{}
	lastFullSyncAt := time.Time{}
	for _, run := range s.syncRuns {
		if run.Status != "success" {
			continue
		}
		if run.SourceWatermark != nil && run.SourceWatermark.After(sourceWatermark) {
			sourceWatermark = *run.SourceWatermark
		}
		if run.FullScan && run.CompletedAt.After(lastFullSyncAt) {
			lastFullSyncAt = run.CompletedAt
		}
	}
	s.sourceWatermark = sourceWatermark
	s.lastFullSyncAt = lastFullSyncAt
}

func (s *FileStore) coverageLocked() HistoryCoverage {
	coverage := HistoryCoverage{
		Observations: s.observationCount,
		Scope:        "current_milestone",
	}
	if !s.historyStartedAt.IsZero() {
		value := s.historyStartedAt
		coverage.HistoryStartedAt = &value
		coverage.RetainedFrom = &value
	}
	if !s.lastObservedAt.IsZero() {
		value := s.lastObservedAt
		coverage.LastObservedAt = &value
	}
	if !s.sourceWatermark.IsZero() {
		value := s.sourceWatermark
		coverage.SourceWatermark = &value
	}
	if s.historyRetention > 0 {
		coverage.Retention = s.historyRetention.String()
	}

	lastRunAt := time.Time{}
	lastRunFullScan := false
	for _, run := range s.syncRuns {
		switch run.Status {
		case "success":
			coverage.SuccessfulRuns++
		case "error":
			coverage.FailedRuns++
		}
		if coverage.LastSyncRunID == "" || run.CompletedAt.After(lastRunAt) {
			coverage.LastSyncRunID = run.ID
			coverage.LastRunStatus = run.Status
			lastRunAt = run.CompletedAt
			lastRunFullScan = run.FullScan
		}
	}
	if coverage.LastSyncRunID != "" {
		coverage.CurrentScopeComplete = coverage.LastRunStatus == "success" && lastRunFullScan
		switch coverage.LastRunStatus {
		case "success":
			if !lastRunFullScan {
				coverage.Uncertainties = append(coverage.Uncertainties, "the latest view came from an overlap pull; deletions may wait for a full scan")
			}
		case "error":
			coverage.Uncertainties = append(coverage.Uncertainties, "the latest reconciliation failed; the cached view may be stale")
		}
	} else if coverage.Observations > 0 {
		coverage.Uncertainties = append(coverage.Uncertainties, "sync-run metadata is unavailable for some observations")
	}
	if coverage.Observations > 0 {
		coverage.Uncertainties = append(coverage.Uncertainties,
			"history begins at Flux's first retained successful observation",
			"deletions outside the current milestone-scoped snapshot are not inferred",
		)
	}
	if s.historyRetention > 0 && coverage.Observations > 0 {
		coverage.Uncertainties = append(coverage.Uncertainties, "records older than the configured retention window are unavailable")
	}
	return coverage
}

// Changes returns historical changes in reverse observation order.
func (s *FileStore) Changes(query ChangeQuery) (ChangeResult, error) {
	if query.Limit < 0 {
		return ChangeResult{}, errors.New("history limit must not be negative")
	}
	limit := query.Limit
	if limit == 0 {
		limit = DefaultHistoryLimit
	}
	if limit > MaxHistoryLimit {
		limit = MaxHistoryLimit
	}
	query.ItemID = strings.TrimSpace(query.ItemID)
	query.Milestone = strings.TrimSpace(query.Milestone)

	s.mu.RLock()
	defer s.mu.RUnlock()
	result := s.changeResultLocked()
	records, err := s.readHistoryRecordsLocked()
	if err != nil {
		return ChangeResult{}, err
	}
	result.Changes = changesFromRecords(records, query, limit)
	return result, nil
}

func (s *FileStore) changeResultLocked() ChangeResult {
	result := ChangeResult{Observations: s.observationCount, Changes: make([]Change, 0), Coverage: s.coverageLocked()}
	result.HistoryStartedAt = result.Coverage.HistoryStartedAt
	result.LastObservedAt = result.Coverage.LastObservedAt
	return result
}

func changesFromRecords(records []historyRecord, query ChangeQuery, limit int) []Change {
	changes := make([]Change, 0)
	seen := make(map[string]struct{})
	for _, record := range records {
		if record.Type != historyRecordChange || record.Change == nil {
			continue
		}
		change := *record.Change
		if !query.IncludeBaseline && change.Kind == ChangeKindBaseline {
			continue
		}
		if !changeMatches(change, query) {
			continue
		}
		if change.ID != "" {
			if _, ok := seen[change.ID]; ok {
				continue
			}
			seen[change.ID] = struct{}{}
		}
		changes = append(changes, change)
	}
	sort.SliceStable(changes, func(i, j int) bool {
		left, right := changes[i], changes[j]
		if left.ObservedAt.Equal(right.ObservedAt) {
			return left.ID > right.ID
		}
		return left.ObservedAt.After(right.ObservedAt)
	})
	if limit > 0 && len(changes) > limit {
		changes = changes[:limit]
	}
	return changes
}

// SnapshotAt reconstructs the latest observed entity revisions at or before
// at. It never claims a snapshot boundary that has not been observed.
func (s *FileStore) SnapshotAt(at time.Time) (SnapshotResult, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if at.IsZero() {
		at = s.lastObservedAt
	}
	if at.IsZero() {
		return SnapshotResult{}, errors.New("no historical observation is available")
	}
	at = at.UTC()
	records, err := s.readHistoryRecordsLocked()
	if err != nil {
		return SnapshotResult{}, err
	}
	var selected historyRecord
	selectedAt := time.Time{}
	found := false
	for _, record := range records {
		if record.Type != historyRecordObservation && record.Type != historyRecordCheckpoint {
			continue
		}
		observedAt := historyRecordObservedAt(record)
		if observedAt.IsZero() || observedAt.After(at) {
			continue
		}
		if !found || !observedAt.Before(selectedAt) {
			selected = record
			selectedAt = observedAt
			found = true
		}
	}
	if !found {
		return SnapshotResult{}, fmt.Errorf("no historical observation at or before %s", at.Format(time.RFC3339Nano))
	}

	revisions := make(map[string]historyVersion)
	for _, record := range records {
		if record.Type != historyRecordChange || record.Change == nil {
			continue
		}
		change := record.Change
		observedAt := change.ObservedAt
		if observedAt.IsZero() {
			observedAt = record.ObservedAt
		}
		if observedAt.IsZero() || observedAt.After(selectedAt) {
			continue
		}
		key := strings.TrimSpace(change.EntityKey)
		if key == "" && change.After != nil {
			key = historyItemKey(*change.After)
		}
		if key == "" {
			continue
		}
		if change.Kind == ChangeKindRemoved || change.After == nil {
			delete(revisions, key)
			continue
		}
		revisions[key] = historyVersion{
			item:                cloneWorkItem(*change.After),
			milestone:           change.Milestone,
			observedAt:          observedAt,
			snapshotGeneratedAt: change.SnapshotGeneratedAt,
		}
	}

	uncertainties := make([]string, 0)
	keys := append([]string(nil), selected.EntityKeys...)
	if !selected.EntitiesRecorded {
		keys = keys[:0]
		for key := range revisions {
			keys = append(keys, key)
		}
		uncertainties = append(uncertainties, "the selected observation predates recorded entity coverage")
	}
	sort.Strings(keys)
	items := make([]domain.WorkItem, 0, len(keys))
	for _, key := range keys {
		version, ok := revisions[key]
		if !ok {
			uncertainties = append(uncertainties, fmt.Sprintf("entity %s has no retained revision at the selected observation", key))
			continue
		}
		items = append(items, cloneWorkItem(version.item))
	}
	if at.After(selectedAt) {
		uncertainties = append(uncertainties, "the reconstructed state is from the latest observation at or before the requested time")
	}
	if at.After(s.lastObservedAt) && !s.lastObservedAt.IsZero() {
		uncertainties = append(uncertainties, "the requested time is after the last observed pull")
	}
	generatedAt := selected.SnapshotGeneratedAt
	if generatedAt.IsZero() {
		generatedAt = selectedAt
	}
	generatedAt = generatedAt.UTC()
	result := SnapshotResult{
		AsOf:            at,
		ObservedAt:      selectedAt,
		SyncRunID:       selected.SyncRunID,
		SourceWatermark: selected.SourceWatermark,
		Snapshot: domain.Snapshot{
			GeneratedAt: generatedAt,
			Sprint: domain.Sprint{
				Name:      selected.Milestone,
				Goal:      selected.Goal,
				WorkItems: items,
			},
		},
		Coverage:      s.coverageLocked(),
		Uncertainties: uncertainties,
	}
	result.Coverage.CurrentScopeComplete = selected.EntitiesRecorded && len(uncertainties) == 0
	result.Uncertainties = appendUnique(result.Uncertainties, result.Coverage.Uncertainties...)
	return result, nil
}

// Flow returns observation-based transition counts and daily buckets.
func (s *FileStore) Flow(query FlowQuery) (FlowResult, error) {
	if !query.From.IsZero() && !query.Until.IsZero() && !query.Until.After(query.From) {
		return FlowResult{}, errors.New("flow until must be after from")
	}
	query.ItemID = strings.TrimSpace(query.ItemID)
	query.Milestone = strings.TrimSpace(query.Milestone)

	s.mu.RLock()
	defer s.mu.RUnlock()
	result := FlowResult{Buckets: make([]FlowBucket, 0), Coverage: s.coverageLocked()}
	records, err := s.readHistoryRecordsLocked()
	if err != nil {
		return FlowResult{}, err
	}
	changes := changesFromRecords(records, ChangeQuery{
		Since:     query.From,
		Until:     query.Until,
		ItemID:    query.ItemID,
		Milestone: query.Milestone,
	}, MaxHistoryLimit+1)
	if len(changes) > MaxHistoryLimit {
		result.Truncated = true
		changes = changes[:MaxHistoryLimit]
		result.Uncertainties = append(result.Uncertainties, fmt.Sprintf("flow metrics were capped at the %d most recent changes", MaxHistoryLimit))
	}
	result.Changes = len(changes)
	buckets := make(map[string]*FlowBucket)
	for _, change := range changes {
		date := change.ObservedAt.UTC().Format("2006-01-02")
		bucket := buckets[date]
		if bucket == nil {
			bucket = &FlowBucket{Date: date}
			buckets[date] = bucket
		}
		bucket.Changes++
		switch change.Kind {
		case ChangeKindAdded:
			result.Added++
			result.Started++
			bucket.Added++
			bucket.Started++
		case ChangeKindMilestoneChanged:
			result.MilestoneChanges++
			bucket.MilestoneChanges++
		}
		for _, field := range change.ChangedFields {
			if field.Field != "status" {
				continue
			}
			before, beforeOK := field.Before.(string)
			after, afterOK := field.After.(string)
			if !beforeOK || !afterOK || before == after {
				continue
			}
			result.StatusTransitions++
			bucket.StatusTransitions++
			if after == string(domain.StatusDone) && before != string(domain.StatusDone) {
				result.Completed++
				bucket.Completed++
			}
			if before == string(domain.StatusDone) && after != string(domain.StatusDone) {
				result.Reopened++
				bucket.Reopened++
			}
			if after == string(domain.StatusInProgress) && before != string(domain.StatusInProgress) && change.Kind != ChangeKindAdded {
				result.Started++
				bucket.Started++
			}
			if after == string(domain.StatusBlocked) && before != string(domain.StatusBlocked) {
				result.Blocked++
				bucket.Blocked++
			}
			if before == string(domain.StatusBlocked) && after != string(domain.StatusBlocked) {
				result.Unblocked++
				bucket.Unblocked++
			}
		}
	}
	for _, bucket := range buckets {
		result.Buckets = append(result.Buckets, *bucket)
	}
	sort.Slice(result.Buckets, func(i, j int) bool { return result.Buckets[i].Date < result.Buckets[j].Date })
	if !query.From.IsZero() {
		value := query.From.UTC()
		result.From = &value
	} else {
		result.From = result.Coverage.HistoryStartedAt
	}
	if !query.Until.IsZero() {
		value := query.Until.UTC()
		result.Until = &value
	} else {
		result.Until = result.Coverage.LastObservedAt
	}
	result.Uncertainties = appendUnique(result.Uncertainties, result.Coverage.Uncertainties...)
	result.Uncertainties = appendUnique(result.Uncertainties, "flow metrics count observed transitions; they are not cycle-time, capacity, or causal measurements")
	return result, nil
}

func appendUnique(values []string, additions ...string) []string {
	seen := make(map[string]struct{}, len(values)+len(additions))
	for _, value := range values {
		seen[value] = struct{}{}
	}
	for _, value := range additions {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}
	return values
}

func changeMatches(change Change, query ChangeQuery) bool {
	if !query.Since.IsZero() && change.ObservedAt.Before(query.Since) {
		return false
	}
	if !query.Until.IsZero() && !change.ObservedAt.Before(query.Until) {
		return false
	}
	if query.Milestone != "" && change.Milestone != query.Milestone {
		return false
	}
	if query.ItemID == "" {
		return true
	}
	if change.ItemID == query.ItemID || change.EntityKey == query.ItemID {
		return true
	}
	if change.Before != nil && change.Before.ID == query.ItemID {
		return true
	}
	return change.After != nil && change.After.ID == query.ItemID
}

func timePointer(value time.Time) *time.Time {
	value = value.UTC()
	return &value
}
