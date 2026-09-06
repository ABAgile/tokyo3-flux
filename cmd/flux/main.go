package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"abagile.com/tokyo3/flux/internal/api"
	fluxauth "abagile.com/tokyo3/flux/internal/auth"
	"abagile.com/tokyo3/flux/internal/domain"
	"abagile.com/tokyo3/flux/internal/gitlab"
	"abagile.com/tokyo3/flux/internal/reconcile"
	"abagile.com/tokyo3/flux/internal/state"
	fluxweb "abagile.com/tokyo3/flux/internal/web"
	"abagile.com/tokyo3/flux/internal/webhook"
	basecli "github.com/abagile/tokyo3-base/cli"
	basecrypto "github.com/abagile/tokyo3-base/crypto"
	baserun "github.com/abagile/tokyo3-base/run"
	basesession "github.com/abagile/tokyo3-base/session"
	baseversion "github.com/abagile/tokyo3-base/version"
)

const appName = "flux"

// Version is overridden at build time via -ldflags "-X main.Version=...".
// version.Resolve falls back to Go build information for source-tree and
// module-version builds.
var Version = "dev"

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "flux:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		printUsage(stdout)
		return nil
	}

	switch args[0] {
	case "today":
		return runToday(args[1:], stdout, stderr)
	case "serve":
		return runServe(args[1:], stderr)
	case "version":
		_, err := fmt.Fprintf(stdout, "%s %s\n", appName, baseversion.Resolve(Version))
		return err
	case "help", "-h", "--help":
		printUsage(stdout)
		return nil
	default:
		printUsage(stderr)
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func runToday(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("today", flag.ContinueOnError)
	flags.SetOutput(stderr)
	inputPath := flags.String("input", "", "normalized snapshot file, or - for stdin")
	gitlabURL := flags.String("gitlab-url", os.Getenv("FLUX_GITLAB_URL"), "GitLab base URL")
	gitlabGroup := flags.String("gitlab-group", os.Getenv("FLUX_GITLAB_GROUP"), "GitLab group ID or full path")
	goal := flags.String("goal", os.Getenv("FLUX_SPRINT_GOAL"), "optional sprint goal override; otherwise use the milestone description")
	blockedLabels := flags.String("blocked-labels", envOrDefault("FLUX_GITLAB_BLOCKED_LABELS", "status::blocked,blocked"), "comma-separated labels treated as blocked")
	staleAfter := flags.Duration("stale-after", 7*24*time.Hour, "duration without activity before work is stale")
	jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("today accepts flags only")
	}

	target := strings.TrimSpace(*gitlabGroup)
	if *inputPath == "" && target == "" {
		return errors.New("GitLab group is required")
	}
	snapshot, err := loadSnapshot(*inputPath, gitlab.Config{
		URL:           *gitlabURL,
		Token:         envFirst("FLUX_GITLAB_SERVICE_TOKEN", "FLUX_GITLAB_TOKEN"),
		BlockedLabels: splitList(*blockedLabels),
	}, target, *goal)
	if err != nil {
		return err
	}

	now := snapshot.GeneratedAt
	if now.IsZero() {
		now = time.Now().UTC()
	}
	summary := domain.Summarize(snapshot.Sprint, now, *staleAfter)
	if *jsonOutput {
		return renderTodayJSON(stdout, snapshot, summary)
	}
	return renderToday(stdout, snapshot, summary)
}

