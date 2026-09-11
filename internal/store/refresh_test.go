package store

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"abagile.com/tokyo3/flux/internal/integration"
	p "abagile.com/tokyo3/flux/internal/planning"
)

func refreshLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }
func makeDue(t *testing.T, s *Store, b p.Board) {
	t.Helper()
	_, err := s.pool.Exec(context.Background(), "UPDATE external_links SET next_refresh=now()-interval '1 second',poll_after=now()-interval '1 second' WHERE workspace_id=$1", b.Workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
}
func TestBackgroundRefreshAndDedupe(t *testing.T) {
	var calls atomic.Int32
	s, b := linkedBoard(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); _, _ = w.Write([]byte(observedMR)) })
	s.SetRefreshInterval(time.Minute)
	ctx := context.Background()
	if err := s.refreshBatch(ctx, refreshLog()); err != nil {
		t.Fatal(err)
	}
	next := getBoard(t, s, b.Workspace.ID)
	if calls.Load() != 1 || next.Links[0].Outcome != "ok" || next.Links[0].RefreshPending || next.Workspace.Revision != b.Workspace.Revision || next.Items[0].Revision != b.Items[0].Revision {
		t.Fatal(next, calls.Load())
	}
	hint := integration.Hint{Kind: "mr", Project: 42, Number: 7}
	for range 2 {
		if err := s.EnqueueWebhook(ctx, s.connector.Instance(), "delivery-1", "digest-1", hint); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.EnqueueWebhook(ctx, s.connector.Instance(), "delivery-1", "different", hint); !errors.Is(err, integration.ErrDeliveryConflict) {
		t.Fatal(err)
	}
	var count int
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM webhook_deliveries").Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	if err := s.refreshBatch(ctx, refreshLog()); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatal("webhook bypassed cooldown")
	}
	if !getBoard(t, s, b.Workspace.ID).Links[0].RefreshPending {
		t.Fatal("hint not queued")
	}
	makeDue(t, s, b)
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() {
			if err := s.refreshBatch(ctx, refreshLog()); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if calls.Load() != 2 {
		t.Fatal("replicas did not coalesce", calls.Load())
	}
	if err := s.EnqueueWebhook(ctx, s.connector.Instance(), "delivery-1", "digest-1", hint); err != nil {
		t.Fatal(err)
	}
	if getBoard(t, s, b.Workspace.ID).Links[0].RefreshPending {
		t.Fatal("duplicate requeued completed event")
	}
	var source string
	if err := s.pool.QueryRow(ctx, "SELECT trigger FROM integration_runs ORDER BY id DESC LIMIT 1").Scan(&source); err != nil || source != "background" {
		t.Fatal(source, err)
	}
	// No artificial workspace member or browser idempotency receipt is created.
	var members int
	_ = s.pool.QueryRow(ctx, "SELECT count(*) FROM memberships").Scan(&members)
	if members != len(b.Members) {
		t.Fatal(members)
	}
}
func TestTargetedWebhookScopeAndRollback(t *testing.T) {
	s, b := linkedBoard(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(observedMR)) })
	s.SetRefreshInterval(time.Minute)
	ctx := context.Background()
	_, err := s.pool.Exec(ctx, "UPDATE external_links SET dirty=false")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.EnqueueWebhook(ctx, s.connector.Instance(), "pipeline-delivery", "digest", integration.Hint{Kind: "pipeline", Project: 42, Number: 99, MR: 7}); err != nil {
		t.Fatal(err)
	}
	next := getBoard(t, s, b.Workspace.ID)
	for _, l := range next.Links {
		if l.RefreshPending != (l.Kind == "mr") {
			t.Fatal(l)
		}
	}
	if err = s.EnqueueWebhook(ctx, s.connector.Instance(), "outside", "digest", integration.Hint{Kind: "mr", Project: 999, Number: 7}); err != nil {
		t.Fatal(err)
	}
	if err = s.EnqueueWebhook(ctx, "https://unapproved.example", "outside", "digest", integration.Hint{Kind: "mr", Project: 42, Number: 7}); !errors.Is(err, p.ErrForbidden) {
		t.Fatal(err)
	}
	execSQL(t, s, `UPDATE external_links SET dirty=false; CREATE FUNCTION reject_hook_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='integration.webhook' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_hook BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_hook_audit()`)
	if err = s.EnqueueWebhook(ctx, s.connector.Instance(), "rollback", "digest", integration.Hint{Kind: "push", Project: 42}); err == nil {
		t.Fatal("failed audit acknowledged")
	}
	var receipts int
	_ = s.pool.QueryRow(ctx, "SELECT count(*) FROM webhook_deliveries WHERE delivery_id='rollback'").Scan(&receipts)
	if receipts != 0 {
		t.Fatal("partial receipt")
	}
	for _, l := range getBoard(t, s, b.Workspace.ID).Links {
		if l.RefreshPending {
			t.Fatal("failed audit dirtied link")
		}
	}
}
func TestWebhookDuringFetchSurvivesCompletion(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	s, b := linkedBoard(t, func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		_, _ = w.Write([]byte(observedMR))
	})
	s.SetRefreshInterval(time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.refreshBatch(ctx, refreshLog()) }()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := s.EnqueueWebhook(ctx, s.connector.Instance(), "during-fetch", "digest", integration.Hint{Kind: "mr", Project: 42, Number: 7}); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	link := getBoard(t, s, b.Workspace.ID).Links[0]
	if link.Outcome != "ok" || !link.RefreshPending {
		t.Fatal("concurrent hint lost", link)
	}
}
func TestProviderVersionAndBackoff(t *testing.T) {
	var mode atomic.Int32
	s, b := linkedBoard(t, func(w http.ResponseWriter, r *http.Request) {
		if mode.Load() == 2 {
			w.WriteHeader(503)
			return
		}
		date := "2026-09-10T12:00:00Z"
		if mode.Load() == 1 {
			date = "2026-09-09T12:00:00Z"
		}
		_, _ = w.Write([]byte(`{"id":100,"iid":7,"project_id":42,"updated_at":"` + date + `","state":"opened","sha":"head"}`))
	})
	s.SetRefreshInterval(time.Minute)
	ctx := context.Background()
	if err := s.refreshBatch(ctx, refreshLog()); err != nil {
		t.Fatal(err)
	}
	first := getBoard(t, s, b.Workspace.ID).Links[0]
	mode.Store(1)
	makeDue(t, s, b)
	if err := s.refreshBatch(ctx, refreshLog()); err != nil {
		t.Fatal(err)
	}
	old := getBoard(t, s, b.Workspace.ID).Links[0]
	if old.Outcome != "outdated" || !old.LastSuccess.Equal(*first.LastSuccess) || !old.Observation.SourceUpdatedAt.Equal(*first.Observation.SourceUpdatedAt) {
		t.Fatal(old)
	}
	mode.Store(2)
	makeDue(t, s, b)
	if err := s.refreshBatch(ctx, refreshLog()); err != nil {
		t.Fatal(err)
	}
	failed := getBoard(t, s, b.Workspace.ID).Links[0]
	if failed.Outcome != "unavailable" || failed.Observation == nil || time.Until(*failed.NextRefresh) < 55*time.Second {
		t.Fatal(failed)
	}
	for _, n := range []int{0, 1, 2, 8, 100} {
		d := retryBackoff(n)
		if d < 30*time.Second || d > time.Hour {
			t.Fatal(n, d)
		}
	}
}
func TestRefreshRetentionAndShutdown(t *testing.T) {
	s, b := linkedBoard(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(observedMR)) })
	s.SetRefreshInterval(time.Minute)
	_, err := s.pool.Exec(context.Background(), "INSERT INTO webhook_deliveries VALUES($1,$2,'expired','digest',now()-interval '8 days')", b.Workspace.ID, s.connector.Instance())
	if err != nil {
		t.Fatal(err)
	}
	if err = s.refreshBatch(context.Background(), refreshLog()); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = s.pool.QueryRow(context.Background(), "SELECT count(*) FROM webhook_deliveries").Scan(&n)
	if n != 0 {
		t.Fatal(n)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err = s.RunRefresh(ctx, refreshLog()); err != nil {
		t.Fatal(err)
	}
}
