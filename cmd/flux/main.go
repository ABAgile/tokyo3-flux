package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"abagile.com/tokyo3/flux/internal/action"
	"abagile.com/tokyo3/flux/internal/api"
	fluxauth "abagile.com/tokyo3/flux/internal/auth"
	humancontext "abagile.com/tokyo3/flux/internal/context"
	"abagile.com/tokyo3/flux/internal/domain"
	"abagile.com/tokyo3/flux/internal/fixture"
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
	case "changes":
		return runChanges(args[1:], stdout, stderr)
	case "history":
		return runHistory(args[1:], stdout, stderr)
	case "snapshot":
		return runHistoricalSnapshot(args[1:], stdout, stderr)
	case "flow":
		return runFlow(args[1:], stdout, stderr)
	case "context":
		return runContext(args[1:], stdout, stderr)
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
	overlapDefault, err := durationFromEnv("FLUX_RECONCILE_OVERLAP", 5*time.Minute)
	if err != nil {
		return err
	}
	fullScanDefault, err := durationFromEnv("FLUX_FULL_SCAN_INTERVAL", 24*time.Hour)
	if err != nil {
		return err
	}
	historyRetentionDefault, err := durationFromEnv("FLUX_HISTORY_RETENTION", 365*24*time.Hour)
	if err != nil {
		return err
	}
	contextRetentionDefault, err := durationFromEnv("FLUX_CONTEXT_RETENTION", 90*24*time.Hour)
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
	stateDir := flags.String("state-dir", envOrDefault("FLUX_STATE_DIR", ".flux-state"), "directory for the cached snapshot, history, and event logs")
	fixturePath := flags.String("fixture", os.Getenv("FLUX_FIXTURE_FILE"), "normalized snapshot file for local fixture mode")
	oauthClientID := flags.String("gitlab-oauth-client-id", os.Getenv("FLUX_GITLAB_OAUTH_CLIENT_ID"), "GitLab OAuth application client ID")
	oauthRedirectURL := flags.String("gitlab-oauth-redirect-url", os.Getenv("FLUX_GITLAB_OAUTH_REDIRECT_URL"), "absolute GitLab OAuth callback URL")
	interval := flags.Duration("reconcile-interval", intervalDefault, "periodic GitLab reconciliation interval")
	overlapWindow := flags.Duration("reconcile-overlap", overlapDefault, "source activity overlap window for incremental pulls")
	fullScanInterval := flags.Duration("full-scan-interval", fullScanDefault, "maximum interval between full source scans")
	historyRetention := flags.Duration("history-retention", historyRetentionDefault, "duration to retain derived history; 0 disables pruning")
	contextRetention := flags.Duration("context-retention", contextRetentionDefault, "duration to retain human context; 0 disables pruning")
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
	if *overlapWindow < 0 {
		return errors.New("reconcile overlap must not be negative")
	}
	if *fullScanInterval <= 0 {
		return errors.New("full scan interval must be positive")
	}
	if *historyRetention < 0 {
		return errors.New("history retention must not be negative")
	}
	if *contextRetention < 0 {
		return errors.New("context retention must not be negative")
	}

	fixtureMode := strings.TrimSpace(*fixturePath) != ""
	target := strings.TrimSpace(*gitlabGroup)
	if fixtureMode {
		if !isLoopbackAddress(*addr) {
			return errors.New("fixture mode requires a loopback listen address, for example 127.0.0.1:8080")
		}
		if target == "" {
			target = "fixture"
		}
	} else if target == "" {
		return errors.New("GitLab group is required")
	}

	sessionKey, err := serveSessionKey(os.Getenv("FLUX_SESSION_KEY"), fixtureMode)
	if err != nil {
		return fmt.Errorf("parse FLUX_SESSION_KEY: %w", err)
	}
	machineToken, err := fluxauth.NewMachineToken(os.Getenv("FLUX_API_TOKEN"))
	if err != nil {
		return fmt.Errorf("configure FLUX_API_TOKEN: %w", err)
	}
	var (
		source          reconcile.Source
		milestoneSource api.MilestoneSource
		actionReader    action.IssueReader
		actionLabels    action.LabelReader
		mutationClient  *gitlab.MutationClient
	)
	if fixtureMode {
		fixtureSource, fixtureErr := fixture.New(*fixturePath)
		if fixtureErr != nil {
			return fmt.Errorf("configure fixture source: %w", fixtureErr)
		}
		source = fixtureSource
		milestoneSource = fixtureSource
		actionReader = fixtureSource
		actionLabels = fixtureSource
	} else {
		client, clientErr := gitlab.New(gitlab.Config{
			URL:           *gitlabURL,
			Token:         envFirst("FLUX_GITLAB_SERVICE_TOKEN", "FLUX_GITLAB_TOKEN"),
			BlockedLabels: splitList(*blockedLabels),
		})
		if clientErr != nil {
			return fmt.Errorf("configure GitLab client: %w", clientErr)
		}
		source = client
		milestoneSource = client
		actionReader = client
		actionLabels = client
		if mutationToken := strings.TrimSpace(os.Getenv("FLUX_GITLAB_WRITE_TOKEN")); mutationToken != "" {
			mutationClient, clientErr = gitlab.NewMutationClient(gitlab.Config{
				URL:           *gitlabURL,
				Token:         mutationToken,
				BlockedLabels: splitList(*blockedLabels),
			})
			if clientErr != nil {
				return fmt.Errorf("configure GitLab mutation client: %w", clientErr)
			}
		}
	}
	store, err := state.OpenFileStoreWithOptions(*stateDir, state.FileStoreOptions{
		StaleAfter:       *staleAfter,
		HistoryRetention: *historyRetention,
		ContextRetention: *contextRetention,
	})
	if err != nil {
		return fmt.Errorf("open state store: %w", err)
	}

	rt := basecli.App{Name: "flux", EnvPrefix: "FLUX"}.Setup(context.Background())
	defer rt.Shutdown()
	reconciler, err := reconcile.New(reconcile.Config{
		Source:           source,
		Store:            store,
		Target:           target,
		Goal:             *goal,
		Interval:         *interval,
		OverlapWindow:    *overlapWindow,
		FullScanInterval: *fullScanInterval,
		OnError: func(err error) {
			rt.Log.Error("pull reconciliation failed", "error", err)
		},
	})
	if err != nil {
		return fmt.Errorf("configure reconciler: %w", err)
	}
	var (
		webhookHandler http.Handler
		webhookEnabled bool
	)
	if fixtureMode {
		webhookHandler = disabledWebhookHandler("webhooks are disabled in fixture mode")
	} else if secret := strings.TrimSpace(os.Getenv("FLUX_GITLAB_WEBHOOK_SECRET")); secret == "" {
		webhookHandler = disabledWebhookHandler("webhooks are not configured")
	} else {
		webhookConfig := webhook.Config{
			Secret:        secret,
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
		webhookHandler, err = webhook.New(webhookConfig)
		if err != nil {
			return fmt.Errorf("configure webhook handler: %w", err)
		}
		webhookEnabled = true
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
	var authHandler http.Handler
	if fixtureMode {
		authHandler, err = fluxauth.NewFixture(sessions)
		if err != nil {
			return fmt.Errorf("configure fixture auth: %w", err)
		}
	} else {
		authenticator, authErr := fluxauth.NewGitLab(fluxauth.Config{
			GitLabURL:    *gitlabURL,
			ClientID:     *oauthClientID,
			ClientSecret: os.Getenv("FLUX_GITLAB_OAUTH_CLIENT_SECRET"),
			RedirectURL:  *oauthRedirectURL,
			Log:          rt.Log,
		}, sessions)
		if authErr != nil {
			return fmt.Errorf("configure GitLab OAuth: %w", authErr)
		}
		authHandler = authenticator.Handler()
	}

	apiHandler := api.NewHandlerWithMilestonesAndHistory(store, webhookHandler, *staleAfter, milestoneSource, target, *goal, reconciler, store)
	actionService, err := action.New(action.Config{
		Snapshot: store,
		Reader:   actionReader,
		Labels:   actionLabels,
		Writer:   mutationClient,
		Audit:    store,
		Trigger:  reconciler.Trigger,
		Log:      rt.Log,
	})
	if err != nil {
		return fmt.Errorf("configure GitLab actions: %w", err)
	}
	actionHandler, err := action.NewHandler(actionService, sessions)
	if err != nil {
		return fmt.Errorf("configure GitLab action HTTP handler: %w", err)
	}
	contextService, err := humancontext.New(humancontext.Config{
		Store:          store,
		Log:            rt.Log,
		RedactSubjects: splitList(os.Getenv("FLUX_CONTEXT_REDACT_SUBJECTS")),
	})
	if err != nil {
		return fmt.Errorf("configure human context service: %w", err)
	}
	contextHandler, err := humancontext.NewHandler(contextService, sessions)
	if err != nil {
		return fmt.Errorf("configure human context HTTP handler: %w", err)
	}
	syncHandler, err := api.NewSyncHandler(reconciler, sessions)
	if err != nil {
		return fmt.Errorf("configure manual sync handler: %w", err)
	}
	cockpitHandler := fluxweb.NewHandler(apiHandler)
	browserAPIHandler := sessions.Gate(apiHandler)
	machineAPIHandler := machineToken.Gate(apiHandler, browserAPIHandler)
	syncRoute := machineToken.Gate(syncHandler, sessions.Gate(syncHandler))
	contextRoute := sessions.Gate(contextHandler)
	routes := http.NewServeMux()
	routes.Handle("/auth/", authHandler)
	routes.Handle("/api/sync/status", machineAPIHandler)
	routes.Handle("/api/sync/csrf", syncRoute)
	routes.Handle("/api/sync", syncRoute)
	routes.Handle("/api/context/csrf", contextRoute)
	routes.Handle("/api/context/plan", contextRoute)
	routes.Handle("/api/context/confirm", contextRoute)
	routes.Handle("/api/context/redact/plan", contextRoute)
	routes.Handle("/api/context/redact/confirm", contextRoute)
	routes.Handle("/api/actions/", sessions.Gate(actionHandler))
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

	mode := "live"
	if fixtureMode {
		mode = "fixture"
	}
	rt.Log.Info("Flux server started", "version", baseversion.Resolve(Version), "addr", *addr, "group", target, "state_dir", *stateDir, "reconcile_interval", *interval, "reconcile_overlap", *overlapWindow, "full_scan_interval", *fullScanInterval, "history_retention", *historyRetention, "context_retention", *contextRetention, "mutation_enabled", mutationClient != nil, "webhook_enabled", webhookEnabled, "mode", mode, "fixture", strings.TrimSpace(*fixturePath))

	return baserun.Group(rt.Ctx,
		baserun.HTTPServer(server, 10*time.Second, false),
		reconciler.Run,
	)
}

func runHistory(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("history", flag.ContinueOnError)
	flags.SetOutput(stderr)
	stateDir := flags.String("state-dir", envOrDefault("FLUX_STATE_DIR", ".flux-state"), "directory containing Flux history")
	itemID := flags.String("item", "", "work-item ID to inspect")
	sinceRaw := flags.String("since", "", "inclusive RFC3339 lower bound for Flux observations")
	untilRaw := flags.String("until", "", "exclusive RFC3339 upper bound for Flux observations")
	limit := flags.Int("limit", state.DefaultHistoryLimit, "maximum number of changes to print")
	milestone := flags.String("milestone", "", "filter by milestone name")
	includeBaseline := flags.Bool("include-baseline", true, "include the initial baseline observation")
	jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("history accepts flags only")
	}
	if strings.TrimSpace(*itemID) == "" {
		return errors.New("history requires --item")
	}
	if *limit < 1 || *limit > state.MaxHistoryLimit {
		return fmt.Errorf("limit must be between 1 and %d", state.MaxHistoryLimit)
	}
	since, err := parseTimeFlag(*sinceRaw, "since")
	if err != nil {
		return err
	}
	until, err := parseTimeFlag(*untilRaw, "until")
	if err != nil {
		return err
	}
	if !since.IsZero() && !until.IsZero() && !until.After(since) {
		return errors.New("until must be after since")
	}
	return runHistoryQuery(*stateDir, state.ChangeQuery{
		Since:           since,
		Until:           until,
		ItemID:          *itemID,
		Milestone:       *milestone,
		Limit:           *limit,
		IncludeBaseline: *includeBaseline,
	}, *jsonOutput, stdout)
}