func runServe(args []string, stderr io.Writer) error {
	intervalDefault, err := durationFromEnv("FLUX_RECONCILE_INTERVAL", 5*time.Minute)
	if err != nil {
		return err
	}

	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(stderr)
	addr := flags.String("addr", envOrDefault("FLUX_ADDR", "127.0.0.1:8080"), "HTTP listen address")
	gitlabURL := flags.String("gitlab-url", os.Getenv("FLUX_GITLAB_URL"), "GitLab base URL")
	gitlabGroup := flags.String("gitlab-group", os.Getenv("FLUX_GITLAB_GROUP"), "GitLab group ID or full path")
	goal := flags.String("goal", os.Getenv("FLUX_SPRINT_GOAL"), "optional sprint goal override; otherwise use the milestone description")
	blockedLabels := flags.String("blocked-labels", envOrDefault("FLUX_GITLAB_BLOCKED_LABELS", "status::blocked,blocked"), "comma-separated labels treated as blocked")
	stateDir := flags.String("state-dir", envOrDefault("FLUX_STATE_DIR", ".flux-state"), "directory for the cached snapshot and webhook event log")
	oauthClientID := flags.String("gitlab-oauth-client-id", os.Getenv("FLUX_GITLAB_OAUTH_CLIENT_ID"), "GitLab OAuth application client ID")
	oauthRedirectURL := flags.String("gitlab-oauth-redirect-url", os.Getenv("FLUX_GITLAB_OAUTH_REDIRECT_URL"), "absolute GitLab OAuth callback URL")
	interval := flags.Duration("reconcile-interval", intervalDefault, "periodic GitLab reconciliation interval")
	staleAfter := flags.Duration("stale-after", 7*24*time.Hour, "duration without activity before work is stale")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("serve accepts flags only")
	}
	if *interval <= 0 {
		return errors.New("reconcile interval must be positive")
	}

	target := strings.TrimSpace(*gitlabGroup)
	if target == "" {
		return errors.New("GitLab group is required")
	}

	sessionKey, err := basecrypto.ParseKEK(strings.TrimSpace(os.Getenv("FLUX_SESSION_KEY")))
	if err != nil {
		return fmt.Errorf("parse FLUX_SESSION_KEY: %w", err)
	}
	machineToken, err := fluxauth.NewMachineToken(os.Getenv("FLUX_API_TOKEN"))
	if err != nil {
		return fmt.Errorf("configure FLUX_API_TOKEN: %w", err)
	}
	client, err := gitlab.New(gitlab.Config{
		URL:           *gitlabURL,
		Token:         envFirst("FLUX_GITLAB_SERVICE_TOKEN", "FLUX_GITLAB_TOKEN"),
		BlockedLabels: splitList(*blockedLabels),
	})
	if err != nil {
		return fmt.Errorf("configure GitLab client: %w", err)
	}
	store, err := state.OpenFileStore(*stateDir)
	if err != nil {
		return fmt.Errorf("open state store: %w", err)
	}

	rt := basecli.App{Name: "flux", EnvPrefix: "FLUX"}.Setup(context.Background())
	defer rt.Shutdown()
	reconciler, err := reconcile.New(reconcile.Config{
		Source:   client,
		Store:    store,
		Target:   target,
		Goal:     *goal,
		Interval: *interval,
		OnError: func(err error) {
			rt.Log.Error("GitLab reconciliation failed", "error", err)
		},
	})
	if err != nil {
		return fmt.Errorf("configure reconciler: %w", err)
	}
	webhookConfig := webhook.Config{
		Secret:        os.Getenv("FLUX_GITLAB_WEBHOOK_SECRET"),
		ExpectedGroup: target,
		Trigger:       reconciler.Trigger,
		OnEvent: func(event webhook.Event) error {
			return store.RecordEvent(state.Event{
				Kind:        event.Kind,
				DeliveryID:  event.DeliveryID,
				ProjectID:   event.ProjectID,
				ProjectPath: event.ProjectPath,
				GroupID:     event.GroupID,
				GroupPath:   event.GroupPath,
				ReceivedAt:  event.ReceivedAt,
			})
		},
	}
	webhookHandler, err := webhook.New(webhookConfig)
	if err != nil {
		return fmt.Errorf("configure webhook handler: %w", err)
	}

	sessions, err := basesession.New(basesession.Config{
		SessionKey:   sessionKey,
		CookiePrefix: "flux",
		SessionTTL:   8 * time.Hour,
		ExemptPaths:  []string{"/healthz", "/readyz", "/webhooks/gitlab", "/auth/callback"},
		Log:          rt.Log,
	})
	if err != nil {
		return fmt.Errorf("configure sessions: %w", err)
	}
	authenticator, err := fluxauth.NewGitLab(fluxauth.Config{
		GitLabURL:    *gitlabURL,
		ClientID:     *oauthClientID,
		ClientSecret: os.Getenv("FLUX_GITLAB_OAUTH_CLIENT_SECRET"),
		RedirectURL:  *oauthRedirectURL,
		Log:          rt.Log,
	}, sessions)
	if err != nil {
		return fmt.Errorf("configure GitLab OAuth: %w", err)
	}

	apiHandler := api.NewHandlerWithMilestones(store, webhookHandler, *staleAfter, client, target, *goal)
	cockpitHandler := fluxweb.NewHandler(apiHandler)
	browserAPIHandler := sessions.Gate(apiHandler)
	machineAPIHandler := machineToken.Gate(apiHandler, browserAPIHandler)
	routes := http.NewServeMux()
	routes.Handle("/auth/", authenticator.Handler())
	routes.Handle("/api/", machineAPIHandler)
	routes.Handle("/", sessions.Gate(cockpitHandler))
	server := &http.Server{
		Addr:              *addr,
		Handler:           routes,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	rt.Log.Info("Flux server started", "version", baseversion.Resolve(Version), "addr", *addr, "group", target, "state_dir", *stateDir, "reconcile_interval", *interval)

	return baserun.Group(rt.Ctx,
		baserun.HTTPServer(server, 10*time.Second, false),
		reconciler.Run,
	)
}

