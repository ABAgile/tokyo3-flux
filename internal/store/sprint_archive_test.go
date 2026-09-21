package store

import (
	"context"
	"errors"
	"testing"

	p "abagile.com/tokyo3/flux/internal/planning"
)

func TestArchivedSprintHistoryPaging(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	apply(t, s, &b, p.Command{Kind: "sprint.save", Sprint: &p.Sprint{Name: "History", Goal: "Capture delivery", Start: "2026-09-01", End: "2026-09-14"}})
	sprintID := b.Sprints[len(b.Sprints)-1].ID
	apply(t, s, &b, p.Command{Kind: "sprint.start", Target: sprintID})
	item := newItem(b, "Carry")
	item.SprintIDs = []string{sprintID}
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &item})
	completed := newItem(b, "Complete")
	completed.SprintIDs = []string{sprintID}
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &completed})
	var completedID string
	for _, candidate := range b.Items {
		if candidate.Title == completed.Title {
			completedID = candidate.ID
		}
	}
	apply(t, s, &b, p.Command{Kind: "item.move", Target: completedID, Destination: b.Columns[len(b.Columns)-1].ID})
	apply(t, s, &b, p.Command{Kind: "sprint.close", Target: sprintID, Reason: "Record the outcome"})
	apply(t, s, &b, p.Command{Kind: "sprint.archive", Target: sprintID})

	page, err := s.ArchivedSprints(context.Background(), b.Workspace.ID, "alice", 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Records) != 1 || page.NextOffset != nil {
		t.Fatalf("history page = %+v", page)
	}
	record := page.Records[0]
	if record.Sprint.ID != sprintID || record.Sprint.State != "archived" || len(record.Closure.Scope) != 2 || record.Closure.ScopeCount != 2 || record.Closure.CompletedCount != 1 || record.Closure.CarryOverCount != 0 || record.Closure.ClosedAt.IsZero() {
		t.Fatalf("history record = %+v", record)
	}
	if len(p.BrowserBoard(b).Sprints) != 0 {
		t.Fatalf("archived sprint remained on browser board: %+v", p.BrowserBoard(b).Sprints)
	}
	if _, err = s.ArchivedSprints(context.Background(), b.Workspace.ID, "alice", 0, p.SprintArchivePageLimit+1); !errors.Is(err, p.ErrInvalid) {
		t.Fatalf("oversized history page accepted: %v", err)
	}
	if _, err = s.ArchivedSprints(context.Background(), b.Workspace.ID, "mallory", 0, 1); !errors.Is(err, p.ErrForbidden) {
		t.Fatalf("non-member history read: %v", err)
	}
}
