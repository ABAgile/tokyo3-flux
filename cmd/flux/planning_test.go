package main

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"

	"abagile.com/tokyo3/flux/internal/store"
	"github.com/abagile/tokyo3-base/cli"
)

func TestPlanValidation(t *testing.T) {
	for _, args := range [][]string{nil, {"unknown"}, {"serve", "--demo", "--addr", "0.0.0.0:8080"}, {"serve", "--name", "unused"}, {"migrate", "--addr", "unused"}, {"bootstrap"}, {"bootstrap", "--workspace", "unused"}, {"member"}, {"member", "--name", "unused"}, {"seed"}, {"seed", "--demo"}, {"migrate", "extra"}, {"serve", "--bad"}} {
		var out bytes.Buffer
		if err := runPlan(args, &out, &out); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
	t.Setenv("FLUX_SESSION_KEY", "")
	var out bytes.Buffer
	if err := run([]string{"serve"}, &out, &out); err == nil {
		t.Fatal("production without session key")
	}
	if err := run([]string{"plan", "serve"}, &out, &out); err == nil {
		t.Fatal("accepted retired plan alias")
	}
}
func TestReadConnectorValidationBeforeDatabase(t *testing.T) {
	t.Setenv("FLUX_SESSION_KEY", "")
	t.Setenv("FLUX_DATABASE_URL", "deliberately-invalid")
	t.Setenv("FLUX_GITLAB_URL", "http://non-loopback.example")
	t.Setenv("FLUX_GITLAB_SERVICE_TOKEN", "read-secret")
	var out bytes.Buffer
	err := runPlan([]string{"serve", "--demo"}, &out, &out)
	if err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatal("connector validation must precede DB startup", err)
	}
}
func TestPlanningSeed(t *testing.T) {
	dsn := os.Getenv("FLUX_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set FLUX_TEST_DATABASE_URL for PostgreSQL seed integration")
	}
	// Use the store integration tests for schema isolation. This test uses a
	// dedicated database supplied by the test operator and unique workspace IDs.
	ctx := context.Background()
	s, err := store.Open(ctx, cli.DB{URL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	pr, err := s.Bootstrap(ctx, "Seed test", "Seed test", "fixture-user")
	if err != nil {
		t.Fatal(err)
	}
	if err = seedPlanning(ctx, s, pr.ID, "", "fixture-user"); err != nil {
		t.Fatal(err)
	}
	b, err := s.Board(ctx, pr.ID, "fixture-user")
	if err != nil || len(b.Items) != 8 || len(b.Sprints) != 2 {
		t.Fatalf("seed: items=%d sprints=%d err=%v", len(b.Items), len(b.Sprints), err)
	}
	if err = seedPlanning(ctx, s, pr.ID, "", "fixture-user"); err == nil {
		t.Fatal("seed overwrote existing planning")
	}
}
