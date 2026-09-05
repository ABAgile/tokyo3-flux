package domain

import (
	"testing"
	"time"
)

func TestDeriveStatus(t *testing.T) {
	now := time.Date(2026, time.January, 12, 12, 0, 0, 0, time.UTC)
	staleAfter := 7 * 24 * time.Hour

	tests := []struct {
		name string
		item WorkItem
		want Status
	}{
		{
			name: "closed issue is done",
			item: WorkItem{State: IssueClosed},
			want: StatusDone,
		},
		{
			name: "merged request is done",
			item: WorkItem{
				State:         IssueOpen,
				MergeRequests: []MergeRequest{{State: MergeRequestMerged}},
			},
			want: StatusDone,
		},
		{
			name: "blocked takes priority",
			item: WorkItem{
				State:    IssueOpen,
				Blocked:  true,
				Assignee: "dev",
				MergeRequests: []MergeRequest{{
					State:    MergeRequestOpen,
					Pipeline: PipelineFailed,
				}},
			},
			want: StatusBlocked,
		},
		{
			name: "failed pipeline",
			item: WorkItem{
				State:    IssueOpen,
				Assignee: "dev",
				MergeRequests: []MergeRequest{{
					State:    MergeRequestOpen,
					Pipeline: PipelineFailed,
				}},
			},
			want: StatusPipelineFailed,
		},
		{
			name: "review request",
			item: WorkItem{
				State:    IssueOpen,
				Assignee: "dev",
				MergeRequests: []MergeRequest{{
					State:           MergeRequestOpen,
					ReviewRequested: true,
				}},
			},
			want: StatusAwaitingReview,
		},
		{
			name: "draft request is not awaiting review",
			item: WorkItem{
				State:    IssueOpen,
				Assignee: "dev",
				MergeRequests: []MergeRequest{{
					State:           MergeRequestOpen,
					Draft:           true,
					ReviewRequested: true,
				}},
			},
			want: StatusInProgress,
		},
		{
			name: "stale work",
			item: WorkItem{
				State:        IssueOpen,
				Assignee:     "dev",
				LastActivity: now.Add(-staleAfter),
			},
			want: StatusStale,
		},
		{
			name: "unassigned work is todo",
			item: WorkItem{State: IssueOpen, LastActivity: now.Add(-time.Hour)},
			want: StatusTodo,
		},
		{
			name: "assigned work is in progress",
			item: WorkItem{
				State:        IssueOpen,
				Assignee:     "dev",
				LastActivity: now.Add(-time.Hour),
			},
			want: StatusInProgress,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := DeriveStatus(test.item, now, staleAfter); got != test.want {
				t.Fatalf("DeriveStatus() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestSummarizeAndCount(t *testing.T) {
	now := time.Date(2026, time.January, 12, 12, 0, 0, 0, time.UTC)
	summary := Summarize(Sprint{WorkItems: []WorkItem{
		{State: IssueClosed},
		{State: IssueOpen, Blocked: true},
		{State: IssueOpen, Assignee: "dev"},
	}}, now, 7*24*time.Hour)

	if got, want := summary.Total(), 3; got != want {
		t.Fatalf("Total() = %d, want %d", got, want)
	}
	if got, want := summary.Count(StatusDone), 1; got != want {
		t.Fatalf("Count(done) = %d, want %d", got, want)
	}
	if got, want := summary.Count(StatusBlocked), 1; got != want {
		t.Fatalf("Count(blocked) = %d, want %d", got, want)
	}
}
