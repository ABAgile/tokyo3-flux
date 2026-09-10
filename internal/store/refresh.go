package store

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	p "abagile.com/tokyo3/flux/internal/planning"
	"github.com/abagile/tokyo3-base/guard"
)

// SetRefreshInterval is startup-only. Zero keeps the service manual-only.
func (s *Store) SetRefreshInterval(interval time.Duration) { s.refreshInterval = interval }

// RunRefresh is a run.Group component. Database/provider failures degrade only
// observations; neither a failed tick nor a provider outage stops planning.
func (s *Store) RunRefresh(ctx context.Context, log *slog.Logger) error {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		guard.Tick(log, "gitlab-refresh", func() {
			if err := s.refreshBatch(ctx, log); err != nil && ctx.Err() == nil {
				log.Warn("GitLab refresh tick failed; will retry")
			}
		})
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
func (s *Store) refreshBatch(ctx context.Context, log *slog.Logger) error {
	if s.connector == nil || s.refreshInterval == 0 {
		return nil
	}
	scan, cancel := context.WithTimeout(ctx, 5*time.Second)
	rows, err := s.pool.Query(scan, `SELECT e.workspace_id,e.id FROM external_links e JOIN workspace_integrations i USING(workspace_id)
 WHERE i.instance=$1 AND (e.next_refresh IS NULL OR e.next_refresh<=clock_timestamp()) AND (e.dirty OR e.poll_after<=clock_timestamp())
 ORDER BY e.last_attempt NULLS FIRST,e.workspace_id,e.id LIMIT 16`, s.connector.Instance())
	if err != nil {
		cancel()
		return err
	}
	type task struct{ workspace, link string }
	jobs := make(chan task, 16)
	for rows.Next() {
		var v task
		if err = rows.Scan(&v.workspace, &v.link); err != nil {
			rows.Close()
			cancel()
			return err
		}
		jobs <- v
	}
	rows.Close()
	err = rows.Err()
	cancel()
	if err != nil {
		return err
	}
	close(jobs)
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(guard.Guarded(log, "gitlab-refresh-worker", func() {
			for job := range jobs {
				if ctx.Err() != nil {
					return
				}
				taskCtx, done := context.WithTimeout(ctx, 15*time.Second)
				_, err := s.refresh(taskCtx, job.workspace, "system:gitlab-refresh", p.NewID(), p.Command{Kind: "link.refresh", Target: job.link}, true)
				done()
				if err != nil && !errors.Is(err, p.ErrConflict) && !errors.Is(err, p.ErrNotFound) && ctx.Err() == nil {
					log.Warn("GitLab observation attempt failed; lease will expire", "workspace", job.workspace, "link", job.link)
				}
			}
		}))
	}
	wg.Wait()
	cleanup, done := context.WithTimeout(ctx, 3*time.Second)
	defer done()
	// Bounded retention work; receipts contain only hashes and routing metadata.
	_, err = s.pool.Exec(cleanup, `DELETE FROM webhook_deliveries WHERE (workspace_id,instance,delivery_id) IN (SELECT workspace_id,instance,delivery_id FROM webhook_deliveries WHERE received_at<now()-interval '7 days' ORDER BY received_at LIMIT 500)`)
	return err
}