func runHistoryQuery(stateDir string, query state.ChangeQuery, jsonOutput bool, stdout io.Writer) error {
	store, err := state.OpenFileStore(stateDir)
	if err != nil {
		return fmt.Errorf("open state store: %w", err)
	}
	result, err := store.Changes(query)
	if err != nil {
		return fmt.Errorf("read history: %w", err)
	}
	if jsonOutput {
		return renderChangesJSON(stdout, result)
	}
	return renderChanges(stdout, result)
}

func runHistoricalSnapshot(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("snapshot", flag.ContinueOnError)
	flags.SetOutput(stderr)
	stateDir := flags.String("state-dir", envOrDefault("FLUX_STATE_DIR", ".flux-state"), "directory containing Flux history")
	atRaw := flags.String("at", "", "RFC3339 observation time; defaults to the latest observation")
	staleAfter := flags.Duration("stale-after", 7*24*time.Hour, "duration without activity before work is stale")
	jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("snapshot accepts flags only")
	}
	at, err := parseTimeFlag(*atRaw, "at")
	if err != nil {
		return err
	}
	store, err := state.OpenFileStore(*stateDir)
	if err != nil {
		return fmt.Errorf("open state store: %w", err)
	}
	result, err := store.SnapshotAt(at)
	if err != nil {
		return fmt.Errorf("read historical snapshot: %w", err)
	}
	if *jsonOutput {
		return renderHistoricalSnapshotJSON(stdout, result)
	}
	return renderHistoricalSnapshot(stdout, result, *staleAfter)
}

