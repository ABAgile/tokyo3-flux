package domain

import "time"

// Status is a deterministic, human-readable delivery signal. It is derived
// from GitLab state and does not represent an AI guess.
type Status string

const (
	StatusTodo           Status = "todo"
	StatusInProgress     Status = "in progress"
	StatusAwaitingReview Status = "awaiting review"
	StatusPipelineFailed Status = "pipeline failing"
	StatusBlocked        Status = "blocked"
	StatusStale          Status = "stale"
	StatusDone           Status = "done"
)

func (s Status) String() string {
	return string(s)
}

// DeriveStatus applies the priority order used by the first Flux cockpit.
// More urgent conditions take precedence over ordinary progress signals.
func DeriveStatus(item WorkItem, now time.Time, staleAfter time.Duration) Status {
	if item.State == IssueClosed || hasMergedRequest(item) {
		return StatusDone
	}
	if item.Blocked {
		return StatusBlocked
	}
	if hasFailedOpenRequest(item) {
		return StatusPipelineFailed
	}
	if hasReviewRequest(item) {
		return StatusAwaitingReview
	}
	if isStale(item.LastActivity, now, staleAfter) {
		return StatusStale
	}
	if item.Assignee == "" {
		return StatusTodo
	}
	return StatusInProgress
}

func hasMergedRequest(item WorkItem) bool {
	for _, request := range item.MergeRequests {
		if request.State == MergeRequestMerged {
			return true
		}
	}
	return false
}

func hasFailedOpenRequest(item WorkItem) bool {
	for _, request := range item.MergeRequests {
		if request.State == MergeRequestOpen && request.Pipeline == PipelineFailed {
			return true
		}
	}
	return false
}

func hasReviewRequest(item WorkItem) bool {
	for _, request := range item.MergeRequests {
		if request.State == MergeRequestOpen && request.ReviewRequested && !request.Draft {
			return true
		}
	}
	return false
}

func isStale(lastActivity, now time.Time, threshold time.Duration) bool {
	if threshold <= 0 || lastActivity.IsZero() || now.Before(lastActivity) {
		return false
	}
	return now.Sub(lastActivity) >= threshold
}
