package main

import (
	"bytes"
	"context"
	"net/url"
	"os"
	"strings"
	"testing"

	"abagile.com/tokyo3/flux/internal/planning"
	"abagile.com/tokyo3/flux/internal/store"
	"github.com/abagile/tokyo3-base/cli"
	"github.com/abagile/tokyo3-base/ratelimit"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := "flux_seed_test_" + strings.ToLower(planning.NewID())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(ctx, "DROP SCHEMA "+quoted+" CASCADE"); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	databaseURL, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := databaseURL.Query()
	query.Set("search_path", schema)
	databaseURL.RawQuery = query.Encode()
	s, err := store.Open(ctx, cli.DB{URL: databaseURL.String()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
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

func TestRateLimitSettings(t *testing.T) {
	api, auth, err := rateLimitSettings()
	if err != nil {
		t.Fatal(err)
	}
	if api.RPS != defaultRateLimitRPS || api.Burst != defaultRateLimitBurst {
		t.Fatalf("unset environment did not take the defaults: %+v", api)
	}
	if auth.RPS != authRateLimitRPS || auth.Burst != authRateLimitBurst {
		t.Fatalf("auth limiter must stay tighter than the API limiter: %+v", auth)
	}
	if api.OnThrottle == nil {
		t.Fatal("throttled requests must get a JSON renderer")
	}

	t.Setenv("FLUX_RATE_LIMIT_RPS", "-1")
	if api, auth, err = rateLimitSettings(); err != nil {
		t.Fatal(err)
	}
	if ratelimit.New(api) != nil || ratelimit.New(auth) != nil {
		t.Fatal("a negative rate must disable both limiters")
	}

	t.Setenv("FLUX_RATE_LIMIT_RPS", "not-a-number")
	if _, _, err = rateLimitSettings(); err == nil {
		t.Fatal("an invalid rate must fail fast")
	}
	t.Setenv("FLUX_RATE_LIMIT_RPS", "")
	t.Setenv("FLUX_TRUSTED_PROXIES", "not-a-cidr")
	if _, _, err = rateLimitSettings(); err == nil {
		t.Fatal("an invalid trusted proxy list must fail fast")
	}
}
