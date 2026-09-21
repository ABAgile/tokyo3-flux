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
)

// BlobCleanup is one persisted deletion that could not be completed inline.
type BlobCleanup struct {
	ID       int64
	Key      string
	Attempts int
}

// QueueBlobCleanup records an object that should be deleted when storage is
// available again. The key is unique, so repeated failure paths are harmless.
func (s *Store) QueueBlobCleanup(ctx context.Context, key string) error {
	if !validAttachmentStorageKey(key) {
		return p.ErrInvalid
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO attachment_cleanup(storage_key)
 VALUES($1) ON CONFLICT(storage_key) DO NOTHING`, key)
	return err
}

// ClaimBlobCleanup leases due deletion rows. SKIP LOCKED lets multiple Flux
// processes share cleanup work without holding a database lock during storage
// operations.
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
 WHERE next_attempt<=clock_timestamp()
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
 SET next_attempt=clock_timestamp()+make_interval(secs=>$2),last_error=$3
 WHERE id=$1`, id, int64(wait/time.Second), message)
	return err
}

// PendingBlobCleanupCount is intended for diagnostics and tests, not request
// handling. It reports rows still waiting for storage cleanup.
func (s *Store) PendingBlobCleanupCount(ctx context.Context) (int, error) {
	var count int
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM attachment_cleanup").Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}