func runFlow(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("flow", flag.ContinueOnError)
	flags.SetOutput(stderr)
	stateDir := flags.String("state-dir", envOrDefault("FLUX_STATE_DIR", ".flux-state"), "directory containing Flux history")
	fromRaw := flags.String("from", "", "inclusive RFC3339 lower bound for Flux observations")
	toRaw := flags.String("to", "", "exclusive RFC3339 upper bound for Flux observations")
	itemID := flags.String("item", "", "filter by a work-item ID")
	milestone := flags.String("milestone", "", "filter by milestone name")
	jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("flow accepts flags only")
	}
	from, err := parseTimeFlag(*fromRaw, "from")
	if err != nil {
		return err
	}
	to, err := parseTimeFlag(*toRaw, "to")
	if err != nil {
		return err
	}
	if !from.IsZero() && !to.IsZero() && !to.After(from) {
		return errors.New("to must be after from")
	}
	store, err := state.OpenFileStore(*stateDir)
	if err != nil {
		return fmt.Errorf("open state store: %w", err)
	}
	result, err := store.Flow(state.FlowQuery{From: from, Until: to, ItemID: *itemID, Milestone: *milestone})
	if err != nil {
		return fmt.Errorf("read flow: %w", err)
	}
	if *jsonOutput {
		return renderFlowJSON(stdout, result)
	}
	return renderFlow(stdout, result)
}

