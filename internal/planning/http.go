package planning

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"abagile.com/tokyo3/flux/internal/blobstore"
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

type WorkspaceCreator interface {
	CreateWorkspace(context.Context, string, string, string) (Workspace, error)
}

type GitLabProjectRepository interface {
	GitLabProjects(context.Context, string, string) ([]GitLabProject, error)
}
type GitLabUserRepository interface {
	GitLabUsers(context.Context, string, string, string) ([]GitLabUser, error)
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

type AttachmentRepository interface {
	Attachment(context.Context, string, string, string, int64) (Attachment, error)
	AddAttachment(context.Context, string, string, string, string, string, Attachment) (Attachment, error)
	RemoveAttachment(context.Context, string, string, string, int64) (Attachment, error)
}

// AttachmentStore supplies bounded attachment bytes; lifecycle closing is
// owned by the application that constructs it.
type AttachmentStore interface {
	Put(context.Context, string, io.Reader, string) (blobstore.ObjectInfo, error)
	Open(context.Context, string) (blobstore.Object, error)
	Delete(context.Context, string) error
}

// WorkspaceState is a cheap freshness probe. Clients poll it instead of
// refetching the whole board just to learn that nothing changed.
type WorkspaceState struct {
	Revision int64  `json:"revision"`
	Role     string `json:"role"`
	// Links digests the observation state the board would report, so a client
	// can tell a GitLab-only update from a planning change without a board read.
	Links string `json:"links_digest"`
}

type StateRepository interface {
	WorkspaceState(context.Context, string, string) (WorkspaceState, error)
}

// ArchiveRepository serves archived work in pages. Archived items are excluded
// from the board payload, so this is the only way a browser reaches them.
type ArchiveRepository interface {
	ArchivedItems(context.Context, string, string, int, int) ([]Item, error)
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
	blobs          AttachmentStore
}

func NewHTTP(repo Repository, sessions *session.Manager, machineSubject string, demo bool, log *slog.Logger, blobs ...AttachmentStore) *HTTP {
	var attachmentStore AttachmentStore
	if len(blobs) > 0 {
		attachmentStore = blobs[0]
	}
	return &HTTP{repo: repo, sessions: sessions, machineSubject: machineSubject,
		demo: demo, log: log, blobs: attachmentStore}
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
	mux.HandleFunc("POST /api/v2/workspaces", func(w http.ResponseWriter, r *http.Request) {
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
		creator, ok := h.repo.(WorkspaceCreator)
		if !ok {
			h.failure(w, r, ErrNotFound)
			return
		}
		var input struct {
			Name string `json:"name"`
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
		workspace, err := creator.CreateWorkspace(r.Context(), input.Name, h.subject(r, false), r.Header.Get("Idempotency-Key"))
		if err != nil {
			h.failure(w, r, err)
			return
		}
		respond(w, http.StatusCreated, workspace)
	})
	mux.HandleFunc("GET /api/v2/workspaces/{workspace}/projects", func(w http.ResponseWriter, r *http.Request) {
		v, err := h.repo.Projects(r.Context(), r.PathValue("workspace"), h.subject(r, machine))
		h.result(w, r, v, err)
	})
	root := "/api/v2/workspaces/{workspace}"
	commentsRoot := root + "/items/{item}/comments"
	attachmentsRoot := root + "/items/{item}/attachments"
	mux.HandleFunc("GET "+attachmentsRoot+"/{attachment}", func(w http.ResponseWriter, r *http.Request) {
		h.downloadAttachment(w, r, machine)
	})
	mux.HandleFunc("POST "+attachmentsRoot, func(w http.ResponseWriter, r *http.Request) {
		h.uploadAttachment(w, r, machine)
	})
	mux.HandleFunc("DELETE "+attachmentsRoot+"/{attachment}", func(w http.ResponseWriter, r *http.Request) {
		h.deleteAttachment(w, r, machine)
	})
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
		if err == nil {
			v = BrowserBoard(v)
		}
		h.result(w, r, v, err)
	})
	mux.HandleFunc("GET "+root+"/revision", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := h.repo.(StateRepository)
		if !ok {
			h.failure(w, r, ErrNotFound)
			return
		}
		v, err := repo.WorkspaceState(r.Context(), r.PathValue("workspace"), h.subject(r, machine))
		if machine {
			v.Role = "viewer"
		}
		h.result(w, r, v, err)
	})
	mux.HandleFunc("GET "+root+"/archive", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := h.repo.(ArchiveRepository)
		if !ok {
			h.failure(w, r, ErrNotFound)
			return
		}
		query := r.URL.Query()
		offset, offsetErr := strconv.Atoi(defaultQuery(query.Get("offset"), "0"))
		limit, limitErr := strconv.Atoi(defaultQuery(query.Get("limit"), strconv.Itoa(ArchivePageLimit)))
		if offsetErr != nil || limitErr != nil || offset < 0 || limit <= 0 || limit > ArchivePageLimit {
			h.failure(w, r, ErrInvalid)
			return
		}
		v, err := repo.ArchivedItems(r.Context(), r.PathValue("workspace"), h.subject(r, machine), offset, limit)
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
	mux.HandleFunc("GET "+root+"/gitlab/users", func(w http.ResponseWriter, r *http.Request) {
		if machine {
			h.failure(w, r, ErrForbidden)
			return
		}
		repo, ok := h.repo.(GitLabUserRepository)
		if !ok {
			h.failure(w, r, ErrNotFound)
			return
		}
		rawSearch := r.URL.Query().Get("search")
		if len(rawSearch) > 120 || strings.ContainsAny(rawSearch, "\r\n") {
			h.failure(w, r, ErrInvalid)
			return
		}
		v, err := repo.GitLabUsers(r.Context(), r.PathValue("workspace"), h.subject(r, false), strings.TrimSpace(rawSearch))
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
		// One identifier per request, echoed to the client and reused by every
		// log line below, so a reported failure can be correlated with its audit
		// trail instead of a value invented at logging time.
		id := NewID()
		ctx = context.WithValue(ctx, requestIDKey{}, id)
		w.Header().Set("X-Request-Id", id)
		r = r.WithContext(ctx)
		if h.subject(r, machine) == "" {
			h.failure(w, r, ErrForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

type requestIDKey struct{}

// requestID returns the per-request correlation identifier assigned by Handler.
func requestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

func (h *HTTP) uploadAttachment(w http.ResponseWriter, r *http.Request, machine bool) {
	if machine || r.Header.Get("Authorization") != "" {
		h.failure(w, r, ErrForbidden)
		return
	}
	if !h.sessions.ValidateCSRF(r, r.Header.Get("X-CSRF-Token"), "planning") {
		h.failure(w, r, ErrForbidden)
		return
	}
	repo, ok := h.repo.(AttachmentRepository)
	if !ok || h.blobs == nil {
		h.failure(w, r, ErrAttachmentUnavailable)
		return
	}
	itemID := r.PathValue("item")
	if !validItemPathID(itemID) || !validCommentIdempotencyKey(r.Header.Get("Idempotency-Key")) {
		h.failure(w, r, ErrInvalid)
		return
	}
	workspaceID := r.PathValue("workspace")
	subject := h.subject(r, false)
	if err := h.attachmentWritePreflight(r.Context(), workspaceID, subject, itemID); err != nil {
		h.failure(w, r, err)
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" {
		h.failure(w, r, ErrInvalid)
		return
	}
	bodyLimit := int64(MaxAttachmentBytes) + 1<<20
	if r.ContentLength > bodyLimit {
		h.failure(w, r, fmt.Errorf("%w: attachment request is too large", ErrInvalid))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, bodyLimit)
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		h.failure(w, r, ErrInvalid)
		return
	}
	if r.MultipartForm == nil {
		h.failure(w, r, ErrInvalid)
		return
	}
	defer r.MultipartForm.RemoveAll()
	files := r.MultipartForm.File["file"]
	if len(files) != 1 {
		h.failure(w, r, fmt.Errorf("%w: upload one file in the file field", ErrInvalid))
		return
	}
	header := files[0]
	if header.Size < 0 || header.Size > MaxAttachmentBytes {
		h.failure(w, r, blobstore.ErrTooLarge)
		return
	}
	name, err := attachmentFilename(header.Filename)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	file, err := header.Open()
	if err != nil {
		h.failure(w, r, fmt.Errorf("%w: attachment could not be read", ErrInvalid))
		return
	}
	defer file.Close()
	sample := make([]byte, 512)
	sampleSize, sampleErr := io.ReadFull(file, sample)
	if sampleErr != nil && sampleErr != io.EOF && sampleErr != io.ErrUnexpectedEOF {
		h.failure(w, r, fmt.Errorf("%w: attachment could not be read", ErrInvalid))
		return
	}
	contentType := attachmentContentType(header.Header.Get("Content-Type"), sample[:sampleSize])
	// The filesystem root already is the attachment namespace; keep the
	// generated key flat so FLUX_BLOBSTORE_PATH is not duplicated as a folder.
	key := NewID()
	info, err := h.blobs.Put(r.Context(), key,
		io.MultiReader(bytes.NewReader(sample[:sampleSize]), file), contentType)
	if err != nil {
		if errors.Is(err, blobstore.ErrTooLarge) {
			h.failure(w, r, err)
		} else {
			h.failure(w, r, ErrAttachmentUnavailable)
		}
		return
	}
	if info.Key != key || info.Size < 0 || info.Size > MaxAttachmentBytes || !validAttachmentDigest(info.Digest) {
		h.removeBlob(requestID(r.Context()), key)
		h.failure(w, r, ErrAttachmentUnavailable)
		return
	}
	attachment, err := repo.AddAttachment(r.Context(), workspaceID, subject, itemID, key,
		r.Header.Get("Idempotency-Key"), Attachment{
			ItemID: itemID, Name: name, ContentType: contentType, Size: info.Size,
			Digest: info.Digest,
		})
	if err != nil {
		h.removeBlob(requestID(r.Context()), key)
		h.failure(w, r, err)
		return
	}
	status := http.StatusCreated
	if attachment.StorageKey != "" && attachment.StorageKey != key {
		status = http.StatusOK
		h.removeBlob(requestID(r.Context()), key)
	}
	attachment.StorageKey = ""
	respond(w, status, attachment)
}

func (h *HTTP) downloadAttachment(w http.ResponseWriter, r *http.Request, machine bool) {
	if h.blobs == nil {
		h.failure(w, r, ErrAttachmentUnavailable)
		return
	}
	repo, ok := h.repo.(AttachmentRepository)
	if !ok {
		h.failure(w, r, ErrAttachmentUnavailable)
		return
	}
	itemID := r.PathValue("item")
	id, err := parseAttachmentID(r.PathValue("attachment"))
	if !validItemPathID(itemID) || err != nil {
		h.failure(w, r, ErrInvalid)
		return
	}
	attachment, err := repo.Attachment(r.Context(), r.PathValue("workspace"),
		h.subject(r, machine), itemID, id)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	if !ValidAttachmentName(attachment.Name) || !SafeAttachmentMIME(attachment.ContentType) ||
		attachment.Size < 0 || attachment.Size > MaxAttachmentBytes || !validAttachmentDigest(attachment.Digest) {
		h.failure(w, r, ErrAttachmentUnavailable)
		return
	}
	object, err := h.openAttachmentObject(r.Context(), attachment.StorageKey, attachment.Size)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	defer object.Reader.Close()
	// The object is read exactly once. Small objects are verified in memory so a
	// corrupt blob still becomes a clean 503; larger ones are verified as they
	// stream, because buffering them is worse than the abort below.
	var buffered *bytes.Buffer
	if r.Method != http.MethodHead && attachment.Size <= MaxBufferedAttachmentBytes {
		buffered = bytes.NewBuffer(make([]byte, 0, attachment.Size))
		if err = verifyAttachmentObject(object, attachment.Digest, buffered); err != nil {
			h.failure(w, r, err)
			return
		}
	}
	contentDisposition := mime.FormatMediaType("attachment", map[string]string{"filename": attachment.Name})
	if contentDisposition == "" {
		contentDisposition = `attachment; filename="download"`
	}
	w.Header().Set("Content-Type", attachmentResponseContentType(attachment.ContentType))
	w.Header().Set("Content-Disposition", contentDisposition)
	w.Header().Set("Content-Length", strconv.FormatInt(attachment.Size, 10))
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	if buffered != nil {
		_, _ = w.Write(buffered.Bytes())
		return
	}
	if err = verifyAttachmentObject(object, attachment.Digest, w); err != nil {
		h.log.Warn("attachment download failed", "request_id", requestID(r.Context()), "attachment_id", id)
		// The status and Content-Length are already committed, so the only way to
		// stop a truncated or unverified body from looking complete is to break
		// the connection.
		panic(http.ErrAbortHandler)
	}
}

func (h *HTTP) openAttachmentObject(ctx context.Context, key string, size int64) (blobstore.Object, error) {
	object, err := h.blobs.Open(ctx, key)
	if err != nil {
		return blobstore.Object{}, ErrAttachmentUnavailable
	}
	if object.Reader == nil || object.Size != size {
		if object.Reader != nil {
			_ = object.Reader.Close()
		}
		return blobstore.Object{}, ErrAttachmentUnavailable
	}
	return object, nil
}

// verifyAttachmentObject streams the object into dst while hashing it, and
// reports whether the stored bytes still match the recorded digest.
func verifyAttachmentObject(object blobstore.Object, expectedDigest string, dst io.Writer) error {
	hash := sha256.New()
	written, copyErr := io.CopyN(dst, io.TeeReader(object.Reader, hash), object.Size)
	verifyErr := error(nil)
	if object.Verify != nil {
		verifyErr = object.Verify()
	}
	actualDigest := "sha256:" + hex.EncodeToString(hash.Sum(nil))
	if copyErr != nil || written != object.Size || verifyErr != nil || actualDigest != expectedDigest {
		return ErrAttachmentUnavailable
	}
	return nil
}

func (h *HTTP) deleteAttachment(w http.ResponseWriter, r *http.Request, machine bool) {
	if machine || r.Header.Get("Authorization") != "" {
		h.failure(w, r, ErrForbidden)
		return
	}
	if !h.sessions.ValidateCSRF(r, r.Header.Get("X-CSRF-Token"), "planning") {
		h.failure(w, r, ErrForbidden)
		return
	}
	if h.blobs == nil {
		h.failure(w, r, ErrAttachmentUnavailable)
		return
	}
	repo, ok := h.repo.(AttachmentRepository)
	if !ok {
		h.failure(w, r, ErrAttachmentUnavailable)
		return
	}
	itemID := r.PathValue("item")
	id, err := parseAttachmentID(r.PathValue("attachment"))
	if !validItemPathID(itemID) || err != nil {
		h.failure(w, r, ErrInvalid)
		return
	}
	attachment, err := repo.RemoveAttachment(r.Context(), r.PathValue("workspace"),
		h.subject(r, false), itemID, id)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	if err = h.blobs.Delete(r.Context(), attachment.StorageKey); err != nil {
		h.failure(w, r, ErrAttachmentUnavailable)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTP) attachmentWritePreflight(ctx context.Context, workspaceID, subject, itemID string) error {
	board, err := h.repo.Board(ctx, workspaceID, subject)
	if err != nil {
		return err
	}
	if board.Role != "member" && board.Role != "admin" {
		return ErrForbidden
	}
	for _, item := range board.Items {
		if item.ID != itemID {
			continue
		}
		if item.Archived {
			return fmt.Errorf("%w: restore an archived item before adding attachments", ErrInvalid)
		}
		return nil
	}
	return ErrNotFound
}

// removeBlob drops an orphaned object on a detached deadline, so cleanup still
// runs when the request context is already cancelled. id ties the warning back
// to the request that created the orphan.
func (h *HTTP) removeBlob(id, key string) {
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.blobs.Delete(cleanupCtx, key); err != nil {
		h.log.Warn("attachment cleanup failed", "request_id", id)
	}
}

func parseAttachmentID(value string) (int64, error) {
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 {
		return 0, ErrInvalid
	}
	return id, nil
}

func attachmentFilename(value string) (string, error) {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\\", "/"))
	name := filepath.Base(value)
	if !ValidAttachmentName(name) {
		return "", fmt.Errorf("%w: attachment name must be 1–255 bytes", ErrInvalid)
	}
	return name, nil
}

func validAttachmentDigest(value string) bool {
	if len(value) != len("sha256:")+sha256.Size*2 || !strings.HasPrefix(value, "sha256:") {
		return false
	}
	_, err := hex.DecodeString(value[len("sha256:"):])
	return err == nil && value[len("sha256:"):] == strings.ToLower(value[len("sha256:"):])
}

func attachmentResponseContentType(value string) string {
	mediaType, _, err := mime.ParseMediaType(value)
	if err != nil || mediaType == "" || strings.ContainsAny(value, "\r\n") || !SafeAttachmentMIME(mediaType) {
		return "application/octet-stream"
	}
	return mediaType
}

func attachmentContentType(value string, sample []byte) string {
	detected := http.DetectContentType(sample)
	if normalized, _, err := mime.ParseMediaType(detected); err == nil {
		detected = normalized
	}
	if mediaType, _, err := mime.ParseMediaType(value); err == nil && mediaType != "" &&
		len(mediaType) <= MaxAttachmentMIME && !strings.ContainsAny(mediaType, "\r\n") &&
		SafeAttachmentMIME(mediaType) {
		if mediaType != "application/octet-stream" || detected == "application/octet-stream" {
			return mediaType
		}
		if SafeAttachmentMIME(detected) {
			return detected
		}
		return "application/octet-stream"
	}
	if SafeAttachmentMIME(detected) {
		mediaType, _, _ := mime.ParseMediaType(detected)
		return mediaType
	}
	return "application/octet-stream"
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
	case errors.Is(err, ErrAttachmentUnavailable):
		status = http.StatusServiceUnavailable
		message = ErrAttachmentUnavailable.Error()
	case errors.Is(err, blobstore.ErrTooLarge):
		status = 400
		message = "attachment exceeds the configured size limit"
	case errors.Is(err, ErrGitLabUnavailable):
		status = http.StatusServiceUnavailable
		message = ErrGitLabUnavailable.Error()
	}
	// Separate security/operational audit path. Never log bodies, tokens or DB errors.
	h.log.Warn("planning request failed", "request_id", requestID(r.Context()), "actor", h.subject(r, false), "method", r.Method, "status", status)
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
