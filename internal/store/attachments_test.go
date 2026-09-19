package store

import (
	"context"
	"errors"
	"strings"
	"testing"

	p "abagile.com/tokyo3/flux/internal/planning"
)

// A board read must describe attachment presence without carrying metadata,
// and the per-card read must supply it without leaking the storage key's role
// as an authorization-free handle.
func TestPostgresBoardReportsAttachmentCountsOnly(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	b := bootstrap(t, s)
	item := newItem(b, "Card with files")
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &item})
	id := b.Items[0].ID

	if b.Items[0].AttachmentCount != 0 || len(b.Items[0].Attachments) != 0 {
		t.Fatalf("new card reports attachments: %d", b.Items[0].AttachmentCount)
	}
	listed, err := s.Attachments(ctx, b.Workspace.ID, "alice", id)
	if err != nil || len(listed) != 0 {
		t.Fatalf("empty listing: %v %d", err, len(listed))
	}

	digest := "sha256:" + strings.Repeat("a", 64)
	for _, name := range []string{"one.txt", "two.txt"} {
		if _, err = s.AddAttachment(ctx, b.Workspace.ID, "alice", id, p.NewID(), strings.Repeat("k", 20)+name,
			p.Attachment{Name: name, ContentType: "text/plain", Size: 3, Digest: digest}); err != nil {
			t.Fatal(err)
		}
	}

	b = getBoard(t, s, b.Workspace.ID)
	if b.Items[0].AttachmentCount != 2 {
		t.Fatalf("board count %d", b.Items[0].AttachmentCount)
	}
	if len(b.Items[0].Attachments) != 0 {
		t.Fatal("board still carries attachment metadata")
	}
	listed, err = s.Attachments(ctx, b.Workspace.ID, "alice", id)
	if err != nil || len(listed) != 2 {
		t.Fatalf("listing: %v %d", err, len(listed))
	}
	if listed[0].ID >= listed[1].ID {
		t.Fatal("listing is not ordered by identity")
	}
	for _, attachment := range listed {
		if attachment.ItemID != id || attachment.StorageKey == "" || attachment.Uploader != "alice" {
			t.Fatalf("incomplete metadata: %+v", attachment)
		}
	}

	// Membership, not item existence, gates the listing.
	if _, err = s.Attachments(ctx, b.Workspace.ID, "mallory", id); !errors.Is(err, p.ErrForbidden) {
		t.Fatalf("non-member listing: %v", err)
	}
	if _, err = s.Attachments(ctx, b.Workspace.ID, "alice", ""); !errors.Is(err, p.ErrInvalid) {
		t.Fatalf("blank item listing: %v", err)
	}

	// Stored metadata that would fail a download check is refused, not served.
	execSQL(t, s, "UPDATE item_attachments SET content_type='text/html'")
	if _, err = s.Attachments(ctx, b.Workspace.ID, "alice", id); err == nil {
		t.Fatal("unsafe stored content type served")
	}
}
