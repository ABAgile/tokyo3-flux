package reconcile

import (
	"context"
	"errors"
	"fmt"
	"strings"
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

// Reconciler keeps the read model fresh. Webhooks only wake this loop; GitLab
// remains authoritative and is always read again before replacing the store.
type Reconciler struct {
	source   Source
	store    Store
	target   string
	goal     string
	interval time.Duration
	onError  func(error)
	trigger  chan struct{}
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
	}, nil
}

// Trigger requests a reconciliation. Multiple webhook deliveries are
// coalesced while one request is waiting to be processed.
func (r *Reconciler) Trigger() {
	select {
	case r.trigger <- struct{}{}:
	default:
	}
}

// Run performs an initial sync, then responds to webhooks and the periodic
// reconciliation interval until ctx is cancelled.
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
	snapshot, err := r.source.Snapshot(ctx, r.target, r.goal)
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			r.onError(err)
		}
		return
	}
	if err := r.store.Put(snapshot); err != nil {
		r.onError(fmt.Errorf("store snapshot: %w", err))
	}
}