func renderHistoricalSnapshotJSON(w io.Writer, result state.SnapshotResult) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return encoder.Encode(result)
}

func renderHistoricalSnapshot(w io.Writer, result state.SnapshotResult, staleAfter time.Duration) error {
	if _, err := fmt.Fprintf(w, "As of: %s\n", result.AsOf.Format(time.RFC3339)); err != nil {
		return err
	}
	if !result.ObservedAt.IsZero() {
		if _, err := fmt.Fprintf(w, "Observed: %s\n", result.ObservedAt.Format(time.RFC3339)); err != nil {
			return err
		}
	}
	if result.SyncRunID != "" {
		if _, err := fmt.Fprintf(w, "Sync run: %s\n", result.SyncRunID); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintf(w, "Snapshot generated: %s\n", result.Snapshot.GeneratedAt.Format(time.RFC3339)); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "Milestone: %s\n", result.Snapshot.Sprint.Name); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "Work: %d items\n", len(result.Snapshot.Sprint.WorkItems)); err != nil {
		return err
	}
	for _, item := range result.Snapshot.Sprint.WorkItems {
		status := domain.DeriveStatus(item, result.Snapshot.GeneratedAt, staleAfter)
		if _, err := fmt.Fprintf(w, "- %s · %s · %s\n", status, item.ID, item.Title); err != nil {
			return err
		}
	}
	return renderUncertainties(w, result.Uncertainties)
}

