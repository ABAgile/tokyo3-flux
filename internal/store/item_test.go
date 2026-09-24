package store

import (
	"context"
	"errors"
	"testing"

	p "abagile.com/tokyo3/flux/internal/planning"
)

func TestItemDatesPersistAndClear(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	b := bootstrap(t, s)
	item := newItem(b, "dated card")
	item.StartDate, item.EndDate, item.DueDate = "2026-03-01", "2026-03-20", "2026-02-28"
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &item})
	var saved p.Item
	for _, candidate := range b.Items {
		if candidate.Title == item.Title {
			saved = candidate
			break
		}
	}
	if saved.ID == "" || saved.StartDate != item.StartDate || saved.EndDate != item.EndDate || saved.DueDate != item.DueDate {
		t.Fatalf("board lost item dates: %+v", saved)
	}
	live, err := s.Item(ctx, b.Workspace.ID, "alice", saved.ID)
	if err != nil || live.Item.StartDate != item.StartDate || live.Item.EndDate != item.EndDate || live.Item.DueDate != item.DueDate {
		t.Fatalf("single-item read lost dates: %+v (%v)", live.Item, err)
	}
	constraintTx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = constraintTx.Exec(ctx, "UPDATE work_items SET end_date='2026-02-28' WHERE workspace_id=$1 AND id=$2", b.Workspace.ID, saved.ID); err == nil {
		_ = constraintTx.Rollback(ctx)
		t.Fatal("database accepted an end date before the start date")
	}
	_ = constraintTx.Rollback(ctx)

	live.Item.DueDate = ""
	apply(t, s, &b, p.Command{Kind: "item.update", Target: saved.ID, Item: &live.Item})
	for _, candidate := range b.Items {
		if candidate.ID == saved.ID && (candidate.StartDate != item.StartDate || candidate.EndDate != item.EndDate || candidate.DueDate != "") {
			t.Fatalf("item date update = %+v", candidate)
		}
	}
	var dueDateIsNull bool
	if err := s.pool.QueryRow(ctx, "SELECT due_date IS NULL FROM work_items WHERE workspace_id=$1 AND id=$2", b.Workspace.ID, saved.ID).Scan(&dueDateIsNull); err != nil || !dueDateIsNull {
		t.Fatalf("cleared due date is NULL = %t: %v", dueDateIsNull, err)
	}

	apply(t, s, &b, p.Command{Kind: "item.archive", Target: saved.ID})
	archived, err := s.Item(ctx, b.Workspace.ID, "alice", saved.ID)
	if err != nil || !archived.Item.Archived || archived.Item.StartDate != item.StartDate || archived.Item.EndDate != item.EndDate || archived.Item.DueDate != "" {
		t.Fatalf("archived item dates = %+v (%v)", archived.Item, err)
	}
	page, err := s.ArchivedItems(ctx, b.Workspace.ID, "alice", 0, p.ArchivePageLimit)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, candidate := range page {
		if candidate.ID == saved.ID {
			found = true
			if candidate.StartDate != item.StartDate || candidate.EndDate != item.EndDate || candidate.DueDate != "" {
				t.Fatalf("archive page lost item dates: %+v", candidate)
			}
		}
	}
	if !found {
		t.Fatal("dated item missing from archive page")
	}
}

// A shared card link resolves one card by identity. It must survive archiving
// and restoring, must never depend on archive paging, and must refuse readers
// outside the workspace.
func TestItemResolvesAcrossArchiveTransitions(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	b := bootstrap(t, s)
	item := newItem(b, "shared card")
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &item})
	id := ""
	for _, candidate := range b.Items {
		if candidate.Title == "shared card" {
			id = candidate.ID
		}
	}
	if id == "" {
		t.Fatal("created card is missing from the board")
	}

	live, err := s.Item(ctx, b.Workspace.ID, "alice", id)
	if err != nil {
		t.Fatal(err)
	}
	if live.Item.ID != id || live.Item.Archived || live.Item.Title != "shared card" {
		t.Fatalf("unexpected live card: %+v", live.Item)
	}
	if live.Role != "admin" || live.Revision != b.Workspace.Revision {
		t.Fatalf("role %q revision %d, want admin and %d", live.Role, live.Revision, b.Workspace.Revision)
	}
	if live.Item.Attachments == nil {
		t.Error("nil attachment slice")
	}

	apply(t, s, &b, p.Command{Kind: "item.archive", Target: id})
	archived, err := s.Item(ctx, b.Workspace.ID, "alice", id)
	if err != nil {
		t.Fatal(err)
	}
	if !archived.Item.Archived || archived.Item.Title != "shared card" {
		t.Fatalf("archived card not resolvable: %+v", archived.Item)
	}
	if archived.Revision != b.Workspace.Revision {
		t.Errorf("archived revision %d, want %d", archived.Revision, b.Workspace.Revision)
	}

	apply(t, s, &b, p.Command{Kind: "item.restore", Target: id})
	restored, err := s.Item(ctx, b.Workspace.ID, "alice", id)
	if err != nil || restored.Item.Archived {
		t.Fatalf("restored card: %+v (%v)", restored.Item, err)
	}

	if _, err = s.Item(ctx, b.Workspace.ID, "alice", "missing"); !errors.Is(err, p.ErrNotFound) {
		t.Errorf("unknown card: %v", err)
	}
	if _, err = s.Item(ctx, b.Workspace.ID, "mallory", id); !errors.Is(err, p.ErrForbidden) {
		t.Errorf("non-member card read: %v", err)
	}
}
