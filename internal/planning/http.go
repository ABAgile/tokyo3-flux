package planning

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/abagile/tokyo3-base/session"
)

// Repository is the native planning API's transaction boundary.
type Repository interface {
	Workspaces(context.Context, string) ([]Workspace, error)
	Projects(context.Context, string, string) ([]Project, error)
	Board(context.Context, string, string) (Board, error)
	Change(context.Context, string, string, string, Command) (int64, error)
	History(context.Context, string, string, int64) ([]Event, error)
}

type GitLabProjectRepository interface {
	GitLabProjects(context.Context, string, string) ([]GitLabProject, error)
}
type GitLabMergeRequestRepository interface {
	GitLabMergeRequests(context.Context, string, string, int64, string) ([]GitLabMergeRequest, error)
}
type GitLabMergeRequestScopeRepository interface {
	GitLabMergeRequestsFor(context.Context, string, string, int64, string, string) ([]GitLabMergeRequest, error)
}

type BurndownRepository interface {
	Burndown(context.Context, string, string, string, string, string) (Burndown, error)
}

type CommentRepository interface {
	Comments(context.Context, string, string, string) ([]Comment, error)
	AddComment(context.Context, string, string, string, string, string) (Comment, error)
}

type ProposalRepository interface {
	Proposals(context.Context, string, string, int64) ([]ProposalSummary, error)
	Review(context.Context, string, string, string) (ProposalPreview, error)
}

type HTTP struct {
	repo           Repository
	sessions       *session.Manager
	machineSubject string
	demo           bool
	log            *slog.Logger
}

func NewHTTP(repo Repository, sessions *session.Manager, machineSubject string, demo bool, log *slog.Logger) *HTTP {
	return &HTTP{repo, sessions, machineSubject, demo, log}
}