func renderFlowJSON(w io.Writer, result state.FlowResult) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return encoder.Encode(result)
}

func renderFlow(w io.Writer, result state.FlowResult) error {
	if result.From != nil || result.Until != nil {
		from, until := "beginning", "latest"
		if result.From != nil {
			from = result.From.Format(time.RFC3339)
		}
		if result.Until != nil {
			until = result.Until.Format(time.RFC3339)
		}
		if _, err := fmt.Fprintf(w, "Flow: %s to %s\n", from, until); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintf(w, "Changes: %d · added %d · started %d · completed %d · reopened %d\n", result.Changes, result.Added, result.Started, result.Completed, result.Reopened); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "Blocked: %d · unblocked %d · status transitions %d · milestone changes %d\n", result.Blocked, result.Unblocked, result.StatusTransitions, result.MilestoneChanges); err != nil {
		return err
	}
	if len(result.Buckets) > 0 {
		if _, err := fmt.Fprintln(w, "Daily:"); err != nil {
			return err
		}
		for _, bucket := range result.Buckets {
			if _, err := fmt.Fprintf(w, "- %s · %d changes · %d completed · %d blocked\n", bucket.Date, bucket.Changes, bucket.Completed, bucket.Blocked); err != nil {
				return err
			}
		}
	}
	return renderUncertainties(w, result.Uncertainties)
}

func runContext(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("context", flag.ContinueOnError)
	flags.SetOutput(stderr)
	stateDir := flags.String("state-dir", envOrDefault("FLUX_STATE_DIR", ".flux-state"), "directory containing confirmed human context")
	fromRaw := flags.String("from", "", "inclusive RFC3339 lower bound for reporting-window overlap")
	toRaw := flags.String("to", "", "exclusive RFC3339 upper bound for reporting-window overlap")
	itemID := flags.String("item", "", "filter by a work-item ID")
	kind := flags.String("kind", "", "filter by context kind")
	limit := flags.Int("limit", state.DefaultContextLimit, "maximum number of context records to print")
	jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("context accepts flags only")
	}
	if *limit < 1 || *limit > state.MaxContextLimit {
		return fmt.Errorf("limit must be between 1 and %d", state.MaxContextLimit)
	}
	from, err := parseTimeFlag(*fromRaw, "from")
	if err != nil {
		return err
	}
	to, err := parseTimeFlag(*toRaw, "to")
	if err != nil {
		return err
	}
	if !from.IsZero() && !to.IsZero() && !to.After(from) {
		return errors.New("to must be after from")
	}
	store, err := state.OpenFileStore(*stateDir)
	if err != nil {
		return fmt.Errorf("open state store: %w", err)
	}
	result, err := store.ListContext(state.ContextQuery{
		Since:  from,
		Until:  to,
		ItemID: *itemID,
		Kind:   *kind,
		Limit:  *limit,
	})
	if err != nil {
		return fmt.Errorf("read human context: %w", err)
	}
	if *jsonOutput {
		return renderContextJSON(stdout, result)
	}
	return renderContext(stdout, result)
}

