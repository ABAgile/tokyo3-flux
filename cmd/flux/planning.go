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
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	fluxauth "abagile.com/tokyo3/flux/internal/auth"
	"abagile.com/tokyo3/flux/internal/blobstore"
	"abagile.com/tokyo3/flux/internal/integration"
	"abagile.com/tokyo3/flux/internal/planning"
	"abagile.com/tokyo3/flux/internal/planningui"
	"abagile.com/tokyo3/flux/internal/store"
	"github.com/abagile/tokyo3-base/cli"
	"github.com/abagile/tokyo3-base/envutil"
	"github.com/abagile/tokyo3-base/ratelimit"
	baserun "github.com/abagile/tokyo3-base/run"
	"github.com/abagile/tokyo3-base/session"
)

const (
	// defaultRateLimitRPS and defaultRateLimitBurst are sized for a shared team
	// workspace behind one NAT address: generous enough for normal board polling
	// and drag-and-drop bursts, tight enough that a single client cannot exhaust
	// the database pool.
	defaultRateLimitRPS   = 30
	defaultRateLimitBurst = 60
	// authRateLimitRPS and authRateLimitBurst guard the login and callback paths,
	// which mint cookies and call the provider. Logins are rare per user, so a
	// much tighter budget is safe and blunts credential stuffing.
	authRateLimitRPS   = 1
	authRateLimitBurst = 10
)

