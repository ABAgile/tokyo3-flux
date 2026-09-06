package reconcile

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
)

// Source is the authoritative snapshot provider. The GitLab adapter satisfies
// this interface; tests and future providers can use another implementation.
type Source interface {
	Snapshot(context.Context, string, string) (domain.Snapshot, error)
}

// Store receives successful snapshots.
type Store interface {
	Put(domain.Snapshot) error
}

// Config controls the periodic and event-triggered reconciliation loop.
type Config struct {
	Source   Source
	Store    Store
	Target   string
	Goal     string
	Interval time.Duration
	OnError  func(error)
}

// Reconciler keeps the read model fresh. Triggers only wake this loop; the
// configured source remains authoritative and is always read again before
// replacing the store.
type Reconciler struct {
	source   Source
	store    Store
	target   string
	goal     string
	interval time.Duration
	onError  func(error)
	trigger  chan struct{}

	statusMu sync.RWMutex
	status   domain.SyncStatus
	pending  bool
}

// New validates reconciliation settings.
func New(cfg Config) (*Reconciler, error) {
	if cfg.Source == nil {
		return nil, errors.New("reconciliation source is required")
	}
	if cfg.Store == nil {
		return nil, errors.New("reconciliation store is required")
	}
	target := strings.TrimSpace(cfg.Target)
	if target == "" {
		return nil, errors.New("reconciliation target is required")
	}
	if cfg.Interval <= 0 {
		return nil, errors.New("reconciliation interval must be positive")
	}
	if cfg.OnError == nil {
		cfg.OnError = func(error) {}
	}
	return &Reconciler{
		source:   cfg.Source,
		store:    cfg.Store,
		target:   target,
		goal:     cfg.Goal,
		interval: cfg.Interval,
		onError:  cfg.OnError,
		trigger:  make(chan struct{}, 1),
		status:   domain.SyncStatus{State: domain.SyncStateIdle},
	}, nil
}

// SyncStatus returns a copy of the latest pull reconciliation status.
func (r *Reconciler) SyncStatus() domain.SyncStatus {
	r.statusMu.RLock()
	defer r.statusMu.RUnlock()
	return r.status
}

// Trigger requests a reconciliation. Multiple trigger requests are coalesced
// while one request is waiting to be processed.
func (r *Reconciler) Trigger() {
	r.statusMu.Lock()
	r.pending = true
	if r.status.State != domain.SyncStateSyncing {
		r.status.State = domain.SyncStateQueued
	}
	r.statusMu.Unlock()

	select {
	case r.trigger <- struct{}{}:
	default:
	}
}

// Run performs an initial pull, then responds to manual/event triggers and the
// periodic reconciliation interval until ctx is cancelled.
func (r *Reconciler) Run(ctx context.Context) error {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()

	r.reconcile(ctx)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-r.trigger:
			r.reconcile(ctx)
		case <-ticker.C:
			r.reconcile(ctx)
		}
	}
}

func (r *Reconciler) reconcile(ctx context.Context) {
	started := time.Now().UTC()
	r.beginSync(started)

	snapshot, err := r.source.Snapshot(ctx, r.target, r.goal)
	if err != nil {
		r.finishSync(started, time.Now().UTC(), err)
		if !errors.Is(err, context.Canceled) {
			r.onError(err)
		}
		return
	}
	if err := r.store.Put(snapshot); err != nil {
		err = fmt.Errorf("store snapshot: %w", err)
		r.finishSync(started, time.Now().UTC(), err)
		r.onError(err)
		return
	}
	r.finishSync(started, time.Now().UTC(), nil)
}

func (r *Reconciler) beginSync(started time.Time) {
	r.statusMu.Lock()
	r.pending = false
	r.status.State = domain.SyncStateSyncing
	r.status.LastStartedAt = started
	r.status.LastError = ""
	r.statusMu.Unlock()
}

func (r *Reconciler) finishSync(started, completed time.Time, syncErr error) {
	duration := max(completed.Sub(started), 0)
	status := domain.SyncStateReady
	errorText := ""
	if syncErr != nil {
		status = domain.SyncStateError
		errorText = syncErrorText(syncErr)
	}

	r.statusMu.Lock()
	if r.pending {
		status = domain.SyncStateQueued
	}
	r.status.State = status
	r.status.LastCompletedAt = completed
	r.status.LastDuration = duration
	r.status.LastError = errorText
	r.statusMu.Unlock()
}

func syncErrorText(err error) string {
	text := strings.TrimSpace(err.Error())
	const maxLength = 500
	if len(text) > maxLength {
		return text[:maxLength] + "…"
	}
	return text
}
