package store

import (
	"context"
	"errors"
	"strings"
	"time"

	p "abagile.com/tokyo3/flux/internal/planning"
)

const (
	BlobCleanupBatchLimit  = 100
	blobCleanupLease       = 5 * time.Minute
	blobCleanupInitialWait = 30 * time.Second
	blobCleanupMaxWait     = time.Hour
	blobCleanupErrorLimit  = 1000
	// Requests have a two-minute server deadline. This grace period keeps a
	// slow but valid upload from being reclaimed while it is still in flight.
	blobUploadGrace = 15 * time.Minute
)

// BlobCleanup is one persisted deletion that could not be completed inline.
type BlobCleanup struct {
	ID       int64
	Key      string
	Attempts int
}

// BlobCleanupStatus is the operator-facing state of attachment lifecycle
// records. Cleanup includes both due and deferred deletion attempts.
type BlobCleanupStatus struct {
	Uploading int
	Cleanup   int
	Due       int
}

// BeginBlobUpload reserves an object key before any bytes are written. If the
// process dies after the blob write, the serving worker eventually converts the
// expired reservation into cleanup work.
func (s *Store) BeginBlobUpload(ctx context.Context, key string) error {
	if !validAttachmentStorageKey(key) {
		return p.ErrInvalid
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO attachment_cleanup(storage_key,state,next_attempt)
 VALUES($1,'uploading',clock_timestamp()+make_interval(secs=>$2))
 ON CONFLICT(storage_key) DO NOTHING`, key, int64(blobUploadGrace/time.Second))
	return err
}

// QueueBlobCleanup records an object that should be deleted when storage is
// available again. The key is unique, so repeated failure paths are harmless.
// Existing upload reservations are released immediately into cleanup state.
func (s *Store) QueueBlobCleanup(ctx context.Context, key string) error {
	if !validAttachmentStorageKey(key) {
		return p.ErrInvalid
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO attachment_cleanup(storage_key,state,next_attempt)
 VALUES($1,'cleanup',clock_timestamp())
 ON CONFLICT(storage_key) DO UPDATE SET state='cleanup',next_attempt=clock_timestamp(),attempts=0,last_error=''`, key)
	return err
}

// CompleteBlobCleanupKey removes a lifecycle record after the object has been
// deleted. It is idempotent so replayed requests remain safe.
func (s *Store) CompleteBlobCleanupKey(ctx context.Context, key string) error {
	if !validAttachmentStorageKey(key) {
		return p.ErrInvalid
	}
	_, err := s.pool.Exec(ctx, "DELETE FROM attachment_cleanup WHERE storage_key=$1", key)
	return err
}

// ReconcileBlobUploads turns expired upload reservations into cleanup work.
// Row locks are held only for this short state transition, never during blob
// storage operations, and SKIP LOCKED permits multiple Flux processes to share
// the work.
func (s *Store) ReconcileBlobUploads(ctx context.Context, limit int) (int64, error) {
	if limit <= 0 || limit > BlobCleanupBatchLimit {
		return 0, p.ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `WITH stale AS (
 SELECT id FROM attachment_cleanup
 WHERE state='uploading' AND next_attempt<=clock_timestamp()
 ORDER BY id LIMIT $1
 FOR UPDATE SKIP LOCKED
)
UPDATE attachment_cleanup AS c
SET state='cleanup',next_attempt=clock_timestamp(),attempts=0,last_error=''
FROM stale
WHERE c.id=stale.id`, limit)
	if err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ClaimBlobCleanup leases due deletion rows. Storage operations happen after
// the transaction commits, so a failed process leaves a lease that can be
// retried safely after the bounded interval.
func (s *Store) ClaimBlobCleanup(ctx context.Context, limit int) ([]BlobCleanup, error) {
	if limit <= 0 || limit > BlobCleanupBatchLimit {
		return nil, p.ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `WITH due AS (
 SELECT id FROM attachment_cleanup
 WHERE state='cleanup' AND next_attempt<=clock_timestamp()
 ORDER BY id LIMIT $1
 FOR UPDATE SKIP LOCKED
)
UPDATE attachment_cleanup AS c
SET attempts=c.attempts+1,
    next_attempt=clock_timestamp()+make_interval(secs=>$2)
FROM due
WHERE c.id=due.id
RETURNING c.id,c.storage_key,c.attempts`, limit, int64(blobCleanupLease/time.Second))
	if err != nil {
		return nil, err
	}
	out := make([]BlobCleanup, 0, limit)
	for rows.Next() {
		var item BlobCleanup
		if err = rows.Scan(&item.ID, &item.Key, &item.Attempts); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, item)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// CompleteBlobCleanup removes a successfully deleted object from the queue.
func (s *Store) CompleteBlobCleanup(ctx context.Context, id int64) error {
	if id <= 0 {
		return p.ErrInvalid
	}
	_, err := s.pool.Exec(ctx, "DELETE FROM attachment_cleanup WHERE id=$1", id)
	return err
}

// RetryBlobCleanup releases a failed lease with bounded exponential backoff.
func (s *Store) RetryBlobCleanup(ctx context.Context, id int64, attempts int, cleanupErr error) error {
	if id <= 0 || attempts <= 0 {
		return p.ErrInvalid
	}
	if cleanupErr == nil {
		return errors.New("blob cleanup error is required")
	}
	wait := blobCleanupInitialWait
	for i := 1; i < attempts && wait < blobCleanupMaxWait; i++ {
		wait *= 2
	}
	if wait > blobCleanupMaxWait {
		wait = blobCleanupMaxWait
	}
	message := strings.TrimSpace(cleanupErr.Error())
	if len(message) > blobCleanupErrorLimit {
		message = message[:blobCleanupErrorLimit]
	}
	_, err := s.pool.Exec(ctx, `UPDATE attachment_cleanup
 SET state='cleanup',next_attempt=clock_timestamp()+make_interval(secs=>$2),last_error=$3
 WHERE id=$1`, id, int64(wait/time.Second), message)
	return err
}

// BlobCleanupStatus reports lifecycle records for operator diagnostics.
func (s *Store) BlobCleanupStatus(ctx context.Context) (BlobCleanupStatus, error) {
	var status BlobCleanupStatus
	err := s.pool.QueryRow(ctx, `SELECT
 count(*) FILTER (WHERE state='uploading'),
 count(*) FILTER (WHERE state='cleanup'),
 count(*) FILTER (WHERE state='cleanup' AND next_attempt<=clock_timestamp())
 FROM attachment_cleanup`).Scan(&status.Uploading, &status.Cleanup, &status.Due)
	return status, err
}

// PendingBlobCleanupCount is retained for tests and internal diagnostics.
func (s *Store) PendingBlobCleanupCount(ctx context.Context) (int, error) {
	status, err := s.BlobCleanupStatus(ctx)
	return status.Cleanup, err
}