func renderContextJSON(w io.Writer, result state.ContextResult) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return encoder.Encode(result)
}

func renderContext(w io.Writer, result state.ContextResult) error {
	if _, err := fmt.Fprintf(w, "Human context: %d confirmed records\n", len(result.Entries)); err != nil {
		return err
	}
	for _, entry := range result.Entries {
		line := fmt.Sprintf("- %s · %s · %s", entry.UpdatedAt.Format(time.RFC3339), entry.Kind, entry.Statement)
		if entry.Category != "" {
			line += " · " + entry.Category
		}
		if _, err := fmt.Fprintln(w, line); err != nil {
			return err
		}
		if entry.ReportingFrom != nil && entry.ReportingUntil != nil {
			if _, err := fmt.Fprintf(w, "  window: %s to %s\n", entry.ReportingFrom.Format(time.RFC3339), entry.ReportingUntil.Format(time.RFC3339)); err != nil {
				return err
			}
		}
		if len(entry.ItemIDs) > 0 {
			if _, err := fmt.Fprintf(w, "  items: %s\n", strings.Join(entry.ItemIDs, ", ")); err != nil {
				return err
			}
		}
	}
	return renderUncertainties(w, result.Coverage.Uncertainties)
}

func renderUncertainties(w io.Writer, uncertainties []string) error {
	if len(uncertainties) == 0 {
		return nil
	}
	if _, err := fmt.Fprintln(w, "Uncertainties:"); err != nil {
		return err
	}
	for _, uncertainty := range uncertainties {
		if _, err := fmt.Fprintf(w, "- %s\n", uncertainty); err != nil {
			return err
		}
	}
	return nil
}

func runChanges(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("changes", flag.ContinueOnError)
	flags.SetOutput(stderr)
	stateDir := flags.String("state-dir", envOrDefault("FLUX_STATE_DIR", ".flux-state"), "directory containing Flux history")
	sinceRaw := flags.String("since", "", "inclusive RFC3339 lower bound for Flux observations")
	untilRaw := flags.String("until", "", "exclusive RFC3339 upper bound for Flux observations")
	itemID := flags.String("item", "", "filter by a work-item ID")
	milestone := flags.String("milestone", "", "filter by milestone name")
	limit := flags.Int("limit", state.DefaultHistoryLimit, "maximum number of changes to print")
	includeBaseline := flags.Bool("include-baseline", false, "include the initial baseline observation")
	jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("changes accepts flags only")
	}
	if *limit < 1 || *limit > state.MaxHistoryLimit {
		return fmt.Errorf("limit must be between 1 and %d", state.MaxHistoryLimit)
	}
	since, err := parseTimeFlag(*sinceRaw, "since")
	if err != nil {
		return err
	}
	until, err := parseTimeFlag(*untilRaw, "until")
	if err != nil {
		return err
	}
	if !since.IsZero() && !until.IsZero() && !until.After(since) {
		return errors.New("until must be after since")
	}
	store, err := state.OpenFileStore(*stateDir)
	if err != nil {
		return fmt.Errorf("open state store: %w", err)
	}
	result, err := store.Changes(state.ChangeQuery{
		Since:           since,
		Until:           until,
		ItemID:          *itemID,
		Milestone:       *milestone,
		Limit:           *limit,
		IncludeBaseline: *includeBaseline,
	})
	if err != nil {
		return fmt.Errorf("read history: %w", err)
	}
	if *jsonOutput {
		return renderChangesJSON(stdout, result)
	}
	return renderChanges(stdout, result)
}