func durationFromEnv(name string, fallback time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	duration, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", name, err)
	}
	return duration, nil
}

func loadSnapshot(inputPath string, cfg gitlab.Config, target, goal string) (domain.Snapshot, error) {
	if inputPath != "" {
		reader := io.Reader(os.Stdin)
		var input io.ReadCloser
		if inputPath != "-" {
			file, err := os.Open(inputPath)
			if err != nil {
				return domain.Snapshot{}, fmt.Errorf("open input: %w", err)
			}
			input = file
			defer input.Close()
			reader = file
		}

		var snapshot domain.Snapshot
		if err := json.NewDecoder(reader).Decode(&snapshot); err != nil {
			return domain.Snapshot{}, fmt.Errorf("decode snapshot: %w", err)
		}
		return snapshot, nil
	}

	client, err := gitlab.New(cfg)
	if err != nil {
		return domain.Snapshot{}, fmt.Errorf("configure GitLab client: %w", err)
	}
	snapshot, err := client.Snapshot(context.Background(), target, goal)
	if err != nil {
		return domain.Snapshot{}, fmt.Errorf("load GitLab snapshot: %w", err)
	}
	return snapshot, nil
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envFirst(names ...string) string {
	for _, name := range names {
		if value := os.Getenv(name); value != "" {
			return value
		}
	}
	return ""
}

func splitList(value string) []string {
	var result []string
	for entry := range strings.SplitSeq(value, ",") {
		if entry = strings.TrimSpace(entry); entry != "" {
			result = append(result, entry)
		}
	}
	return result
}

type todayJSONResponse struct {
	GeneratedAt time.Time        `json:"generated_at"`
	Sprint      todayJSONSprint  `json:"sprint"`
	Summary     todayJSONSummary `json:"summary"`
}

type todayJSONSprint struct {
	Name string `json:"name"`
	Goal string `json:"goal,omitempty"`
}

type todayJSONSummary struct {
	Total  int             `json:"total"`
	Counts map[string]int  `json:"counts"`
	Items  []todayJSONItem `json:"items"`
}

type todayJSONItem struct {
	ID            string                `json:"id"`
	ProjectID     int                   `json:"project_id,omitempty"`
	ProjectPath   string                `json:"project_path,omitempty"`
	Title         string                `json:"title"`
	State         domain.IssueState     `json:"state"`
	Assignee      string                `json:"assignee,omitempty"`
	Blocked       bool                  `json:"blocked"`
	LastActivity  time.Time             `json:"last_activity"`
	Status        domain.Status         `json:"status"`
	MergeRequests []domain.MergeRequest `json:"merge_requests,omitempty"`
}

func renderTodayJSON(w io.Writer, snapshot domain.Snapshot, summary domain.Summary) error {
	counts := make(map[string]int)
	for _, status := range []domain.Status{
		domain.StatusTodo,
		domain.StatusInProgress,
		domain.StatusAwaitingReview,
		domain.StatusPipelineFailed,
		domain.StatusBlocked,
		domain.StatusStale,
		domain.StatusDone,
	} {
		counts[string(status)] = summary.Count(status)
	}
	response := todayJSONResponse{
		GeneratedAt: snapshot.GeneratedAt,
		Sprint: todayJSONSprint{
			Name: snapshot.Sprint.Name,
			Goal: snapshot.Sprint.Goal,
		},
		Summary: todayJSONSummary{
			Total:  summary.Total(),
			Counts: counts,
			Items:  make([]todayJSONItem, 0, len(summary.Items)),
		},
	}
	for _, item := range summary.Items {
		response.Summary.Items = append(response.Summary.Items, todayJSONItem{
			ID:            item.Item.ID,
			ProjectID:     item.Item.ProjectID,
			ProjectPath:   item.Item.ProjectPath,
			Title:         item.Item.Title,
			State:         item.Item.State,
			Assignee:      item.Item.Assignee,
			Blocked:       item.Item.Blocked,
			LastActivity:  item.Item.LastActivity,
			Status:        item.Status,
			MergeRequests: item.Item.MergeRequests,
		})
	}
	return json.NewEncoder(w).Encode(response)
}

func renderToday(w io.Writer, snapshot domain.Snapshot, summary domain.Summary) error {
	if _, err := fmt.Fprintf(w, "Sprint: %s\n", snapshot.Sprint.Name); err != nil {
		return err
	}
	if snapshot.Sprint.Goal != "" {
		if _, err := fmt.Fprintf(w, "Goal:   %s\n", snapshot.Sprint.Goal); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintf(w, "Work:   %d total, %d done, %d blocked, %d awaiting review, %d pipeline failing\n\n",
		summary.Total(),
		summary.Count(domain.StatusDone),
		summary.Count(domain.StatusBlocked),
		summary.Count(domain.StatusAwaitingReview),
		summary.Count(domain.StatusPipelineFailed),
	); err != nil {
		return err
	}

	for _, item := range summary.Items {
		if _, err := fmt.Fprintf(w, "- %-12s %-18s %s\n", item.Item.ID, item.Status, item.Item.Title); err != nil {
			return err
		}
	}
	return nil
}

func printUsage(w io.Writer) {
	fmt.Fprintln(w, "flux - a minimal, fluid SDLC cockpit")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  flux today --input snapshot.json [--stale-after 168h] [--json]")
	fmt.Fprintln(w, "  flux today --gitlab-url URL --gitlab-group GROUP [--json]")
	fmt.Fprintln(w, "  flux serve --addr 127.0.0.1:8080")
	fmt.Fprintln(w, "  flux version")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "GitLab scope is configured with FLUX_GITLAB_GROUP.")
	fmt.Fprintln(w, "GitLab credentials are read from FLUX_GITLAB_SERVICE_TOKEN or FLUX_GITLAB_TOKEN.")
	fmt.Fprintln(w, "The server also requires FLUX_GITLAB_WEBHOOK_SECRET, FLUX_SESSION_KEY, and GitLab OAuth settings.")
}
