// Package report builds bounded, evidence-labelled ceremony views from Flux's
// current GitLab-derived snapshot, observed history, and confirmed human
// context. It does not make backlog decisions or mutate GitLab.
package report

import (
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
	"abagile.com/tokyo3/flux/internal/state"
)

const (
	// DefaultLimit bounds a report's lists when a caller does not provide a
	// limit. Counts remain complete for the available snapshot.
	DefaultLimit = 20
	// MaxLimit prevents a report from consuming an unbounded API or Pi budget.
	MaxLimit = 100

	maxItemLabels        = 20
	maxItemMergeRequests = 20

	standupWindow       = 24 * time.Hour
	sprintHealthWindow  = 7 * 24 * time.Hour
	refinementWindow    = 7 * 24 * time.Hour
	planningWindow      = 7 * 24 * time.Hour
	backlogWindow       = 7 * 24 * time.Hour
	retrospectiveWindow = 14 * 24 * time.Hour
)

var (
	ErrSnapshotUnavailable = errors.New("report snapshot is unavailable")
	ErrInvalidKind         = errors.New("invalid report kind")
)

// Kind identifies a supported evidence-based report.
type Kind string

const (
	KindStandup       Kind = "standup"
	KindSprintHealth  Kind = "sprint_health"
	KindRefinement    Kind = "refinement"
	KindPlanning      Kind = "planning"
	KindBacklog       Kind = "backlog"
	KindRetrospective Kind = "retrospective"
)

var reportKinds = []Kind{
	KindStandup,
	KindSprintHealth,
	KindRefinement,
	KindPlanning,
	KindBacklog,
	KindRetrospective,
}

// Kinds returns the supported report kinds in stable display order.
func Kinds() []Kind {
	return append([]Kind(nil), reportKinds...)
}

// ParseKind accepts either the JSON/Go snake_case spelling or the URL/CLI
// kebab-case spelling.
func ParseKind(raw string) (Kind, error) {
	normalized := strings.ToLower(strings.TrimSpace(raw))
	normalized = strings.ReplaceAll(normalized, "-", "_")
	for _, kind := range reportKinds {
		if string(kind) == normalized {
			return kind, nil
		}
	}
	return "", fmt.Errorf("%w: %q", ErrInvalidKind, raw)
}

// PathName returns the URL and CLI spelling of a report kind.
func (k Kind) PathName() string {
	return strings.ReplaceAll(string(k), "_", "-")
}

// Query bounds a report's time window and list sizes. A missing window uses a
// report-specific default ending at the snapshot's as-of time, extended to
// the latest retained observation when needed to include the current pull.
// From is inclusive and Until is exclusive.
type Query struct {
	From  time.Time
	Until time.Time
	Limit int
}

// SourceCoverage identifies the provenance of one report input.
type SourceCoverage struct {
	Name          string   `json:"name"`
	Provenance    string   `json:"provenance"`
	Available     bool     `json:"available"`
	Uncertainties []string `json:"uncertainties,omitempty"`
}

// Coverage describes which evidence sources contributed to a report. The
// current snapshot, Flux-observed history, and human context remain separate
// so an agent cannot mistake one for another.
type Coverage struct {
	WindowFrom          *time.Time             `json:"window_from,omitempty"`
	WindowUntil         *time.Time             `json:"window_until,omitempty"`
	SnapshotGeneratedAt *time.Time             `json:"snapshot_generated_at,omitempty"`
	Scope               string                 `json:"scope,omitempty"`
	Sources             []SourceCoverage       `json:"sources"`
	History             *state.HistoryCoverage `json:"history,omitempty"`
	HumanContext        *state.ContextCoverage `json:"human_context,omitempty"`
	Uncertainties       []string               `json:"uncertainties,omitempty"`
}

// Base is common metadata included in every report.
type Base struct {
	Kind        Kind      `json:"kind"`
	GeneratedAt time.Time `json:"generated_at"`
	AsOf        time.Time `json:"as_of"`
	Milestone   string    `json:"milestone,omitempty"`
	Goal        string    `json:"goal,omitempty"`
	Truncated   bool      `json:"truncated"`
	Coverage    Coverage  `json:"coverage"`
}

// Item is a bounded, flat report view of one normalized GitLab work item.
// Status and Signals are derived from the item; they do not represent human
// or AI recommendations.
type Item struct {
	ID            string                `json:"id"`
	ProjectID     int                   `json:"project_id,omitempty"`
	ProjectPath   string                `json:"project_path,omitempty"`
	Title         string                `json:"title"`
	State         domain.IssueState     `json:"state"`
	Status        domain.Status         `json:"status"`
	Assignee      string                `json:"assignee,omitempty"`
	Labels        []string              `json:"labels,omitempty"`
	Blocked       bool                  `json:"blocked"`
	LastActivity  time.Time             `json:"last_activity"`
	MergeRequests []domain.MergeRequest `json:"merge_requests,omitempty"`
	Signals       []string              `json:"signals,omitempty"`
}

// Signal is an aggregate of deterministic, observable evidence. Its Name is
// descriptive rather than a priority or recommendation.
type Signal struct {
	Name     string   `json:"name"`
	Count    int      `json:"count"`
	ItemIDs  []string `json:"item_ids,omitempty"`
	Evidence string   `json:"evidence"`
}

