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

	reconciler.Trigger()
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
	cancel()
	<-done
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
