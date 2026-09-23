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

func TestPostgresAttachmentLifecycleQueue(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	b := bootstrap(t, s)
	item := newItem(b, "Attachment lifecycle")
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &item})
	item = b.Items[0]
	key := p.NewID()
	if err := s.BeginBlobUpload(ctx, key); err != nil {
		t.Fatal(err)
	}
	attachment, err := s.AddAttachment(ctx, b.Workspace.ID, "alice", item.ID, key, p.NewID(), p.Attachment{
		Name: "lifecycle.txt", ContentType: "text/plain", Size: 3, Digest: "sha256:" + strings.Repeat("a", 64),
	})
	if err != nil {
		t.Fatal(err)
	}
	status, err := s.BlobCleanupStatus(ctx)
	if err != nil || status.Uploading != 0 || status.Cleanup != 0 {
		t.Fatalf("committed upload remained in lifecycle queue: %+v: %v", status, err)
	}
	removed, err := s.RemoveAttachment(ctx, b.Workspace.ID, "alice", item.ID, attachment.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !removed.CleanupQueued || removed.StorageKey != key {
		t.Fatalf("removed attachment lifecycle signal = %+v", removed)
	}
	status, err = s.BlobCleanupStatus(ctx)
	if err != nil || status.Uploading != 0 || status.Cleanup != 1 || status.Due != 1 {
		t.Fatalf("removed attachment was not queued: %+v: %v", status, err)
	}
	if err = s.CompleteBlobCleanupKey(ctx, key); err != nil {
		t.Fatal(err)
	}
}

// Every reader shares one integrity gate, so a row that could not have been
// written through AddAttachment is refused on the way out regardless of which
// path reaches it. Without this, an archived card could advertise a download
// the transfer path would only reject after the user clicked it.
func TestStoredAttachmentGateIsShared(t *testing.T) {
	sound := p.Attachment{
		ID: 1, ItemID: "i1", Name: "notes.txt", ContentType: "text/plain",
		Size: 12, Digest: "sha256:" + strings.Repeat("a", 64),
		Uploader: "alice", StorageKey: p.NewID(),
	}
	if err := checkStoredAttachment(sound); err != nil {
		t.Fatalf("well-formed attachment refused: %v", err)
	}
	for name, mutate := range map[string]func(*p.Attachment){
		"no storage key":   func(a *p.Attachment) { a.StorageKey = "" },
		"path storage key": func(a *p.Attachment) { a.StorageKey = "../escape" },
		"no uploader":      func(a *p.Attachment) { a.Uploader = " " },
		"unsafe type":      func(a *p.Attachment) { a.ContentType = "text/html" },
		"bad digest":       func(a *p.Attachment) { a.Digest = "sha256:zz" },
		"oversize":         func(a *p.Attachment) { a.Size = p.MaxAttachmentBytes + 1 },
	} {
		broken := sound
		mutate(&broken)
		if err := checkStoredAttachment(broken); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}
