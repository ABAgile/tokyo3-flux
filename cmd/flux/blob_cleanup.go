package main

import (
	"context"
	"log/slog"
	"time"

	"abagile.com/tokyo3/flux/internal/blobstore"
	"abagile.com/tokyo3/flux/internal/store"
)

const blobCleanupInterval = time.Minute

// runBlobCleanup retries persisted object deletions. Storage operations happen
// outside database transactions; each row is leased so another Flux process can
// safely share the work.
func runBlobCleanup(ctx context.Context, db *store.Store, blobs blobstore.Store, log *slog.Logger) error {
	clean := func() {
		stale, err := db.ReconcileBlobUploads(ctx, store.BlobCleanupBatchLimit)
		if err != nil {
			log.Warn("attachment upload manifest unavailable", "error", err)
			return
		}
		if stale > 0 {
			log.Info("expired attachment upload reservations queued", "count", stale)
		}
		entries, err := db.ClaimBlobCleanup(ctx, store.BlobCleanupBatchLimit)
		if err != nil {
			log.Warn("attachment cleanup queue unavailable", "error", err)
			return
		}
		for _, entry := range entries {
			deleteCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err = blobs.Delete(deleteCtx, entry.Key)
			cancel()
			if err != nil {
				if retryErr := db.RetryBlobCleanup(ctx, entry.ID, entry.Attempts, err); retryErr != nil {
					log.Warn("attachment cleanup retry could not be recorded", "key", entry.Key, "error", retryErr)
				} else {
					log.Warn("attachment cleanup deferred", "key", entry.Key, "attempts", entry.Attempts, "error", err)
				}
				continue
			}
			if err = db.CompleteBlobCleanup(ctx, entry.ID); err != nil {
				log.Warn("attachment cleanup completion could not be recorded", "key", entry.Key, "error", err)
			}
		}
	}

	clean()
	ticker := time.NewTicker(blobCleanupInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			clean()
		}
	}
}