// HumanContextOverlay is intentionally separate from GitLab-derived fields.
// Entries are confirmed human reports, not verified causal facts.
type HumanContextOverlay struct {
	Entries       []domain.HumanContext `json:"entries"`
	Provenance    string                `json:"provenance,omitempty"`
	Uncertainties []string              `json:"uncertainties,omitempty"`
}

// ObservedChange is the bounded change summary used by reports. Detailed
// before/after values remain available through the dedicated history APIs;
// ceremony reports only need the stable evidence identifiers and field names.
type ObservedChange struct {
	ID                  string           `json:"id"`
	Kind                state.ChangeKind `json:"kind"`
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
	ChangedFields       []string         `json:"changed_fields,omitempty"`
}

// StandupReport contains current GitLab-derived work sections, recent Flux
// observations, and a separately-labelled human context overlay.
type StandupReport struct {
	Base
	Counts        map[string]int      `json:"counts"`
	Completed     []Item              `json:"completed"`
	InProgress    []Item              `json:"in_progress"`
	Attention     []Item              `json:"attention"`
	Other         []Item              `json:"other"`
	RecentChanges []ObservedChange    `json:"recent_changes"`
	HumanContext  HumanContextOverlay `json:"human_context_overlay"`
	Limitations   []string            `json:"limitations,omitempty"`
}

// SprintHealthReport describes current status signals and observation-based
// flow without reducing them to an unsupported health score.
type SprintHealthReport struct {
	Base
	Total        int                 `json:"total"`
	Counts       map[string]int      `json:"counts"`
	GoalPresent  bool                `json:"goal_present"`
	SignalState  string              `json:"signal_state"`
	Signals      []Signal            `json:"signals"`
	Attention    []Item              `json:"attention"`
	Flow         *state.FlowResult   `json:"flow,omitempty"`
	HumanContext HumanContextOverlay `json:"human_context_overlay"`
	Limitations  []string            `json:"limitations,omitempty"`
}

// RefinementReport highlights observable readiness gaps in the normalized
// snapshot. It does not claim to inspect issue descriptions or acceptance
// criteria because those fields are not part of Flux's read model.
type RefinementReport struct {
	Base
	Candidates   []Item              `json:"candidates"`
	Signals      []Signal            `json:"signals"`
	HumanContext HumanContextOverlay `json:"human_context_overlay"`
	Limitations  []string            `json:"limitations"`
}

// PlanningReport separates unstarted work, in-flight work, risks, and scope
// decisions. Candidates are current milestone items, not AI-proposed work.
type PlanningReport struct {
	Base
	CandidateItems []Item              `json:"candidate_items"`
	InFlightItems  []Item              `json:"in_flight_items"`
	RiskItems      []Item              `json:"risk_items"`
	RecentChanges  []ObservedChange    `json:"recent_changes"`
	HumanContext   HumanContextOverlay `json:"human_context_overlay"`
	Limitations    []string            `json:"limitations"`
}

// BacklogBucket groups current milestone items by their derived status.
type BacklogBucket struct {
	Status  domain.Status `json:"status"`
	Count   int           `json:"count"`
	ItemIDs []string      `json:"item_ids"`
}

// BacklogReport is a bounded current-milestone backlog view. It does not
// imply that items outside the cached milestone are absent from GitLab.
type BacklogReport struct {
	Base
	Total         int                 `json:"total"`
	Counts        map[string]int      `json:"counts"`
	Buckets       []BacklogBucket     `json:"buckets"`
	Items         []Item              `json:"items"`
	Unassigned    []Item              `json:"unassigned"`
	Attention     []Item              `json:"attention"`
	RecentChanges []ObservedChange    `json:"recent_changes"`
	HumanContext  HumanContextOverlay `json:"human_context_overlay"`
	Limitations   []string            `json:"limitations"`
}

// RetrospectiveReport contains observation-based flow and changes plus a
// separate human-reported overlay. It intentionally has no causal themes.
type RetrospectiveReport struct {
	Base
	Flow            *state.FlowResult   `json:"flow,omitempty"`
	ObservedChanges []ObservedChange    `json:"observed_changes"`
	Signals         []Signal            `json:"signals"`
	HumanContext    HumanContextOverlay `json:"human_context_overlay"`
	Limitations     []string            `json:"limitations"`
}

// Config wires report inputs. History, flow, and context are optional so a
// current snapshot can still be rendered with explicit missing-evidence
// uncertainties.
type Config struct {
	Snapshot   state.Reader
	History    state.HistoryReader
	Flow       state.FlowReader
	Context    state.ContextReader
	StaleAfter time.Duration
	Now        func() time.Time
}

// Service builds reports from the current read model and optional evidence
// stores.
type Service struct {
	snapshot   state.Reader
	history    state.HistoryReader
	flow       state.FlowReader
	context    state.ContextReader
	staleAfter time.Duration
	now        func() time.Time
}