// rateLimitSettings parses the limiter environment up front, before any
// database or worker is opened. A negative FLUX_RATE_LIMIT_RPS disables both
// limiters; unset values take the defaults. Log is filled in by the caller once
// the runtime logger exists.
func rateLimitSettings() (api, auth ratelimit.Config, err error) {
	rps, err := envutil.Float("FLUX_RATE_LIMIT_RPS")
	if err != nil {
		return api, auth, err
	}
	if rps == 0 {
		rps = defaultRateLimitRPS
	}
	burst, err := envutil.Int("FLUX_RATE_LIMIT_BURST")
	if err != nil {
		return api, auth, err
	}
	if burst == 0 {
		burst = defaultRateLimitBurst
	}
	trusted, err := envutil.CIDRList("FLUX_TRUSTED_PROXIES")
	if err != nil {
		return api, auth, err
	}
	throttled := func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"too many requests; retry shortly"}` + "\n"))
	}
	api = ratelimit.Config{RPS: rps, Burst: burst, TrustedProxies: trusted, OnThrottle: throttled}
	auth = api
	if rps > 0 {
		auth.RPS, auth.Burst = authRateLimitRPS, authRateLimitBurst
	}
	return api, auth, nil
}

func runPlan(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: flux migrate|bootstrap|member|seed|prune|serve")
	}
	cmd := args[0]
	flags := flag.NewFlagSet("flux "+cmd, flag.ContinueOnError)
	flags.SetOutput(stderr)
	var addr, name, project, workspace, subject, memberRole string
	var demo bool
	var retentionDays int
	switch cmd {
	case "serve":
		flags.StringVar(&addr, "addr", envOrDefault("FLUX_ADDR", "127.0.0.1:8080"), "HTTP listen address")
		flags.BoolVar(&demo, "demo", false, "loopback-only synthetic login; never enable in production")
	case "bootstrap":
		flags.StringVar(&name, "name", "Workspace", "workspace name")
		flags.StringVar(&project, "project", "", "optional initial project name")
		flags.StringVar(&subject, "subject", "", "explicit admin subject")
	case "member":
		flags.StringVar(&workspace, "workspace", "", "workspace ID")
		flags.StringVar(&subject, "subject", "", "member subject")
		flags.StringVar(&memberRole, "role", "member", "viewer, member, or admin")
	case "seed":
		flags.StringVar(&workspace, "workspace", "", "workspace ID")
		flags.StringVar(&project, "project", "", "optional project ID")
		flags.StringVar(&subject, "subject", "", "member subject used for seeded records")
	case "prune":
		flags.IntVar(&retentionDays, "days", store.DefaultAuditRetentionDays, "delete audit events older than this many days")
	case "migrate":
	default:
		return fmt.Errorf("unknown planning command %q", cmd)
	}
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("planning commands accept flags only")
	}
	switch cmd {
	case "migrate":
	case "bootstrap":
		if subject == "" {
			return errors.New("bootstrap requires --subject ID; --project NAME is optional")
		}
	case "member":
		if workspace == "" || subject == "" || (memberRole != "viewer" && memberRole != "member" && memberRole != "admin") {
			return errors.New("member requires --workspace ID, --subject ID and valid --role")
		}
	case "seed":
		if workspace == "" || subject == "" {
			return errors.New("seed requires --workspace ID --subject ID; --project ID is optional")
		}
	case "prune":
		if retentionDays < store.MinAuditRetentionDays {
			return fmt.Errorf("prune requires --days of at least %d so burn-down history survives", store.MinAuditRetentionDays)
		}
	case "serve":
		if demo && !isLoopbackAddress(addr) {
			return errors.New("demo mode requires a loopback listen address")
		}
	}
	app := cli.App{Name: "flux", EnvPrefix: "FLUX"}
	material := app.DB()
	// Pruning audit history is an admin-credential operation; the runtime role
	// has no DELETE on audit_events.
	if cmd == "migrate" || cmd == "bootstrap" || cmd == "member" || cmd == "prune" {
		material = app.AdminDB()
	}
	// Validate auth before opening databases or starting workers.
	var sessions *session.Manager
	var auth http.Handler
	var machine *fluxauth.MachineToken
	machineSubject := strings.TrimSpace(os.Getenv("FLUX_API_SUBJECT"))
	if cmd == "serve" {
		key, err := serveSessionKey(os.Getenv("FLUX_SESSION_KEY"), demo)
		if err != nil {
			return err
		}
		sessions, err = session.New(session.Config{SessionKey: key, CookiePrefix: "flux_plan", TrustedOrigins: &[]string{}})
		if err != nil {
			return err
		}
		machine, err = fluxauth.NewMachineToken(os.Getenv("FLUX_API_TOKEN"))
		if err != nil {
			return err
		}
		if machine != nil && machineSubject == "" {
			return errors.New("FLUX_API_SUBJECT is required with FLUX_API_TOKEN; grant it explicit viewer membership")
		}
		if demo {
			auth, err = fluxauth.NewFixture(sessions)
		} else {
			var a *fluxauth.Authenticator
			a, err = fluxauth.NewGitLab(fluxauth.Config{GitLabURL: os.Getenv("FLUX_GITLAB_URL"), ClientID: os.Getenv("FLUX_GITLAB_OAUTH_CLIENT_ID"), ClientSecret: os.Getenv("FLUX_GITLAB_OAUTH_CLIENT_SECRET"), RedirectURL: os.Getenv("FLUX_GITLAB_OAUTH_REDIRECT_URL")}, sessions)
			if err == nil {
				auth = a.Handler()
			}
		}
		if err != nil {
			return err
		}
	}
	var connectorSettings integration.Settings
	if cmd == "serve" {
		var err error
		connectorSettings, err = integration.FromEnv()
		if err != nil {
			return err
		}
	}
	var apiLimits, authLimits ratelimit.Config
	if cmd == "serve" {
		var err error
		if apiLimits, authLimits, err = rateLimitSettings(); err != nil {
			return err
		}
	}
	var blobConfig blobstore.Config
	if cmd == "serve" {
		natsMaterial := app.NATS()
		var configErr error
		blobConfig, configErr = blobstore.ConfigFromEnv("FLUX", blobstore.NATSConfig{
			URL: natsMaterial.URL, CertFile: natsMaterial.CertFile,
			KeyFile: natsMaterial.KeyFile, CAFile: natsMaterial.CAFile,
			Credentials: os.Getenv("FLUX_NATS_CREDS"),
		})
		if configErr != nil {
			return configErr
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := store.Open(ctx, material)
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetConnector(connectorSettings.Client)
	db.SetRefreshInterval(connectorSettings.Interval)
	if cmd == "migrate" {
		return db.Migrate(ctx)
	}
	if err = db.Ready(ctx); err != nil {
		return err
	}
	switch cmd {
	case "bootstrap":
		v, e := db.Bootstrap(ctx, name, project, subject)
		if e != nil {
			return e
		}
		return json.NewEncoder(stdout).Encode(v)
	case "member":
		return db.SetMember(ctx, workspace, subject, memberRole)
	case "seed":
		return seedPlanning(ctx, db, workspace, project, subject)
	case "prune":
		// Draining a long backlog takes many batches, so pruning gets its own
		// deadline rather than the short startup one.
		pruneCtx, pruneCancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer pruneCancel()
		removed, e := db.PruneAudit(pruneCtx, retentionDays)
		if e != nil {
			return e
		}
		_, e = fmt.Fprintf(stdout, "pruned %d audit events older than %d days\n", removed, retentionDays)
		return e
	}
	rt := app.Setup(context.Background())
	defer rt.Shutdown()
	apiLimits.Log, authLimits.Log = rt.Log, rt.Log
	apiLimiter, authLimiter := ratelimit.New(apiLimits), ratelimit.New(authLimits)
	attachments, err := blobstore.New(blobConfig)
	if err != nil {
		return err
	}
	defer attachments.Close()
	api := planning.NewHTTP(db, sessions, machineSubject, demo, rt.Log, attachments)
	routes := http.NewServeMux()
	if connectorSettings.WebhookSecret != "" {
		hook, err := integration.NewWebhook(connectorSettings.WebhookSecret, connectorSettings.Client.Instance(), db.EnqueueWebhook, rt.Log)
		if err != nil {
			return err
		}
		routes.Handle("/webhooks/gitlab", hook)
	} else {
		routes.HandleFunc("/webhooks/gitlab", http.NotFound)
	}
	routes.HandleFunc("/api/", http.NotFound) // Retired cockpit API; never redirect machine consumers to login.
	routes.Handle("/auth/", authLimiter.Middleware(auth))
	routes.Handle("/api/v2/", machine.Gate(api.Handler(true), sessions.Gate(api.Handler(false))))
	routes.Handle("/", sessions.Gate(planningui.Handler()))
	routes.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	routes.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if err := db.Ready(ctx); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	imageSources := []string{"'self'", "https://gravatar.com", "https://www.gravatar.com", "https://secure.gravatar.com"}
	for _, raw := range []string{os.Getenv("FLUX_GITLAB_URL"), connectorSettings.Client.Instance()} {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
			continue
		}
		source := u.Scheme + "://" + u.Host
		if !slices.Contains(imageSources, source) {
			imageSources = append(imageSources, source)
		}
	}
	contentSecurityPolicy := "default-src 'self'; script-src 'self'; style-src 'self'; img-src " + strings.Join(imageSources, " ") + "; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
	limited := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if demo {
			host := r.Host
			if h, _, e := net.SplitHostPort(host); e == nil {
				host = h
			}
			ip := net.ParseIP(strings.Trim(host, "[]"))
			if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
				http.Error(w, "demo requires loopback host", http.StatusForbidden)
				return
			}
		}
		w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
		// Session cookies must never be offered over cleartext. Browsers ignore
		// this header on plaintext responses, so it is safe behind a TLS
		// terminator and on the loopback demo listener alike.
		w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		routes.ServeHTTP(w, r)
	})
	// Probes stay exempt so throttling never makes an instance look unhealthy.
	handler := apiLimiter.Middleware(limited, "/healthz", "/readyz")
	// Body read/write bounds must cover a full attachment transfer; slow-start
	// header attacks stay bounded by ReadHeaderTimeout, and each handler applies
	// its own, tighter request deadline.
	server := &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 2 * time.Minute, WriteTimeout: 2 * time.Minute, IdleTimeout: 60 * time.Second}
	rt.Log.Info("native Flux planning started", "addr", addr, "demo", demo)
	components := []baserun.Component{baserun.HTTPServer(server, 10*time.Second, false),
		func(ctx context.Context) error { return runBlobCleanup(ctx, db, attachments, rt.Log) },
	}
	if connectorSettings.Interval > 0 {
		components = append(components, func(ctx context.Context) error { return db.RunRefresh(ctx, rt.Log) })
	}
	return baserun.Group(rt.Ctx, components...)
}

func seedPlanning(ctx context.Context, db *store.Store, wid, pid, subject string) error {
	b, err := db.Board(ctx, wid, subject)
	if err != nil {
		return err
	}
	if len(b.Items) > 0 || len(b.Sprints) > 0 {
		return errors.New("seed requires an empty workspace board; existing planning is never overwritten")
	}
	if pid == "" && len(b.Projects) > 0 {
		pid = b.Projects[0].ID
	}
	if pid != "" && !slices.ContainsFunc(b.Projects, func(p planning.Project) bool { return p.ID == pid }) {
		return errors.New("seed project must belong to workspace")
	}
	apply := func(c planning.Command) error {
		c.Revision = b.Workspace.Revision
		if _, e := db.Change(ctx, wid, subject, planning.NewID(), c); e != nil {
			return e
		}
		var e error
		b, e = db.Board(ctx, wid, subject)
		return e
	}
	today := time.Now().UTC()
	sp := planning.Sprint{Name: "Sprint 1 · Planning foundations", Goal: "Give the team one reliable place to plan, track, and finish work.", Start: today.Format("2006-01-02"), End: today.AddDate(0, 0, 13).Format("2006-01-02")}
	if err = apply(planning.Command{Kind: "sprint.save", Sprint: &sp}); err != nil {
		return err
	}
	sid := b.Sprints[0].ID
	if err = apply(planning.Command{Kind: "sprint.start", Target: sid}); err != nil {
		return err
	}
	next := planning.Sprint{Name: "Sprint 2 · Delivery signals", Goal: "Bring linked merge-request and pipeline observations into planning.", Start: today.AddDate(0, 0, 14).Format("2006-01-02"), End: today.AddDate(0, 0, 27).Format("2006-01-02")}
	if err = apply(planning.Command{Kind: "sprint.save", Sprint: &next}); err != nil {
		return err
	}
	samples := []struct {
		title, description string
		labels             []string
		column             int
		sprint             bool
	}{
		{"Define the team's acceptance criteria", "Agree what ready and done mean. Record the checklist in each work item's description.", []string{"priority::high", "type::planning"}, 0, true},
		{"Review the first sprint's scope", "Keep the goal achievable. Move lower-priority work to the backlog before starting new cards.", []string{"priority::normal", "type::planning"}, 0, true},
		{"Try the native Kanban workflow", "Drag this card from its body, or use the column selector in the editor. Reordering and WIP checks are saved transactionally.", []string{"priority::high", "type::product"}, 1, true},
		{"Validate sprint carry-over decisions", "Close a sprint with a rationale and explicitly choose backlog or the next planned sprint.", []string{"priority::normal", "type::product"}, 1, true},
		{"Review workspace permissions", "Viewer access is read-only. Members can plan; planning changes have native history and item comments are append-only.", []string{"priority::high", "type::security"}, 2, true},
		{"Create a durable planning home", "Native work items live in PostgreSQL, independently of GitLab issues and milestones.", []string{"priority::normal", "type::platform"}, 3, true},
		{"Link GitLab merge requests to cards", "Attach approved merge-request coordinates using GitLab links; the latest MR pipeline status is observed server-side. Observations never move cards.", []string{"priority::high", "type::integration"}, 0, false},
		{"Draft agent-assisted planning proposals", "Use native Pi reads to prepare evidence-backed suggestions. Import a draft through Proposals, review the exact diff, then explicitly approve it.", []string{"priority::low", "type::agent"}, 0, false},
	}
	for _, sample := range samples {
		it := planning.Item{Title: sample.title, Description: sample.description, ColumnID: b.Columns[sample.column].ID, Assignee: subject, Labels: sample.labels}
		if sample.sprint {
			it.SprintIDs = []string{sid}
			it.ProjectIDs = []string{pid}
		}
		if err = apply(planning.Command{Kind: "item.create", Item: &it}); err != nil {
			return err
		}
	}
	return nil
}
