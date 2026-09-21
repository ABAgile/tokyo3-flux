package store

import (
	"context"
	"slices"
	"testing"

	p "abagile.com/tokyo3/flux/internal/planning"
)

// A board read must already know who is involved with every card: assignment
// and comment authorship, aggregated once, without a per-card request and
// without a comment changing planning state.
func TestBoardCarriesCardParticipants(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	b := bootstrap(t, s)
	if err := s.SetMember(ctx, b.Workspace.ID, "bob", "member"); err != nil {
		t.Fatal(err)
	}
	item := newItem(b, "Discussed card")
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &item})
	id := b.Items[0].ID
	revision := b.Workspace.Revision
	for _, author := range []string{"bob", "alice", "bob"} {
		if _, err := s.AddComment(ctx, b.Workspace.ID, author, id, p.NewID(), "context from "+author); err != nil {
			t.Fatal(err)
		}
	}

	board := getBoard(t, s, b.Workspace.ID)
	if board.Workspace.Revision != revision {
		t.Errorf("commenting moved the workspace revision to %d, want %d", board.Workspace.Revision, revision)
	}
	participants := []p.Participant{}
	for _, participant := range board.Participants {
		if participant.ItemID == id {
			participants = append(participants, participant)
		}
	}
	if len(participants) != 2 {
		t.Fatalf("participants = %+v, want the assignee and the other commenter", participants)
	}
	if participants[0].Subject != "alice" || !slices.Equal(participants[0].Roles, []string{p.RoleAssignee, p.RoleCommenter}) {
		t.Errorf("assignee is not first with merged roles: %+v", participants[0])
	}
	if participants[1].Subject != "bob" || !slices.Equal(participants[1].Roles, []string{p.RoleCommenter}) {
		t.Errorf("commenter is missing: %+v", participants[1])
	}
}