func parseTimeFlag(raw, name string) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, nil
	}
	value, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}, fmt.Errorf("%s must be RFC3339", name)
	}
	return value, nil
}

func renderChangesJSON(w io.Writer, result state.ChangeResult) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return encoder.Encode(result)
}

func renderChanges(w io.Writer, result state.ChangeResult) error {
	if result.HistoryStartedAt != nil {
		if _, err := fmt.Fprintf(w, "History started: %s\n", result.HistoryStartedAt.Format(time.RFC3339)); err != nil {
			return err
		}
	}
	if result.LastObservedAt != nil {
		if _, err := fmt.Fprintf(w, "Last observed: %s · %d observations\n", result.LastObservedAt.Format(time.RFC3339), result.Observations); err != nil {
			return err
		}
	}
	if len(result.Changes) == 0 {
		if _, err := fmt.Fprintln(w, "No historical changes recorded."); err != nil {
			return err
		}
		return renderUncertainties(w, result.Coverage.Uncertainties)
	}
	for _, change := range result.Changes {
		label := change.ItemID
		if label == "" {
			label = change.EntityKey
		}
		line := fmt.Sprintf("- %s · %s · %s", change.ObservedAt.Format(time.RFC3339), change.Kind, label)
		if change.Milestone != "" {
			line += " · " + change.Milestone
		}
		if _, err := fmt.Fprintln(w, line); err != nil {
			return err
		}
		for _, field := range change.ChangedFields {
			if _, err := fmt.Fprintf(w, "  %s: %s → %s\n", field.Field, changeValueText(field.Before), changeValueText(field.After)); err != nil {
				return err
			}
		}
	}
	return renderUncertainties(w, result.Coverage.Uncertainties)
}

func changeValueText(value any) string {
	if value == nil {
		return "∅"
	}
	data, err := json.Marshal(value)
	if err != nil {
		return "?"
	}
	return string(data)
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

func serveSessionKey(raw string, fixtureMode bool) ([]byte, error) {
	if strings.TrimSpace(raw) == "" && fixtureMode {
		return basecrypto.RandomBytes(32)
	}
	return basecrypto.ParseKEK(strings.TrimSpace(raw))
}

func isLoopbackAddress(addr string) bool {
	host, _, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		return false
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func disabledWebhookHandler(message string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, message, http.StatusNotFound)
	})
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
	Labels        []string              `json:"labels,omitempty"`
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
			Labels:        append([]string(nil), item.Item.Labels...),
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
	fmt.Fprintln(w, "  flux serve --fixture examples/today.json --addr 127.0.0.1:8080")
	fmt.Fprintln(w, "  flux changes --since 2026-01-01T00:00:00Z --json")
	fmt.Fprintln(w, "  flux history --item team/project#12 --json")
	fmt.Fprintln(w, "  flux snapshot --at 2026-01-01T00:00:00Z --json")
	fmt.Fprintln(w, "  flux flow --from 2026-01-01T00:00:00Z --json")
	fmt.Fprintln(w, "  flux context --kind delay_explanation --json")
	fmt.Fprintln(w, "  flux version")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "GitLab scope is configured with FLUX_GITLAB_GROUP.")
	fmt.Fprintln(w, "GitLab credentials are read from FLUX_GITLAB_SERVICE_TOKEN or FLUX_GITLAB_TOKEN.")
	fmt.Fprintln(w, "Live server also requires FLUX_SESSION_KEY and GitLab OAuth settings; webhook setup is optional.")
	fmt.Fprintln(w, "Use --fixture or FLUX_FIXTURE_FILE for a loopback-only offline cockpit server.")
	fmt.Fprintln(w, "Use flux changes, history, snapshot, and flow to inspect the derived historical read model.")
	fmt.Fprintln(w, "Use flux context to inspect confirmed human-reported delivery context; it does not alter derived state.")
}
