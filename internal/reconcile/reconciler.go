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

const (
	defaultOverlapWindow    = 5 * time.Minute
	defaultFullScanInterval = 24 * time.Hour
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

// ObservedStore receives a successful snapshot with the pull observation time
// and run ID used to connect history records to sync-run metadata.
type ObservedStore interface {
	PutObserved(domain.Snapshot, string, time.Time) error
}

// RunRecorder persists one completed pull attempt, including failures.
type RunRecorder interface {
	RecordSyncRun(domain.SyncRun) error
}

// WatermarkReader supplies the latest successful source watermark and full
// scan time when the store has durable reconciliation metadata.
type WatermarkReader interface {
	SourceWatermark() time.Time
	LastFullSyncAt() time.Time
}

// SnapshotReader supplies the last normalized snapshot to an incremental
// source so it can merge changed entities without exposing source API shapes.
type SnapshotReader interface {
	Get() (domain.Snapshot, bool)
}

// IncrementalSource returns a best-effort normalized snapshot using an
// overlap-window source query. Full scans remain responsible for discovering
// deletions and other changes outside the incremental endpoint's coverage.
type IncrementalSource interface {
	SnapshotSince(context.Context, string, string, time.Time, domain.Snapshot) (domain.Snapshot, error)
}

// Config controls the periodic and event-triggered reconciliation loop.
type Config struct {
	Source           Source
	Store            Store
	Target           string
	Goal             string
	Interval         time.Duration
	OverlapWindow    time.Duration
	FullScanInterval time.Duration
	OnError          func(error)
}

// Reconciler keeps the read model fresh. Triggers only wake this loop; the
// configured source remains authoritative and is always read again before
// replacing the store.
type Reconciler struct {
	source           Source
	store            Store
	target           string
	goal             string
	interval         time.Duration
	overlapWindow    time.Duration
	fullScanInterval time.Duration
	onError          func(error)
	trigger          chan struct{}

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
	if cfg.OverlapWindow == 0 {
		cfg.OverlapWindow = defaultOverlapWindow
	}
	if cfg.FullScanInterval == 0 {
		cfg.FullScanInterval = defaultFullScanInterval
	}
	if cfg.OverlapWindow < 0 {
		return nil, errors.New("reconciliation overlap window must not be negative")
	}
	if cfg.FullScanInterval <= 0 {
		return nil, errors.New("full scan interval must be positive")
	}
	if cfg.OnError == nil {
		cfg.OnError = func(error) {}
	}
	return &Reconciler{
		source:           cfg.Source,
		store:            cfg.Store,
		target:           target,
		goal:             cfg.Goal,
		interval:         cfg.Interval,
		overlapWindow:    cfg.OverlapWindow,
		fullScanInterval: cfg.FullScanInterval,
		onError:          cfg.OnError,
		trigger:          make(chan struct{}, 1),
		status:           domain.SyncStatus{State: domain.SyncStateIdle},
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

	plan := r.pullPlan(started)
	run := domain.SyncRun{
		ID:        fmt.Sprintf("sync-%d", started.UnixNano()),
		Target:    r.target,
		Mode:      plan.mode,
		FullScan:  plan.fullScan,
		Status:    "running",
		StartedAt: started,
		Coverage:  plan.coverage,
	}
	if !plan.requestedAfter.IsZero() {
		value := plan.requestedAfter
		run.RequestedAfter = &value
	}

	var (
		snapshot domain.Snapshot
		err      error
	)
	if plan.incremental != nil && !plan.fullScan {
		previous := domain.Snapshot{}
		if reader, ok := r.store.(SnapshotReader); ok {
			previous, _ = reader.Get()
		}
		snapshot, err = plan.incremental.SnapshotSince(ctx, r.target, r.goal, plan.requestedAfter, previous)
	} else {
		snapshot, err = r.source.Snapshot(ctx, r.target, r.goal)
	}
	if err != nil {
		completed := time.Now().UTC()
		run.Status = "error"
		run.CompletedAt = completed
		run.Error = syncErrorText(err)
		r.recordRun(run)
		r.finishSync(started, completed, err)
		if !errors.Is(err, context.Canceled) {
			r.onError(err)
		}
		return
	}

	observedAt := time.Now().UTC()
	run.ObservedAt = timePointer(observedAt)
	if !snapshot.GeneratedAt.IsZero() {
		run.SnapshotGeneratedAt = timePointer(snapshot.GeneratedAt)
	}
	run.ItemCount = len(snapshot.Sprint.WorkItems)
	if watermark := sourceWatermark(snapshot); !watermark.IsZero() {
		run.SourceWatermark = timePointer(watermark)
	}
	if observedStore, ok := r.store.(ObservedStore); ok {
		err = observedStore.PutObserved(snapshot, run.ID, observedAt)
	} else {
		err = r.store.Put(snapshot)
	}
	if err != nil {
		err = fmt.Errorf("store snapshot: %w", err)
		completed := time.Now().UTC()
		run.Status = "error"
		run.CompletedAt = completed
		run.Error = syncErrorText(err)
		r.recordRun(run)
		r.finishSync(started, completed, err)
		r.onError(err)
		return
	}

	completed := time.Now().UTC()
	run.Status = "success"
	run.CompletedAt = completed
	r.recordRun(run)
	r.finishSync(started, completed, nil)
}

type pullPlan struct {
	incremental    IncrementalSource
	requestedAfter time.Time
	fullScan       bool
	mode           string
	coverage       string
}

func (r *Reconciler) pullPlan(started time.Time) pullPlan {
	incremental, supportsIncremental := r.source.(IncrementalSource)
	plan := pullPlan{
		incremental: incremental,
		fullScan:    true,
		mode:        "full",
		coverage:    "complete_current_milestone",
	}
	if !supportsIncremental {
		return plan
	}

	var previousWatermark, lastFullSync time.Time
	previousSnapshotAvailable := false
	if reader, ok := r.store.(WatermarkReader); ok {
		previousWatermark = reader.SourceWatermark()
		lastFullSync = reader.LastFullSyncAt()
	}
	if reader, ok := r.store.(SnapshotReader); ok {
		_, previousSnapshotAvailable = reader.Get()
	}
	if !previousSnapshotAvailable || previousWatermark.IsZero() || lastFullSync.IsZero() || started.Sub(lastFullSync) >= r.fullScanInterval {
		return plan
	}
	plan.fullScan = false
	plan.mode = "overlap"
	plan.coverage = "overlap_current_milestone"
	plan.requestedAfter = previousWatermark.Add(-r.overlapWindow)
	return plan
}

func (r *Reconciler) recordRun(run domain.SyncRun) {
	recorder, ok := r.store.(RunRecorder)
	if !ok {
		return
	}
	if err := recorder.RecordSyncRun(run); err != nil {
		r.onError(fmt.Errorf("record sync run: %w", err))
	}
}

func sourceWatermark(snapshot domain.Snapshot) time.Time {
	var watermark time.Time
	for _, item := range snapshot.Sprint.WorkItems {
		if item.LastActivity.After(watermark) {
			watermark = item.LastActivity.UTC()
		}
	}
	return watermark
}

func timePointer(value time.Time) *time.Time {
	value = value.UTC()
	return &value
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
