package store

import (
	"context"
	"errors"
	"testing"

	p "abagile.com/tokyo3/flux/internal/planning"
)

func TestPostgresBlobCleanupQueueLeasesAndRetries(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	key := p.NewID()
	if err := s.QueueBlobCleanup(ctx, key); err != nil {
		t.Fatal(err)
	}
	if err := s.QueueBlobCleanup(ctx, key); err != nil {
		t.Fatal(err)
	}
	count, err := s.PendingBlobCleanupCount(ctx)
	if err != nil || count != 1 {
		t.Fatalf("queued cleanup rows = %d: %v", count, err)
	}
	entries, err := s.ClaimBlobCleanup(ctx, 1)
	if err != nil || len(entries) != 1 || entries[0].Key != key || entries[0].Attempts != 1 {
		t.Fatalf("claimed cleanup = %+v: %v", entries, err)
	}
	if err = s.RetryBlobCleanup(ctx, entries[0].ID, entries[0].Attempts, errors.New("storage offline")); err != nil {
		t.Fatal(err)
	}
	entries, err = s.ClaimBlobCleanup(ctx, 1)
	if err != nil || len(entries) != 0 {
		t.Fatalf("leased cleanup was immediately reclaimed: %+v: %v", entries, err)
	}
	if _, err = s.pool.Exec(ctx, "UPDATE attachment_cleanup SET next_attempt=clock_timestamp() WHERE storage_key=$1", key); err != nil {
		t.Fatal(err)
	}
	entries, err = s.ClaimBlobCleanup(ctx, 1)
	if err != nil || len(entries) != 1 || entries[0].Attempts != 2 {
		t.Fatalf("retried cleanup = %+v: %v", entries, err)
	}
	if err = s.CompleteBlobCleanup(ctx, entries[0].ID); err != nil {
		t.Fatal(err)
	}
	count, err = s.PendingBlobCleanupCount(ctx)
	if err != nil || count != 0 {
		t.Fatalf("completed cleanup rows = %d: %v", count, err)
	}
	if err = s.BeginBlobUpload(ctx, key); err != nil {
		t.Fatal(err)
	}
	status, err := s.BlobCleanupStatus(ctx)
	if err != nil || status.Uploading != 1 || status.Cleanup != 0 || status.Due != 0 {
		t.Fatalf("upload reservation status = %+v: %v", status, err)
	}
	moved, err := s.ReconcileBlobUploads(ctx, 1)
	if err != nil || moved != 0 {
		t.Fatalf("fresh upload reservation reconciled: %d: %v", moved, err)
	}
	if _, err = s.pool.Exec(ctx, "UPDATE attachment_cleanup SET next_attempt=clock_timestamp() WHERE storage_key=$1", key); err != nil {
		t.Fatal(err)
	}
	moved, err = s.ReconcileBlobUploads(ctx, 1)
	if err != nil || moved != 1 {
		t.Fatalf("stale upload reservation not reconciled: %d: %v", moved, err)
	}
	entries, err = s.ClaimBlobCleanup(ctx, 1)
	if err != nil || len(entries) != 1 {
		t.Fatalf("reconciled cleanup not claimable: %+v: %v", entries, err)
	}
	if err = s.CompleteBlobCleanup(ctx, entries[0].ID); err != nil {
		t.Fatal(err)
	}
	if err = s.RetryBlobCleanup(ctx, entries[0].ID, 0, errors.New("bad")); !errors.Is(err, p.ErrInvalid) {
		t.Fatalf("invalid retry accepted: %v", err)
	}
}
