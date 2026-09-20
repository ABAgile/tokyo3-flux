package store

import (
	"context"
	"errors"
	"slices"
	"testing"

	p "abagile.com/tokyo3/flux/internal/planning"
)

// Archived work is excluded from the board payload, so the archive page is the
// only way a browser reaches it. Paging must be stable and bounded, and the
// page must carry the associations and attachments a card needs to render.
func TestArchivedItemsPaging(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	b := bootstrap(t, s)
	titles := []string{"first", "second", "third"}
	for _, title := range titles {
		item := newItem(b, title)
		apply(t, s, &b, p.Command{Kind: "item.create", Item: &item})
	}
	live := newItem(b, "still live")
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &live})
	archived := []string{}
	for _, item := range b.Items {
		if item.Title == "still live" {
			continue
		}
		apply(t, s, &b, p.Command{Kind: "item.archive", Target: item.ID})
		archived = append(archived, item.ID)
	}

	// The board keeps only the live working set.
	if ids := liveItemIDs(p.BrowserBoard(b)); len(ids) != 1 {
		t.Fatalf("board still carries archived work: %v", ids)
	}

	all, err := s.ArchivedItems(ctx, b.Workspace.ID, "alice", 0, p.ArchivePageLimit)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != len(archived) {
		t.Fatalf("archive page = %d items, want %d", len(all), len(archived))
	}
	for _, item := range all {
		if !item.Archived {
			t.Errorf("archive page returned live item %q", item.ID)
		}
		if len(item.Labels) != 1 || item.Labels[0] != "native" {
			t.Errorf("archived item %q lost its labels: %v", item.ID, item.Labels)
		}
		if item.Attachments == nil {
			t.Errorf("archived item %q has a nil attachment slice", item.ID)
		}
	}

	// Paging must partition the same ordering without gaps or repeats.
	seen := []string{}
	for offset := 0; offset < len(archived); offset++ {
		page, pageErr := s.ArchivedItems(ctx, b.Workspace.ID, "alice", offset, 1)
		if pageErr != nil || len(page) != 1 {
			t.Fatalf("offset %d: %v (%d items)", offset, pageErr, len(page))
		}
		seen = append(seen, page[0].ID)
	}
	if !slices.Equal(seen, itemIDs(all)) {
		t.Errorf("paged order %v does not match single page %v", seen, itemIDs(all))
	}

	// Reading past the end is an empty page, not an error.
	past, err := s.ArchivedItems(ctx, b.Workspace.ID, "alice", len(archived)+5, 10)
	if err != nil || len(past) != 0 {
		t.Fatalf("page past the end: %v (%d items)", err, len(past))
	}

	// Bounds and membership are enforced by the store, not only the handler.
	for _, bad := range [][2]int{{-1, 10}, {0, 0}, {0, -1}, {0, p.ArchivePageLimit + 1}} {
		if _, err = s.ArchivedItems(ctx, b.Workspace.ID, "alice", bad[0], bad[1]); !errors.Is(err, p.ErrInvalid) {
			t.Errorf("offset=%d limit=%d accepted: %v", bad[0], bad[1], err)
		}
	}
	if _, err = s.ArchivedItems(ctx, b.Workspace.ID, "mallory", 0, 10); !errors.Is(err, p.ErrForbidden) {
		t.Errorf("non-member archive read: %v", err)
	}
}

func itemIDs(items []p.Item) []string {
	out := make([]string, len(items))
	for i, item := range items {
		out[i] = item.ID
	}
	return out
}

func liveItemIDs(b p.Board) []string {
	out := []string{}
	for _, item := range b.Items {
		if !item.Archived {
			out = append(out, item.ID)
		}
	}
	return out
}
