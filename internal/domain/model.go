package domain

import "time"

// Snapshot is the normalized input used by the status view. GitLab adapters
// will populate this model without exposing GitLab's API shapes to the rest of
// the application.
type Snapshot struct {
	GeneratedAt time.Time `json:"generated_at"`
	Sprint      Sprint    `json:"sprint"`
}

// SyncState describes the state of a pull reconciliation attempt.
type SyncState string

const (
	SyncStateIdle    SyncState = "idle"
	SyncStateQueued  SyncState = "queued"
	SyncStateSyncing SyncState = "syncing"
	SyncStateReady   SyncState = "ready"
	SyncStateError   SyncState = "error"
)

// SyncStatus is operational metadata for the pull reconciler. It describes
// attempts, not the source of truth; the snapshot remains the useful state.
type SyncStatus struct {
	State           SyncState
	LastStartedAt   time.Time
	LastCompletedAt time.Time
	LastDuration    time.Duration
	LastError       string
}

// SyncRun is durable provenance for one pull attempt. SourceWatermark is the
// greatest source-side activity timestamp observed in a successful snapshot;
// it is a watermark, not proof that an incremental endpoint was used.
type SyncRun struct {
	ID                  string     `json:"id"`
	Target              string     `json:"target"`
	Mode                string     `json:"mode"`
	FullScan            bool       `json:"full_scan"`
	Status              string     `json:"status"`
	StartedAt           time.Time  `json:"started_at"`
	CompletedAt         time.Time  `json:"completed_at"`
	ObservedAt          *time.Time `json:"observed_at,omitempty"`
	SnapshotGeneratedAt *time.Time `json:"snapshot_generated_at,omitempty"`
	RequestedAfter      *time.Time `json:"requested_after,omitempty"`
	SourceWatermark     *time.Time `json:"source_watermark,omitempty"`
	ItemCount           int        `json:"item_count"`
	Coverage            string     `json:"coverage"`
	Error               string     `json:"error,omitempty"`
}

// Sprint contains the work currently being coordinated.
type Sprint struct {
	Name      string     `json:"name"`
	Goal      string     `json:"goal"`
	WorkItems []WorkItem `json:"work_items"`
}

// Milestone describes an active GitLab milestone available to the cockpit.
type Milestone struct {
	Name      string `json:"name"`
	Goal      string `json:"goal,omitempty"`
	State     string `json:"state"`
	StartDate string `json:"start_date,omitempty"`
	DueDate   string `json:"due_date,omitempty"`
}

// WorkItem is the small, normalized unit used by Flux's first status view.
type WorkItem struct {
	ID            string         `json:"id"`
	ProjectID     int            `json:"project_id,omitempty"`
	ProjectPath   string         `json:"project_path,omitempty"`
	Title         string         `json:"title"`
	State         IssueState     `json:"state"`
	Assignee      string         `json:"assignee"`
	Labels        []string       `json:"labels,omitempty"`
	Blocked       bool           `json:"blocked"`
	LastActivity  time.Time      `json:"last_activity"`
	MergeRequests []MergeRequest `json:"merge_requests"`
}

// IssueState is the lifecycle state of a GitLab issue.
type IssueState string

const (
	IssueOpen   IssueState = "open"
	IssueClosed IssueState = "closed"
)

// MergeRequest describes the delivery state linked to a work item.
type MergeRequest struct {
	ID              string            `json:"id"`
	Title           string            `json:"title"`
	State           MergeRequestState `json:"state"`
	Draft           bool              `json:"draft"`
	ReviewRequested bool              `json:"review_requested"`
	Pipeline        PipelineStatus    `json:"pipeline"`
}

// MergeRequestState is the lifecycle state of a merge request.
type MergeRequestState string

const (
	MergeRequestOpen   MergeRequestState = "open"
	MergeRequestClosed MergeRequestState = "closed"
	MergeRequestMerged MergeRequestState = "merged"
)

// PipelineStatus is the latest relevant pipeline state.
type PipelineStatus string

const (
	PipelineUnknown  PipelineStatus = ""
	PipelinePending  PipelineStatus = "pending"
	PipelineRunning  PipelineStatus = "running"
	PipelineSuccess  PipelineStatus = "success"
	PipelineFailed   PipelineStatus = "failed"
	PipelineCanceled PipelineStatus = "canceled"
)
