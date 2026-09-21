package store

import (
	"context"
	"errors"
	"testing"

	p "abagile.com/tokyo3/flux/internal/planning"
)

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
