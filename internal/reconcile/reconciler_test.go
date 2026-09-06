package reconcile

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
)

type fakeSource struct {
	mu       sync.Mutex
	calls    int
	snapshot domain.Snapshot
	err      error
}

func (f *fakeSource) Snapshot(context.Context, string, string) (domain.Snapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.snapshot, f.err
}

func (f *fakeSource) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

type blockingSource struct {
	mu       sync.Mutex
	calls    int
	snapshot domain.Snapshot
	started  chan struct{}
	release  chan struct{}
}

func (b *blockingSource) Snapshot(context.Context, string, string) (domain.Snapshot, error) {
	b.mu.Lock()
	b.calls++
	call := b.calls
	b.mu.Unlock()
	if call == 1 {
		close(b.started)
		<-b.release
	}
	return b.snapshot, nil
}

func (b *blockingSource) callCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.calls
}

type fakeStore struct {
	mu       sync.Mutex
	snapshot domain.Snapshot
	puts     int
}

func (f *fakeStore) Put(snapshot domain.Snapshot) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.snapshot = snapshot
	f.puts++
	return nil
}

func (f *fakeStore) putCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.puts
}

func (f *fakeStore) Get() (domain.Snapshot, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snapshot, f.puts > 0
}

type metadataStore struct {
	fakeStore
	watermark  time.Time
	lastFull   time.Time
	observedID string
	observedAt time.Time
	runs       []domain.SyncRun
}

func (s *metadataStore) PutObserved(snapshot domain.Snapshot, runID string, observedAt time.Time) error {
	s.fakeStore.Put(snapshot)
	s.observedID = runID
	s.observedAt = observedAt
	return nil
}

func (s *metadataStore) RecordSyncRun(run domain.SyncRun) error {
	s.runs = append(s.runs, run)
	if run.Status == "success" {
		if run.SourceWatermark != nil {
			s.watermark = *run.SourceWatermark
		}
		if run.FullScan {
			s.lastFull = run.CompletedAt
		}
	}
	return nil
}

func (s *metadataStore) SourceWatermark() time.Time { return s.watermark }
func (s *metadataStore) LastFullSyncAt() time.Time  { return s.lastFull }

type incrementalSource struct {
	fakeSource
	since       time.Time
	incremental int
}

func (s *incrementalSource) SnapshotSince(_ context.Context, _ string, _ string, since time.Time, _ domain.Snapshot) (domain.Snapshot, error) {
	s.since = since
	s.incremental++
	return s.snapshot, s.err
}

func TestRunInitialAndTriggeredSync(t *testing.T) {
	source := &fakeSource{snapshot: domain.Snapshot{Sprint: domain.Sprint{Name: "Flow 01"}}}
	store := &fakeStore{}
	reconciler, err := New(Config{
		Source:   source,
		Store:    store,
		Target:   "tokyo3",
		Interval: time.Hour,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- reconciler.Run(ctx) }()

	waitFor(t, func() bool { return source.callCount() == 1 })
	if got := store.putCount(); got != 1 {
		t.Fatalf("initial puts = %d, want 1", got)
	}
	waitFor(t, func() bool { return reconciler.SyncStatus().State == domain.SyncStateReady })
	initialStatus := reconciler.SyncStatus()
	if initialStatus.LastStartedAt.IsZero() || initialStatus.LastCompletedAt.IsZero() || initialStatus.LastDuration < 0 || initialStatus.LastError != "" {
		t.Fatalf("initial sync status = %+v", initialStatus)
	}

	reconciler.Trigger()
	waitFor(t, func() bool { return source.callCount() == 2 })
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v, want context.Canceled", err)
	}
}

func TestTriggerDuringSyncIsNotLost(t *testing.T) {
	source := &blockingSource{
		snapshot: domain.Snapshot{Sprint: domain.Sprint{Name: "Flow 01"}},
		started:  make(chan struct{}),
		release:  make(chan struct{}),
	}
	reconciler, err := New(Config{
		Source:   source,
		Store:    &fakeStore{},
		Target:   "tokyo3",
		Interval: time.Hour,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- reconciler.Run(ctx) }()
	<-source.started
	reconciler.Trigger()
	close(source.release)
	waitFor(t, func() bool { return source.callCount() == 2 })
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v, want context.Canceled", err)
	}
}