func (h *HTTP) Handler(machine bool) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v2/session", func(w http.ResponseWriter, r *http.Request) {
		if machine {
			h.failure(w, r, ErrForbidden)
			return
		}
		token, err := h.sessions.CSRFToken(r, "planning")
		if err != nil {
			h.failure(w, r, err)
			return
		}
		sess, _ := session.SessionFromContext(r.Context())
		var profile struct {
			AvatarURL string `json:"avatar_url"`
		}
		_ = json.Unmarshal(sess.Extra, &profile)
		respond(w, 200, map[string]any{"subject": sess.Subject, "name": sess.Name, "avatar_url": profile.AvatarURL, "csrf": token, "demo": h.demo})
	})
	mux.HandleFunc("GET /api/v2/workspaces", func(w http.ResponseWriter, r *http.Request) {
		v, err := h.repo.Workspaces(r.Context(), h.subject(r, machine))
		h.result(w, r, v, err)
	})
	mux.HandleFunc("GET /api/v2/workspaces/{workspace}/projects", func(w http.ResponseWriter, r *http.Request) {
		v, err := h.repo.Projects(r.Context(), r.PathValue("workspace"), h.subject(r, machine))
		h.result(w, r, v, err)
	})
	root := "/api/v2/workspaces/{workspace}"
	commentsRoot := root + "/items/{item}/comments"
	mux.HandleFunc("GET "+commentsRoot, func(w http.ResponseWriter, r *http.Request) {
		repo, ok := h.repo.(CommentRepository)
		if !ok {
			h.failure(w, r, ErrNotFound)
			return
		}
		itemID := r.PathValue("item")
		if !validItemPathID(itemID) {
			h.failure(w, r, ErrInvalid)
			return
		}
		v, err := repo.Comments(r.Context(), r.PathValue("workspace"), h.subject(r, machine), itemID)
		h.result(w, r, v, err)
	})
	mux.HandleFunc("POST "+commentsRoot, func(w http.ResponseWriter, r *http.Request) {
		if machine || r.Header.Get("Authorization") != "" {
			h.failure(w, r, ErrForbidden)
			return
		}
		if !h.sessions.ValidateCSRF(r, r.Header.Get("X-CSRF-Token"), "planning") {
			h.failure(w, r, ErrForbidden)
			return
		}
		if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" || !validCommentIdempotencyKey(r.Header.Get("Idempotency-Key")) {
			h.failure(w, r, ErrInvalid)
			return
		}
		repo, ok := h.repo.(CommentRepository)
		if !ok {
			h.failure(w, r, ErrNotFound)
			return
		}
		itemID := r.PathValue("item")
		if !validItemPathID(itemID) {
			h.failure(w, r, ErrInvalid)
			return
		}
		var input struct {
			Body string `json:"body"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&input); err != nil {
			h.failure(w, r, ErrInvalid)
			return
		}
		if err := dec.Decode(new(any)); err != io.EOF {
			h.failure(w, r, ErrInvalid)
			return
		}
		comment, err := repo.AddComment(r.Context(), r.PathValue("workspace"), h.subject(r, false), itemID, r.Header.Get("Idempotency-Key"), input.Body)
		h.result(w, r, comment, err)
	})
	mux.HandleFunc("GET "+root+"/board", func(w http.ResponseWriter, r *http.Request) {
		v, err := h.repo.Board(r.Context(), r.PathValue("workspace"), h.subject(r, machine))
		if machine {
			v.Role = "viewer"
			v.Workspace.Role = "viewer"
		}
		h.result(w, r, v, err)
	})
	mux.HandleFunc("GET "+root+"/gitlab/projects", func(w http.ResponseWriter, r *http.Request) {
		if machine {
			h.failure(w, r, ErrForbidden)
			return
		}
		repo, ok := h.repo.(GitLabProjectRepository)
		if !ok {
			h.failure(w, r, ErrNotFound)
			return
		}
		v, err := repo.GitLabProjects(r.Context(), r.PathValue("workspace"), h.subject(r, false))
		h.result(w, r, v, err)
	})
	mux.HandleFunc("GET "+root+"/gitlab/merge-requests", func(w http.ResponseWriter, r *http.Request) {
		if machine {
			h.failure(w, r, ErrForbidden)
			return
		}
		repo, ok := h.repo.(GitLabMergeRequestRepository)
		if !ok {
			h.failure(w, r, ErrNotFound)
			return
		}
		query := r.URL.Query()
		project, err := strconv.ParseInt(query.Get("project"), 10, 64)
		if err != nil || project <= 0 || project > MaxExternalID {
			h.failure(w, r, ErrInvalid)
			return
		}
		rawSearch := query.Get("search")
		if len(rawSearch) > 120 || strings.ContainsAny(rawSearch, "\r\n") {
			h.failure(w, r, ErrInvalid)
			return
		}
		search := strings.TrimSpace(rawSearch)
		scope := query.Get("scope")
		if scope == "" {
			scope = "recent"
		}
		if scope != "recent" && scope != "assigned_to_me" && scope != "board_members" {
			h.failure(w, r, ErrInvalid)
			return
		}
		var v []GitLabMergeRequest
		if scopedRepo, ok := h.repo.(GitLabMergeRequestScopeRepository); ok {
			v, err = scopedRepo.GitLabMergeRequestsFor(r.Context(), r.PathValue("workspace"), h.subject(r, false), project, search, scope)
		} else if scope == "recent" {
			v, err = repo.GitLabMergeRequests(r.Context(), r.PathValue("workspace"), h.subject(r, false), project, search)
		} else {
			h.failure(w, r, ErrNotFound)
			return
		}
		h.result(w, r, v, err)
	})
	mux.HandleFunc("GET "+root+"/burndown", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := h.repo.(BurndownRepository)
		if !ok {
			h.failure(w, r, ErrNotFound)
			return
		}
		query := r.URL.Query()
		sprint := query.Get("sprint")
		if sprint == "" || len(sprint) > 240 {
			h.failure(w, r, ErrInvalid)
			return
		}
		project, err := burndownFilter(query.Get("project"))
		if err != nil {
			h.failure(w, r, err)
			return
		}
		assignee, err := burndownFilter(query.Get("assignee"))
		if err != nil {
			h.failure(w, r, err)
			return
		}
		v, err := repo.Burndown(r.Context(), r.PathValue("workspace"), h.subject(r, machine), sprint, project, assignee)
		h.result(w, r, v, err)
	})
	mux.HandleFunc("GET "+root+"/read/{view}", func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		offset, e1 := strconv.Atoi(defaultQuery(query.Get("offset"), "0"))
		limit, e2 := strconv.Atoi(defaultQuery(query.Get("limit"), "20"))
		revision, e3 := strconv.ParseInt(defaultQuery(query.Get("revision"), "0"), 10, 64)
		if e1 != nil || e2 != nil || e3 != nil {
			h.failure(w, r, ErrInvalid)
			return
		}
		b, err := h.repo.Board(r.Context(), r.PathValue("workspace"), h.subject(r, machine))
		if err != nil {
			h.failure(w, r, err)
			return
		}
		result, err := ReadModel(b, r.PathValue("view"), query.Get("target"), offset, limit, revision, time.Now().UTC())
		h.result(w, r, result, err)
	})
	mux.HandleFunc("GET "+root+"/proposals", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := h.repo.(ProposalRepository)
		if !ok {
			h.failure(w, r, ErrNotFound)
			return
		}
		before, err := strconv.ParseInt(defaultQuery(r.URL.Query().Get("before"), "0"), 10, 64)
		if err != nil || before < 0 {
			h.failure(w, r, ErrInvalid)
			return
		}
		v, err := repo.Proposals(r.Context(), r.PathValue("workspace"), h.subject(r, machine), before)
		h.result(w, r, v, err)
	})
	mux.HandleFunc("GET "+root+"/proposals/{proposal}", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := h.repo.(ProposalRepository)
		if !ok {
			h.failure(w, r, ErrNotFound)
			return
		}
		v, err := repo.Review(r.Context(), r.PathValue("workspace"), h.subject(r, machine), r.PathValue("proposal"))
		h.result(w, r, v, err)
	})
	mux.HandleFunc("GET "+root+"/history", func(w http.ResponseWriter, r *http.Request) {
		var before int64
		var err error
		if raw := r.URL.Query().Get("before"); raw != "" {
			before, err = strconv.ParseInt(raw, 10, 64)
			if err != nil || before < 0 {
				h.failure(w, r, ErrInvalid)
				return
			}
		}
		v, err := h.repo.History(r.Context(), r.PathValue("workspace"), h.subject(r, machine), before)
		h.result(w, r, v, err)
	})
	mux.HandleFunc("POST "+root+"/changes", func(w http.ResponseWriter, r *http.Request) {
		if machine || r.Header.Get("Authorization") != "" {
			h.failure(w, r, ErrForbidden)
			return
		}
		if !h.sessions.ValidateCSRF(r, r.Header.Get("X-CSRF-Token"), "planning") {
			h.failure(w, r, ErrForbidden)
			return
		}
		if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
			h.failure(w, r, ErrInvalid)
			return
		}
		var c Command
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&c); err != nil {
			h.failure(w, r, ErrInvalid)
			return
		}
		if err := dec.Decode(new(any)); err != io.EOF {
			h.failure(w, r, ErrInvalid)
			return
		}
		rev, err := h.repo.Change(r.Context(), r.PathValue("workspace"), h.subject(r, false), r.Header.Get("Idempotency-Key"), c)
		h.result(w, r, map[string]int64{"revision": rev}, err)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		if h.subject(r, machine) == "" {
			h.failure(w, r, ErrForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
func (h *HTTP) subject(r *http.Request, machine bool) string {
	if machine {
		return h.machineSubject
	}
	sess, ok := session.SessionFromContext(r.Context())
	if !ok {
		return ""
	}
	return sess.Subject
}
func (h *HTTP) result(w http.ResponseWriter, r *http.Request, v any, err error) {
	if err != nil {
		h.failure(w, r, err)
		return
	}
	respond(w, 200, v)
}
func (h *HTTP) failure(w http.ResponseWriter, r *http.Request, err error) {
	status, message := 500, "planning service unavailable"
	switch {
	case errors.Is(err, ErrInvalid):
		status = 400
		message = err.Error()
	case errors.Is(err, ErrConflict):
		status = 409
		message = ErrConflict.Error()
	case errors.Is(err, ErrForbidden):
		status = 403
		message = ErrForbidden.Error()
	case errors.Is(err, ErrNotFound):
		status = 404
		message = ErrNotFound.Error()
	case errors.Is(err, ErrGitLabUnavailable):
		status = http.StatusServiceUnavailable
		message = ErrGitLabUnavailable.Error()
	}
	// Separate security/operational audit path. Never log bodies, tokens or DB errors.
	h.log.Warn("planning request failed", "request_id", NewID(), "actor", h.subject(r, false), "method", r.Method, "status", status)
	respond(w, status, map[string]string{"error": message})
}
func defaultQuery(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
func burndownFilter(value string) (string, error) {
	if len(value) > 240 {
		return "", ErrInvalid
	}
	if value == "all" {
		return "", nil
	}
	return value, nil
}
func validItemPathID(value string) bool {
	return value != "" && len(value) <= 240 && !strings.ContainsAny(value, "\r\n")
}
func validCommentIdempotencyKey(value string) bool {
	return len(value) >= 16 && len(value) <= 120 && !strings.ContainsAny(value, "\r\n")
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
