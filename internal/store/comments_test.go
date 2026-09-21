package store

import (
	"context"
	"errors"
	"testing"

	p "abagile.com/tokyo3/flux/internal/planning"
)

func TestPostgresItemCommentsAreSeparateAppendOnlyStream(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	ctx := context.Background()
	item := newItem(b, "Commented item")
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &item})
	item = b.Items[0]
	beforeRevision := b.Workspace.Revision
	beforeHistory, err := s.History(ctx, b.Workspace.ID, "alice", 0)
	if err != nil {
		t.Fatal(err)
	}
	var beforeAudits int
	if err = s.pool.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE workspace_id=$1", b.Workspace.ID).Scan(&beforeAudits); err != nil {
		t.Fatal(err)
	}

	key := p.NewID()
	created, err := s.AddComment(ctx, b.Workspace.ID, "alice", item.ID, key, "Team context")
	if err != nil {
		t.Fatal(err)
	}
	if created.ID == 0 || created.ItemID != item.ID || created.Author != "alice" || created.Body != "Team context" || created.CreatedAt.IsZero() {
		t.Fatalf("invalid comment: %+v", created)
	}
	retried, err := s.AddComment(ctx, b.Workspace.ID, "alice", item.ID, key, "Team context")
	if err != nil || retried.ID != created.ID {
		t.Fatalf("idempotent comment retry: %+v %v", retried, err)
	}
	if _, err = s.AddComment(ctx, b.Workspace.ID, "alice", item.ID, key, "Different context"); !errors.Is(err, p.ErrConflict) {
		t.Fatalf("idempotency key reuse: %v", err)
	}

	comments, err := s.Comments(ctx, b.Workspace.ID, "alice", item.ID)
	if err != nil || len(comments) != 1 || comments[0].ID != created.ID {
		t.Fatalf("comments: %+v %v", comments, err)
	}
	current, err := s.Board(ctx, b.Workspace.ID, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if current.Workspace.Revision != beforeRevision {
		t.Fatalf("comment changed planning revision: %d -> %d", beforeRevision, current.Workspace.Revision)
	}
	afterHistory, err := s.History(ctx, b.Workspace.ID, "alice", 0)
	if err != nil || len(afterHistory) != len(beforeHistory) {
		t.Fatalf("comment entered planning history: %+v %v", afterHistory, err)
	}
	var afterAudits int
	if err = s.pool.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE workspace_id=$1", b.Workspace.ID).Scan(&afterAudits); err != nil {
		t.Fatal(err)
	}
	if afterAudits != beforeAudits {
		t.Fatalf("comment entered planning audit: %d -> %d", beforeAudits, afterAudits)
	}
	if _, err = s.pool.Exec(ctx, "UPDATE item_comments SET body='mutated' WHERE id=$1", created.ID); err == nil {
		t.Fatal("comment update accepted")
	}
	if _, err = s.pool.Exec(ctx, "DELETE FROM item_comments WHERE id=$1", created.ID); err == nil {
		t.Fatal("comment delete accepted")
	}
}

func TestPostgresCommentCursorPagesRecentHistory(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	ctx := context.Background()
	item := newItem(b, "Paged comments")
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &item})
	item = b.Items[0]
	for i := 1; i <= 5; i++ {
		if _, err := s.AddComment(ctx, b.Workspace.ID, "alice", item.ID, p.NewID(), string(rune('0'+i))); err != nil {
			t.Fatal(err)
		}
	}
	page, err := s.CommentPage(ctx, b.Workspace.ID, "alice", item.ID, 0, 2)
	if err != nil || len(page.Comments) != 2 || page.Comments[0].Body != "4" || page.Comments[1].Body != "5" || page.NextBefore == 0 {
		t.Fatalf("latest page = %+v, %v", page, err)
	}
	page, err = s.CommentPage(ctx, b.Workspace.ID, "alice", item.ID, page.NextBefore, 2)
	if err != nil || len(page.Comments) != 2 || page.Comments[0].Body != "2" || page.Comments[1].Body != "3" || page.NextBefore == 0 {
		t.Fatalf("middle page = %+v, %v", page, err)
	}
	page, err = s.CommentPage(ctx, b.Workspace.ID, "alice", item.ID, page.NextBefore, 2)
	if err != nil || len(page.Comments) != 1 || page.Comments[0].Body != "1" || page.NextBefore != 0 {
		t.Fatalf("oldest page = %+v, %v", page, err)
	}
}

func TestPostgresOnlyPlanningMembersCanAddComments(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	ctx := context.Background()
	item := newItem(b, "Permission comment")
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &item})
	item = b.Items[0]
	if err := s.SetMember(ctx, b.Workspace.ID, "reader", "viewer"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Comments(ctx, b.Workspace.ID, "reader", item.ID); err != nil {
		t.Fatalf("viewer cannot read comments: %v", err)
	}
	if _, err := s.AddComment(ctx, b.Workspace.ID, "reader", item.ID, p.NewID(), "Viewer comment"); !errors.Is(err, p.ErrForbidden) {
		t.Fatalf("viewer comment accepted: %v", err)
	}
}