func TestRunReportsSourceErrors(t *testing.T) {
	source := &fakeSource{err: errors.New("GitLab unavailable")}
	store := &fakeStore{}
	errorsSeen := make(chan error, 1)
	reconciler, err := New(Config{
		Source:   source,
		Store:    store,
		Target:   "tokyo3",
		Interval: time.Hour,
		OnError:  func(err error) { errorsSeen <- err },
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- reconciler.Run(ctx) }()
	select {
	case err := <-errorsSeen:
		if err.Error() != "GitLab unavailable" {
			t.Fatalf("reported error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("source error was not reported")
	}
	waitFor(t, func() bool { return reconciler.SyncStatus().State == domain.SyncStateError })
	status := reconciler.SyncStatus()
	if status.LastCompletedAt.IsZero() || status.LastDuration < 0 || status.LastError != "GitLab unavailable" {
		t.Fatalf("error sync status = %+v", status)
	}
	cancel()
	<-done
}

func TestReconcileRecordsRunAndWatermark(t *testing.T) {
	activity := time.Date(2026, time.June, 1, 12, 0, 0, 0, time.UTC)
	source := &fakeSource{snapshot: domain.Snapshot{GeneratedAt: activity, Sprint: domain.Sprint{WorkItems: []domain.WorkItem{{ID: "project/42#12", LastActivity: activity}}}}}
	store := &metadataStore{}
	reconciler, err := New(Config{Source: source, Store: store, Target: "tokyo3", Interval: time.Hour, FullScanInterval: 24 * time.Hour})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	reconciler.reconcile(context.Background())
	if len(store.runs) != 1 || store.runs[0].Status != "success" || !store.runs[0].FullScan || store.runs[0].Mode != "full" || store.runs[0].ItemCount != 1 {
		t.Fatalf("sync runs = %+v", store.runs)
	}
	if store.observedID != store.runs[0].ID || store.observedAt.IsZero() || store.runs[0].SourceWatermark == nil || !store.runs[0].SourceWatermark.Equal(activity) {
		t.Fatalf("observation metadata = id %q at %s run %+v", store.observedID, store.observedAt, store.runs[0])
	}
}

func TestReconcileUsesOverlapCapableSourceBetweenFullScans(t *testing.T) {
	watermark := time.Now().UTC().Add(-10 * time.Minute)
	lastFull := time.Now().UTC().Add(-time.Hour)
	source := &incrementalSource{fakeSource: fakeSource{snapshot: domain.Snapshot{Sprint: domain.Sprint{Name: "Flow 01"}}}}
	store := &metadataStore{
		fakeStore: fakeStore{snapshot: domain.Snapshot{Sprint: domain.Sprint{Name: "Flow 01"}}, puts: 1},
		watermark: watermark,
		lastFull:  lastFull,
	}
	reconciler, err := New(Config{
		Source:           source,
		Store:            store,
		Target:           "tokyo3",
		Interval:         time.Hour,
		OverlapWindow:    5 * time.Minute,
		FullScanInterval: 24 * time.Hour,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	reconciler.reconcile(context.Background())
	if source.incremental != 1 || !source.since.Equal(watermark.Add(-5*time.Minute)) {
		t.Fatalf("incremental source = calls %d since %s", source.incremental, source.since)
	}
	if len(store.runs) != 1 || store.runs[0].Mode != "overlap" || store.runs[0].FullScan || store.runs[0].RequestedAfter == nil || !store.runs[0].RequestedAfter.Equal(source.since) {
		t.Fatalf("overlap run = %+v", store.runs)
	}
}

func TestNewValidation(t *testing.T) {
	valid := Config{Source: &fakeSource{}, Store: &fakeStore{}, Target: "tokyo3", Interval: time.Minute}
	tests := []struct {
		name string
		cfg  Config
	}{
		{name: "missing source", cfg: Config{Store: valid.Store, Target: valid.Target, Interval: valid.Interval}},
		{name: "missing store", cfg: Config{Source: valid.Source, Target: valid.Target, Interval: valid.Interval}},
		{name: "missing target", cfg: Config{Source: valid.Source, Store: valid.Store, Interval: valid.Interval}},
		{name: "invalid interval", cfg: Config{Source: valid.Source, Store: valid.Store, Target: valid.Target}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := New(test.cfg); err == nil {
				t.Fatal("New() error = nil, want validation error")
			}
		})
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition was not met before timeout")
}