// New validates and constructs a report service.
func New(cfg Config) (*Service, error) {
	if cfg.Snapshot == nil {
		return nil, errors.New("report snapshot reader is required")
	}
	if cfg.StaleAfter <= 0 {
		cfg.StaleAfter = 7 * 24 * time.Hour
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Service{
		snapshot:   cfg.Snapshot,
		history:    cfg.History,
		flow:       cfg.Flow,
		context:    cfg.Context,
		staleAfter: cfg.StaleAfter,
		now:        cfg.Now,
	}, nil
}

// Generate reads the current cached snapshot and builds one report.
func (s *Service) Generate(kind Kind, query Query) (any, error) {
	snapshot, ok := s.snapshot.Get()
	if !ok {
		return nil, ErrSnapshotUnavailable
	}
	return s.GenerateSnapshot(snapshot, kind, query)
}

// GenerateSnapshot builds one report from an explicitly supplied snapshot.
// API milestone pickers use this to keep alternate views read-only and
// request-scoped.
func (s *Service) GenerateSnapshot(snapshot domain.Snapshot, kind Kind, query Query) (any, error) {
	parsed, err := ParseKind(string(kind))
	if err != nil {
		return nil, err
	}
	switch parsed {
	case KindStandup:
		return s.standup(snapshot, query)
	case KindSprintHealth:
		return s.sprintHealth(snapshot, query)
	case KindRefinement:
		return s.refinement(snapshot, query)
	case KindPlanning:
		return s.planning(snapshot, query)
	case KindBacklog:
		return s.backlog(snapshot, query)
	case KindRetrospective:
		return s.retrospective(snapshot, query)
	default:
		return nil, fmt.Errorf("%w: %q", ErrInvalidKind, kind)
	}
}

type reportWindow struct {
	from  time.Time
	until time.Time
	limit int
}

func (s *Service) prepare(snapshot domain.Snapshot, kind Kind, query Query, defaultWindow time.Duration) (Base, []Item, reportWindow, error) {
	asOf := snapshot.GeneratedAt.UTC()
	if asOf.IsZero() {
		asOf = s.now().UTC()
	}
	if asOf.IsZero() {
		return Base{}, nil, reportWindow{}, errors.New("report as-of time is unavailable")
	}
	until := asOf
	if !query.Until.IsZero() {
		until = query.Until.UTC()
	} else {
		var err error
		until, err = s.defaultUntil(asOf)
		if err != nil {
			return Base{}, nil, reportWindow{}, err
		}
	}
	from := until.Add(-defaultWindow)
	if !query.From.IsZero() {
		from = query.From.UTC()
	}
	if !until.After(from) {
		return Base{}, nil, reportWindow{}, errors.New("report until must be after from")
	}
	limit := query.Limit
	if limit == 0 {
		limit = DefaultLimit
	}
	if limit < 1 || limit > MaxLimit {
		return Base{}, nil, reportWindow{}, fmt.Errorf("report limit must be between 1 and %d", MaxLimit)
	}
	coverage := Coverage{
		WindowFrom:  timePointer(from),
		WindowUntil: timePointer(until),
		Scope:       "current_milestone_snapshot",
		Sources: []SourceCoverage{{
			Name:       "gitlab_snapshot",
			Provenance: "gitlab_authoritative_derived_read_model",
			Available:  true,
		}},
	}
	if !snapshot.GeneratedAt.IsZero() {
		coverage.SnapshotGeneratedAt = timePointer(snapshot.GeneratedAt)
	}
	base := Base{
		Kind:        kind,
		GeneratedAt: asOf,
		AsOf:        asOf,
		Milestone:   truncateText(snapshot.Sprint.Name, 200),
		Goal:        truncateText(snapshot.Sprint.Goal, 1000),
		Coverage:    coverage,
	}
	if base.Milestone == "" {
		base.addUncertainty("the current snapshot has no milestone name")
	}
	if snapshot.GeneratedAt.IsZero() {
		base.addUncertainty("snapshot generated time is unavailable; report as-of uses the local clock")
	}
	items := make([]Item, 0, len(snapshot.Sprint.WorkItems))
	for _, summary := range domain.Summarize(snapshot.Sprint, asOf, s.staleAfter).Items {
		items = append(items, itemView(summary))
	}
	sortItems(items)
	return base, items, reportWindow{from: from, until: until, limit: limit}, nil
}

func (s *Service) defaultUntil(asOf time.Time) (time.Time, error) {
	until := asOf
	includeHistoryBoundary := false
	if s.history != nil {
		result, err := s.history.Changes(state.ChangeQuery{Limit: 1})
		if err != nil {
			return time.Time{}, fmt.Errorf("read report history coverage: %w", err)
		}
		if lastObserved := result.Coverage.LastObservedAt; lastObserved != nil && !lastObserved.IsZero() && !lastObserved.Before(until) {
			until = *lastObserved
			includeHistoryBoundary = true
		}
	}
	if s.context != nil {
		result, err := s.context.ListContext(state.ContextQuery{Limit: 1})
		if err != nil {
			return time.Time{}, fmt.Errorf("read report context coverage: %w", err)
		}
		if lastUpdated := result.Coverage.LastUpdatedAt; lastUpdated != nil && lastUpdated.After(until) {
			until = *lastUpdated
		}
	}
	if includeHistoryBoundary {
		return until.Add(time.Nanosecond), nil
	}
	return until, nil
}

func itemView(summary domain.ItemSummary) Item {
	item := summary.Item
	labels := make([]string, 0, min(len(item.Labels), maxItemLabels))
	for _, label := range item.Labels {
		if len(labels) >= maxItemLabels {
			break
		}
		labels = append(labels, truncateText(label, 200))
	}
	mergeRequests := mergeRequestViews(item.MergeRequests)
	signals := itemSignals(item, summary.Status)
	if len(item.Labels) > maxItemLabels {
		signals = append(signals, "report labels capped at 20 entries")
	}
	if len(item.MergeRequests) > maxItemMergeRequests {
		signals = append(signals, "report merge requests capped at 20 entries")
	}
	return Item{
		ID:            truncateText(item.ID, 200),
		ProjectID:     item.ProjectID,
		ProjectPath:   truncateText(item.ProjectPath, 200),
		Title:         truncateText(item.Title, 1000),
		State:         item.State,
		Status:        summary.Status,
		Assignee:      truncateText(item.Assignee, 200),
		Labels:        labels,
		Blocked:       item.Blocked,
		LastActivity:  item.LastActivity,
		MergeRequests: mergeRequests,
		Signals:       signals,
	}
}

func mergeRequestViews(values []domain.MergeRequest) []domain.MergeRequest {
	if len(values) > maxItemMergeRequests {
		values = values[:maxItemMergeRequests]
	}
	result := make([]domain.MergeRequest, 0, len(values))
	for _, value := range values {
		value.ID = truncateText(value.ID, 200)
		value.Title = truncateText(value.Title, 1000)
		result = append(result, value)
	}
	return result
}

func itemSignals(item domain.WorkItem, status domain.Status) []string {
	var signals []string
	switch status {
	case domain.StatusDone:
		signals = append(signals, "GitLab issue is closed or has a merged merge request")
	case domain.StatusBlocked:
		signals = append(signals, "GitLab blocked signal")
	case domain.StatusPipelineFailed:
		signals = append(signals, "an open merge request has a failed pipeline")
	case domain.StatusAwaitingReview:
		signals = append(signals, "an open merge request has an explicit review request")
	case domain.StatusStale:
		signals = append(signals, "GitLab activity is older than the configured stale threshold")
	case domain.StatusTodo:
		if strings.TrimSpace(item.Assignee) == "" {
			signals = append(signals, "no assignee is recorded in GitLab")
		}
	}
	return signals
}

func sortItems(items []Item) {
	sort.SliceStable(items, func(i, j int) bool {
		leftID, rightID := items[i].ID, items[j].ID
		if leftID == rightID {
			return items[i].Title < items[j].Title
		}
		return leftID < rightID
	})
}

func counts(items []Item) map[string]int {
	result := make(map[string]int, 7)
	for _, status := range []domain.Status{
		domain.StatusTodo,
		domain.StatusInProgress,
		domain.StatusAwaitingReview,
		domain.StatusPipelineFailed,
		domain.StatusBlocked,
		domain.StatusStale,
		domain.StatusDone,
	} {
		result[string(status)] = 0
	}
	for _, item := range items {
		result[string(item.Status)]++
	}
	return result
}

func bounded(items []Item, limit int) ([]Item, bool) {
	if len(items) <= limit {
		return items, false
	}
	return items[:limit], true
}

func attentionItem(item Item) bool {
	switch item.Status {
	case domain.StatusBlocked, domain.StatusPipelineFailed, domain.StatusAwaitingReview, domain.StatusStale, domain.StatusTodo:
		return true
	default:
		return false
	}
}

func partition(items []Item) (completed, inProgress, attention, other []Item) {
	for _, item := range items {
		switch {
		case item.Status == domain.StatusDone:
			completed = append(completed, item)
		case item.Status == domain.StatusInProgress:
			inProgress = append(inProgress, item)
		case attentionItem(item):
			attention = append(attention, item)
		default:
			other = append(other, item)
		}
	}
	return
}

func (s *Service) loadChanges(base *Base, snapshot domain.Snapshot, window reportWindow) ([]ObservedChange, error) {
	if s.history == nil {
		base.addSource("flux_history", "flux_observed_history", false, "Flux-observed history is unavailable; this report contains no historical change list")
		return []ObservedChange{}, nil
	}
	requestLimit := min(window.limit+1, state.MaxHistoryLimit)
	result, err := s.history.Changes(state.ChangeQuery{
		Since:           window.from,
		Until:           window.until,
		Milestone:       strings.TrimSpace(snapshot.Sprint.Name),
		Limit:           requestLimit,
		IncludeBaseline: false,
	})
	if err != nil {
		return nil, fmt.Errorf("read report history: %w", err)
	}
	coverage := result.Coverage
	base.Coverage.History = &coverage
	base.addSource("flux_history", "flux_observed_history", true)
	base.addUncertainties(coverage.Uncertainties)
	changes := append([]state.Change(nil), result.Changes...)
	if len(changes) > window.limit {
		base.Truncated = true
		changes = changes[:window.limit]
		base.addUncertainty(fmt.Sprintf("report history was capped at the %d most recent changes", window.limit))
	}
	return observedChangeViews(changes), nil
}

func observedChangeViews(changes []state.Change) []ObservedChange {
	result := make([]ObservedChange, 0, len(changes))
	for _, change := range changes {
		fields := make([]string, 0, len(change.ChangedFields))
		for _, field := range change.ChangedFields {
			name := strings.TrimSpace(field.Field)
			if name == "" || len(fields) >= 20 {
				continue
			}
			fields = append(fields, truncateText(name, 120))
		}
		result = append(result, ObservedChange{
			ID:                  truncateText(change.ID, 200),
			Kind:                change.Kind,
			ObservedAt:          change.ObservedAt,
			SnapshotGeneratedAt: change.SnapshotGeneratedAt,
			SourceUpdatedAt:     change.SourceUpdatedAt,
			RevisionHash:        truncateText(change.RevisionHash, 200),
			SyncRunID:           truncateText(change.SyncRunID, 200),
			Milestone:           truncateText(change.Milestone, 200),
			EntityKey:           truncateText(change.EntityKey, 200),
			ItemID:              truncateText(change.ItemID, 200),
			ProjectID:           change.ProjectID,
			ProjectPath:         truncateText(change.ProjectPath, 200),
			ChangedFields:       fields,
		})
	}
	return result
}

func (s *Service) loadFlow(base *Base, snapshot domain.Snapshot, window reportWindow) (*state.FlowResult, error) {
	if s.flow == nil {
		base.addSource("flux_flow", "flux_observed_flow", false, "Flux-observed flow is unavailable; no flow metrics were joined")
		return nil, nil
	}
	result, err := s.flow.Flow(state.FlowQuery{
		From:      window.from,
		Until:     window.until,
		Milestone: strings.TrimSpace(snapshot.Sprint.Name),
	})
	if err != nil {
		return nil, fmt.Errorf("read report flow: %w", err)
	}
	coverage := result.Coverage
	base.Coverage.History = &coverage
	base.addSource("flux_flow", "flux_observed_flow", true)
	base.addUncertainties(coverage.Uncertainties)
	base.addUncertainties(result.Uncertainties)
	if len(result.Buckets) > window.limit {
		result.Buckets = result.Buckets[len(result.Buckets)-window.limit:]
		result.Truncated = true
		base.addUncertainty(fmt.Sprintf("report flow buckets were capped at the %d most recent buckets", window.limit))
	}
	if len(result.Uncertainties) > 20 {
		result.Uncertainties = result.Uncertainties[:20]
	}
	if result.Truncated {
		base.Truncated = true
	}
	return &result, nil
}

func (s *Service) loadContext(base *Base, snapshot domain.Snapshot, window reportWindow) (HumanContextOverlay, error) {
	overlay := HumanContextOverlay{Entries: []domain.HumanContext{}}
	if s.context == nil {
		message := "confirmed human context is unavailable; no human-reported overlay was joined"
		base.addSource("human_context", "browser_confirmed_human_reported_overlay", false, message)
		overlay.Uncertainties = []string{message}
		return overlay, nil
	}
	requestLimit := min(window.limit+1, state.MaxContextLimit)
	result, err := s.context.ListContext(state.ContextQuery{
		Since:     window.from,
		Until:     window.until,
		Milestone: strings.TrimSpace(snapshot.Sprint.Name),
		Limit:     requestLimit,
	})
	if err != nil {
		return HumanContextOverlay{}, fmt.Errorf("read report human context: %w", err)
	}
	coverage := result.Coverage
	base.Coverage.HumanContext = &coverage
	base.addSource("human_context", "browser_confirmed_human_reported_overlay", true)
	base.addUncertainties(coverage.Uncertainties)
	overlay.Provenance = coverage.Provenance
	overlay.Uncertainties = append([]string(nil), coverage.Uncertainties...)
	overlay.Entries = humanContextViews(contextForMilestone(result.Entries, snapshot.Sprint.Name))
	if len(overlay.Entries) > window.limit {
		base.Truncated = true
		overlay.Entries = overlay.Entries[:window.limit]
		message := fmt.Sprintf("human context was capped at the %d most recent entries", window.limit)
		base.addUncertainty(message)
		overlay.Uncertainties = appendUnique(overlay.Uncertainties, message)
	}
	return overlay, nil
}

func contextForMilestone(entries []domain.HumanContext, milestone string) []domain.HumanContext {
	milestone = strings.TrimSpace(milestone)
	if milestone == "" {
		return entries
	}
	result := make([]domain.HumanContext, 0, len(entries))
	for _, entry := range entries {
		if entry.Milestone != "" && strings.TrimSpace(entry.Milestone) != milestone {
			continue
		}
		result = append(result, entry)
	}
	return result
}

func humanContextViews(entries []domain.HumanContext) []domain.HumanContext {
	result := make([]domain.HumanContext, 0, len(entries))
	for _, entry := range entries {
		entry.ID = truncateText(entry.ID, 200)
		entry.Kind = domain.ContextKind(truncateText(string(entry.Kind), 100))
		entry.Status = domain.ContextStatus(truncateText(string(entry.Status), 100))
		entry.Confidence = domain.ContextConfidence(truncateText(string(entry.Confidence), 100))
		entry.AuthorSubject = truncateText(entry.AuthorSubject, 200)
		entry.Statement = truncateText(entry.Statement, 2000)
		entry.Category = truncateText(entry.Category, 200)
		entry.Milestone = truncateText(entry.Milestone, 200)
		entry.ScopeAction = truncateText(entry.ScopeAction, 200)
		entry.DecisionOwner = truncateText(entry.DecisionOwner, 200)
		entry.SourceURLs = boundedTextList(entry.SourceURLs, 5, 2048)
		entry.ItemIDs = boundedTextList(entry.ItemIDs, 20, 200)
		entry.SupersedesID = truncateText(entry.SupersedesID, 200)
		result = append(result, entry)
	}
	return result
}

func boundedTextList(values []string, limit, textLimit int) []string {
	if len(values) > limit {
		values = values[:limit]
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = append(result, truncateText(value, textLimit))
	}
	return result
}

func (s *Service) standup(snapshot domain.Snapshot, query Query) (StandupReport, error) {
	base, items, window, err := s.prepare(snapshot, KindStandup, query, standupWindow)
	if err != nil {
		return StandupReport{}, err
	}
	changes, err := s.loadChanges(&base, snapshot, window)
	if err != nil {
		return StandupReport{}, err
	}
	overlay, err := s.loadContext(&base, snapshot, window)
	if err != nil {
		return StandupReport{}, err
	}
	completed, inProgress, attention, other := partition(items)
	var truncated bool
	if completed, truncated = bounded(completed, window.limit); truncated {
		base.Truncated = true
	}
	if inProgress, truncated = bounded(inProgress, window.limit); truncated {
		base.Truncated = true
	}
	if attention, truncated = bounded(attention, window.limit); truncated {
		base.Truncated = true
	}
	if other, truncated = bounded(other, window.limit); truncated {
		base.Truncated = true
	}
	return StandupReport{
		Base:          base,
		Counts:        counts(items),
		Completed:     completed,
		InProgress:    inProgress,
		Attention:     attention,
		Other:         other,
		RecentChanges: changes,
		HumanContext:  overlay,
		Limitations: []string{
			"Standup sections report current GitLab signals; they do not infer yesterday's work or individual commitments.",
		},
	}, nil
}

func (s *Service) sprintHealth(snapshot domain.Snapshot, query Query) (SprintHealthReport, error) {
	base, items, window, err := s.prepare(snapshot, KindSprintHealth, query, sprintHealthWindow)
	if err != nil {
		return SprintHealthReport{}, err
	}
	flow, err := s.loadFlow(&base, snapshot, window)
	if err != nil {
		return SprintHealthReport{}, err
	}
	overlay, err := s.loadContext(&base, snapshot, window)
	if err != nil {
		return SprintHealthReport{}, err
	}
	_, _, attention, _ := partition(items)
	attention, truncated := bounded(attention, window.limit)
	if truncated {
		base.Truncated = true
	}
	signals, signalsTruncated := aggregateSignals(items, window.limit)
	if signalsTruncated {
		base.Truncated = true
	}
	signalState := "no_attention_signals"
	if len(attention) > 0 {
		signalState = "attention_signals_present"
	}
	return SprintHealthReport{
		Base:         base,
		Total:        len(items),
		Counts:       counts(items),
		GoalPresent:  strings.TrimSpace(snapshot.Sprint.Goal) != "",
		SignalState:  signalState,
		Signals:      signals,
		Attention:    attention,
		Flow:         flow,
		HumanContext: overlay,
		Limitations: []string{
			"Signal state is a summary of deterministic GitLab conditions, not a forecast or team-health rating.",
			"Flow metrics are observations and are not cycle time, capacity, or causal analysis.",
		},
	}, nil
}

func aggregateSignals(items []Item, limit int) ([]Signal, bool) {
	type bucket struct {
		name     string
		evidence string
		ids      []string
	}
	order := []string{"blocked", "pipeline_failing", "awaiting_review", "stale", "todo"}
	buckets := map[string]*bucket{
		"blocked":          {name: "blocked", evidence: "GitLab-derived blocked status"},
		"pipeline_failing": {name: "pipeline_failing", evidence: "open merge request pipeline failure observed in GitLab"},
		"awaiting_review":  {name: "awaiting_review", evidence: "explicit open merge request review request observed in GitLab"},
		"stale":            {name: "stale", evidence: "last GitLab activity exceeds the configured stale threshold"},
		"todo":             {name: "todo", evidence: "work item has no recorded assignee in GitLab"},
	}
	for _, item := range items {
		name := ""
		switch item.Status {
		case domain.StatusBlocked:
			name = "blocked"
		case domain.StatusPipelineFailed:
			name = "pipeline_failing"
		case domain.StatusAwaitingReview:
			name = "awaiting_review"
		case domain.StatusStale:
			name = "stale"
		case domain.StatusTodo:
			name = "todo"
		}
		if name != "" {
			buckets[name].ids = append(buckets[name].ids, item.ID)
		}
	}
	result := make([]Signal, 0, len(order))
	truncated := false
	for _, name := range order {
		bucket := buckets[name]
		if len(bucket.ids) == 0 {
			continue
		}
		itemIDs := bucket.ids
		if len(itemIDs) > limit {
			itemIDs = itemIDs[:limit]
			truncated = true
		}
		result = append(result, Signal{Name: bucket.name, Count: len(bucket.ids), ItemIDs: itemIDs, Evidence: bucket.evidence})
	}
	return result, truncated
}

func (s *Service) refinement(snapshot domain.Snapshot, query Query) (RefinementReport, error) {
	base, items, window, err := s.prepare(snapshot, KindRefinement, query, refinementWindow)
	if err != nil {
		return RefinementReport{}, err
	}
	overlay, err := s.loadContext(&base, snapshot, window)
	if err != nil {
		return RefinementReport{}, err
	}
	candidates := make([]Item, 0)
	for _, item := range items {
		if item.Status != domain.StatusDone && (item.Status == domain.StatusTodo || item.Status == domain.StatusBlocked || item.Status == domain.StatusStale || len(item.MergeRequests) == 0) {
			candidates = append(candidates, item)
		}
	}
	candidates, truncated := bounded(candidates, window.limit)
	if truncated {
		base.Truncated = true
	}
	signals, signalsTruncated := refinementSignals(items, window.limit)
	if signalsTruncated {
		base.Truncated = true
	}
	return RefinementReport{
		Base:         base,
		Candidates:   candidates,
		Signals:      signals,
		HumanContext: overlay,
		Limitations: []string{
			"Candidates are based only on status, assignment, labels, merge-request, and activity signals available in the normalized model.",
			"Issue descriptions, acceptance criteria, estimates, and dependencies are not available to Flux and were not inferred.",
			"This view identifies discussion candidates; it does not edit GitLab or declare an item ready.",
		},
	}, nil
}

func refinementSignals(items []Item, limit int) ([]Signal, bool) {
	groups := []struct {
		name     string
		evidence string
		match    func(Item) bool
	}{
		{"unassigned", "no assignee is recorded in GitLab", func(item Item) bool { return item.Assignee == "" }},
		{"no_labels_observed", "no GitLab labels are present in the normalized snapshot", func(item Item) bool { return len(item.Labels) == 0 }},
		{"no_merge_request_observed", "no linked merge request is present in the normalized snapshot", func(item Item) bool { return len(item.MergeRequests) == 0 }},
		{"blocked", "GitLab-derived blocked status", func(item Item) bool { return item.Status == domain.StatusBlocked }},
		{"stale", "last GitLab activity exceeds the configured stale threshold", func(item Item) bool { return item.Status == domain.StatusStale }},
	}
	result := make([]Signal, 0, len(groups))
	truncated := false
	for _, group := range groups {
		ids := make([]string, 0)
		for _, item := range items {
			if group.match(item) {
				ids = append(ids, item.ID)
			}
		}
		if len(ids) > 0 {
			itemIDs := ids
			if len(itemIDs) > limit {
				itemIDs = itemIDs[:limit]
				truncated = true
			}
			result = append(result, Signal{Name: group.name, Count: len(ids), ItemIDs: itemIDs, Evidence: group.evidence})
		}
	}
	return result, truncated
}

func (s *Service) planning(snapshot domain.Snapshot, query Query) (PlanningReport, error) {
	base, items, window, err := s.prepare(snapshot, KindPlanning, query, planningWindow)
	if err != nil {
		return PlanningReport{}, err
	}
	changes, err := s.loadChanges(&base, snapshot, window)
	if err != nil {
		return PlanningReport{}, err
	}
	overlay, err := s.loadContext(&base, snapshot, window)
	if err != nil {
		return PlanningReport{}, err
	}
	candidates := make([]Item, 0)
	inFlight := make([]Item, 0)
	risks := make([]Item, 0)
	for _, item := range items {
		switch item.Status {
		case domain.StatusTodo:
			candidates = append(candidates, item)
		case domain.StatusInProgress:
			inFlight = append(inFlight, item)
		}
		if attentionItem(item) && item.Status != domain.StatusTodo {
			risks = append(risks, item)
		}
	}
	var truncated bool
	if candidates, truncated = bounded(candidates, window.limit); truncated {
		base.Truncated = true
	}
	if inFlight, truncated = bounded(inFlight, window.limit); truncated {
		base.Truncated = true
	}
	if risks, truncated = bounded(risks, window.limit); truncated {
		base.Truncated = true
	}
	return PlanningReport{
		Base:           base,
		CandidateItems: candidates,
		InFlightItems:  inFlight,
		RiskItems:      risks,
		RecentChanges:  changes,
		HumanContext:   overlay,
		Limitations: []string{
			"Candidates are unstarted items already in the current GitLab milestone; Flux does not prioritize, estimate, or propose new work.",
			"Scope changes remain a human-reported overlay and do not alter the GitLab-derived candidate lists.",
		},
	}, nil
}

func (s *Service) backlog(snapshot domain.Snapshot, query Query) (BacklogReport, error) {
	base, items, window, err := s.prepare(snapshot, KindBacklog, query, backlogWindow)
	if err != nil {
		return BacklogReport{}, err
	}
	changes, err := s.loadChanges(&base, snapshot, window)
	if err != nil {
		return BacklogReport{}, err
	}
	overlay, err := s.loadContext(&base, snapshot, window)
	if err != nil {
		return BacklogReport{}, err
	}
	listed, truncated := bounded(items, window.limit)
	if truncated {
		base.Truncated = true
	}
	_, _, attention, _ := partition(items)
	unassigned := make([]Item, 0)
	for _, item := range items {
		if item.Assignee == "" {
			unassigned = append(unassigned, item)
		}
	}
	attention, attentionTruncated := bounded(attention, window.limit)
	unassigned, unassignedTruncated := bounded(unassigned, window.limit)
	if attentionTruncated || unassignedTruncated {
		base.Truncated = true
	}
	buckets := backlogBuckets(items, window.limit)
	return BacklogReport{
		Base:          base,
		Total:         len(items),
		Counts:        counts(items),
		Buckets:       buckets,
		Items:         listed,
		Unassigned:    unassigned,
		Attention:     attention,
		RecentChanges: changes,
		HumanContext:  overlay,
		Limitations: []string{
			"This is the current cached GitLab milestone scope, not a complete group backlog outside that milestone.",
			"Items and lists are bounded; truncation and history coverage must be checked before treating the view as complete.",
		},
	}, nil
}

func backlogBuckets(items []Item, limit int) []BacklogBucket {
	order := []domain.Status{
		domain.StatusTodo,
		domain.StatusInProgress,
		domain.StatusAwaitingReview,
		domain.StatusPipelineFailed,
		domain.StatusBlocked,
		domain.StatusStale,
		domain.StatusDone,
	}
	result := make([]BacklogBucket, 0, len(order))
	for _, status := range order {
		ids := make([]string, 0)
		for _, item := range items {
			if item.Status == status {
				ids = append(ids, item.ID)
			}
		}
		if len(ids) == 0 {
			continue
		}
		count := len(ids)
		if len(ids) > limit {
			ids = ids[:limit]
		}
		result = append(result, BacklogBucket{Status: status, Count: count, ItemIDs: ids})
	}
	return result
}

func (s *Service) retrospective(snapshot domain.Snapshot, query Query) (RetrospectiveReport, error) {
	base, _, window, err := s.prepare(snapshot, KindRetrospective, query, retrospectiveWindow)
	if err != nil {
		return RetrospectiveReport{}, err
	}
	flow, err := s.loadFlow(&base, snapshot, window)
	if err != nil {
		return RetrospectiveReport{}, err
	}
	changes, err := s.loadChanges(&base, snapshot, window)
	if err != nil {
		return RetrospectiveReport{}, err
	}
	overlay, err := s.loadContext(&base, snapshot, window)
	if err != nil {
		return RetrospectiveReport{}, err
	}
	return RetrospectiveReport{
		Base:            base,
		Flow:            flow,
		ObservedChanges: changes,
		Signals:         retrospectiveSignals(flow),
		HumanContext:    overlay,
		Limitations: []string{
			"Flow and changes are observations made by Flux during the selected window; they do not reconstruct missed history.",
			"Flux does not infer cycle time, capacity, causal themes, blame, or performance from these records.",
		},
	}, nil
}

func retrospectiveSignals(flow *state.FlowResult) []Signal {
	if flow == nil {
		return []Signal{}
	}
	values := []struct {
		name     string
		count    int
		evidence string
	}{
		{"observed_changes", flow.Changes, "Flux-observed work-item changes"},
		{"added", flow.Added, "Flux-observed additions"},
		{"started", flow.Started, "Flux-observed transitions into active work"},
		{"completed", flow.Completed, "Flux-observed completions or merged work"},
		{"reopened", flow.Reopened, "Flux-observed reopen transitions"},
		{"blocked", flow.Blocked, "Flux-observed transitions into blocked status"},
		{"unblocked", flow.Unblocked, "Flux-observed transitions out of blocked status"},
		{"status_transitions", flow.StatusTransitions, "Flux-observed derived status transitions"},
	}
	result := make([]Signal, 0, len(values))
	for _, value := range values {
		if value.count > 0 {
			result = append(result, Signal{Name: value.name, Count: value.count, Evidence: value.evidence})
		}
	}
	return result
}

func (b *Base) addSource(name, provenance string, available bool, uncertainties ...string) {
	for index := range b.Coverage.Sources {
		if b.Coverage.Sources[index].Name != name {
			continue
		}
		if available {
			b.Coverage.Sources[index].Available = true
		}
		b.Coverage.Sources[index].Provenance = provenance
		for _, uncertainty := range uncertainties {
			b.Coverage.Sources[index].Uncertainties = appendUnique(b.Coverage.Sources[index].Uncertainties, uncertainty)
		}
		return
	}
	b.Coverage.Sources = append(b.Coverage.Sources, SourceCoverage{
		Name:          name,
		Provenance:    provenance,
		Available:     available,
		Uncertainties: uniqueStrings(uncertainties),
	})
	for _, uncertainty := range uncertainties {
		b.addUncertainty(uncertainty)
	}
}

func (b *Base) addUncertainties(values []string) {
	for _, value := range values {
		b.addUncertainty(value)
	}
}

func (b *Base) addUncertainty(value string) {
	value = strings.TrimSpace(value)
	if value != "" {
		b.Coverage.Uncertainties = appendUnique(b.Coverage.Uncertainties, value)
	}
}

func uniqueStrings(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = appendUnique(result, value)
	}
	return result
}

func appendUnique(values []string, value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return values
	}
	if slices.Contains(values, value) {
		return values
	}
	return append(values, value)
}

func truncateText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}

func timePointer(value time.Time) *time.Time {
	value = value.UTC()
	return &value
}
