package domain

import "time"

// ContextKind identifies the two initial human-provided delivery context
// records. They are an overlay on GitLab-derived state, not another source of
// issue status.
type ContextKind string

const (
	ContextKindDelayExplanation ContextKind = "delay_explanation"
	ContextKindScopeChange      ContextKind = "scope_change"
)

// ContextStatus identifies the lifecycle state visible to read-only clients.
type ContextStatus string

const (
	ContextStatusProposed   ContextStatus = "proposed"
	ContextStatusConfirmed  ContextStatus = "confirmed"
	ContextStatusSuperseded ContextStatus = "superseded"
	ContextStatusRedacted   ContextStatus = "redacted"
)

// ContextConfidence identifies how an entry may be used by reports.
type ContextConfidence string

const (
	ContextConfidenceConfirmed ContextConfidence = "confirmed"
	ContextConfidenceReported  ContextConfidence = "reported"
	ContextConfidenceProposed  ContextConfidence = "proposed"
)

// HumanContext is an authenticated human's explanation or scope decision. It
// is intentionally separate from WorkItem so it cannot alter GitLab-derived
// status, counts, or historical revisions.
type HumanContext struct {
	ID             string            `json:"id"`
	Revision       int               `json:"revision"`
	Kind           ContextKind       `json:"kind"`
	Status         ContextStatus     `json:"status"`
	Confidence     ContextConfidence `json:"confidence"`
	CreatedAt      time.Time         `json:"created_at"`
	UpdatedAt      time.Time         `json:"updated_at"`
	AuthorSubject  string            `json:"author_subject,omitempty"`
	ContentHash    string            `json:"content_hash,omitempty"`
	Statement      string            `json:"statement"`
	Category       string            `json:"category"`
	ItemIDs        []string          `json:"item_ids,omitempty"`
	Milestone      string            `json:"milestone,omitempty"`
	ScopeAction    string            `json:"scope_action,omitempty"`
	DecisionOwner  string            `json:"decision_owner,omitempty"`
	ReportingFrom  *time.Time        `json:"reporting_from,omitempty"`
	ReportingUntil *time.Time        `json:"reporting_until,omitempty"`
	EffectiveAt    *time.Time        `json:"effective_at,omitempty"`
	SourceURLs     []string          `json:"source_urls,omitempty"`
	SupersedesID   string            `json:"supersedes_id,omitempty"`
}
