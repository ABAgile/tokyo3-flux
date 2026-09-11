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
	"abagile.com/tokyo3/flux/internal/integration"
	"abagile.com/tokyo3/flux/internal/planning"
	"abagile.com/tokyo3/flux/internal/planningui"
	"abagile.com/tokyo3/flux/internal/store"
	"github.com/abagile/tokyo3-base/cli"
	baserun "github.com/abagile/tokyo3-base/run"
	"github.com/abagile/tokyo3-base/session"
)

func runPlan(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: flux plan migrate|bootstrap|member|seed|serve")
	}
	cmd := args[0]
	flags := flag.NewFlagSet("plan "+cmd, flag.ContinueOnError)
	flags.SetOutput(stderr)
	addr := flags.String("addr", envOrDefault("FLUX_ADDR", "127.0.0.1:8080"), "HTTP listen address")
	demo := flags.Bool("demo", false, "loopback-only synthetic login; never enable in production")
	name := flags.String("name", "Workspace", "workspace name for bootstrap")
	project := flags.String("project", "", "optional project ID for seed (or optional initial project name for bootstrap)")
	workspace := flags.String("workspace", "", "workspace ID")
	subject := flags.String("subject", "", "explicit login subject (GitLab numeric user ID, or fixture-user for demo)")
	memberRole := flags.String("role", "member", "viewer, member, or admin")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("plan commands accept flags only")
	}
	switch cmd {
	case "migrate":
	case "bootstrap":
		if *subject == "" {
			return errors.New("bootstrap requires --subject ID; --project NAME is optional")
		}
	case "member":
		if *workspace == "" || *subject == "" || (*memberRole != "viewer" && *memberRole != "member" && *memberRole != "admin") {
			return errors.New("member requires --workspace ID, --subject ID and valid --role")
		}
	case "seed":
		if *workspace == "" || *subject == "" {
			return errors.New("seed requires --workspace ID --subject ID; --project ID is optional")
		}
	case "serve":
		if *demo && !isLoopbackAddress(*addr) {
			return errors.New("demo mode requires a loopback listen address")
		}
	default:
		return fmt.Errorf("unknown plan command %q", cmd)
	}
	app := cli.App{Name: "flux", EnvPrefix: "FLUX"}
	material := app.DB()
	if cmd == "migrate" || cmd == "bootstrap" || cmd == "member" {
		material = app.AdminDB()
	}
	// Validate auth before opening databases or starting workers.
	var sessions *session.Manager
	var auth http.Handler
	var machine *fluxauth.MachineToken
	machineSubject := strings.TrimSpace(os.Getenv("FLUX_API_SUBJECT"))
	if cmd == "serve" {
		key, err := serveSessionKey(os.Getenv("FLUX_SESSION_KEY"), *demo)
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
		if *demo {
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
		v, e := db.Bootstrap(ctx, *name, *project, *subject)
		if e != nil {
			return e
		}
		return json.NewEncoder(stdout).Encode(v)
	case "member":
		return db.SetMember(ctx, *workspace, *subject, *memberRole)
	case "seed":
		return seedPlanning(ctx, db, *workspace, *project, *subject)
	}
	rt := app.Setup(context.Background())
	defer rt.Shutdown()
	api := planning.NewHTTP(db, sessions, machineSubject, *demo, rt.Log)
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
	routes.Handle("/auth/", auth)
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
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if *demo {
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
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		routes.ServeHTTP(w, r)
	})
	server := &http.Server{Addr: *addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	rt.Log.Info("native Flux planning started", "addr", *addr, "demo", *demo)
	components := []baserun.Component{baserun.HTTPServer(server, 10*time.Second, false)}
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
			it.ProjectID = pid
		}
		if err = apply(planning.Command{Kind: "item.create", Item: &it}); err != nil {
			return err
		}
	}
	return nil
}
