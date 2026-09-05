package domain

import "time"

// Snapshot is the normalized input used by the status view. GitLab adapters
// will populate this model without exposing GitLab's API shapes to the rest of
// the application.
type Snapshot struct {
	GeneratedAt time.Time `json:"generated_at"`
	Sprint      Sprint    `json:"sprint"`
}

// Sprint contains the work currently being coordinated.
type Sprint struct {
	Name      string     `json:"name"`
	Goal      string     `json:"goal"`
	WorkItems []WorkItem `json:"work_items"`
}

// WorkItem is the small, normalized unit used by Flux's first status view.
type WorkItem struct {
	ID            string         `json:"id"`
	ProjectID     int            `json:"project_id,omitempty"`
	ProjectPath   string         `json:"project_path,omitempty"`
	Title         string         `json:"title"`
	State         IssueState     `json:"state"`
	Assignee      string         `json:"assignee"`
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
