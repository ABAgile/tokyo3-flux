// Package action contains the approval boundary for the small set of Flux
// GitLab mutations. Read-only API credentials never reach this package.
package action

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"abagile.com/tokyo3/flux/internal/domain"
	"abagile.com/tokyo3/flux/internal/gitlab"
	"abagile.com/tokyo3/flux/internal/state"
)

const (
	AddLabelAction = "add_issue_label"
	defaultPlanTTL = 10 * time.Minute
	maxItemIDBytes = 300
	maxLabelBytes  = 100
)

var (
	ErrActorRequired        = errors.New("authenticated action actor is required")
	ErrInvalidRequest       = errors.New("invalid action request")
	ErrSnapshotUnavailable  = errors.New("current Flux snapshot is unavailable")
	ErrTargetNotFound       = errors.New("issue is not in the current Flux snapshot")
	ErrActionConflict       = errors.New("issue changed since the action was planned")
	ErrPlanNotFound         = errors.New("action plan not found")
	ErrPlanExpired          = errors.New("action plan expired")
	ErrConfirmationRequired = errors.New("action confirmation does not match the plan")
	ErrLabelUnavailable     = errors.New("label is not available in the GitLab project")
	ErrMutationUnavailable  = errors.New("GitLab mutation credential is not configured")
	ErrGitLabUnavailable    = errors.New("GitLab action lookup failed")
	ErrAuditUnavailable     = errors.New("action audit logging failed")
)

// Actor identifies the authenticated human who approved an action.
type Actor struct {
	Subject string
	Name    string
}

// IssueReader reads the live GitLab issue before planning and confirmation.
type IssueReader interface {
	GetIssue(context.Context, int, int) (gitlab.Issue, error)
}

// IssueWriter performs the already-approved GitLab mutation.
type IssueWriter interface {
	AddIssueLabel(context.Context, int, int, string) error
}

// LabelReader lists labels that GitLab currently makes available to a project.
type LabelReader interface {
	ListProjectLabels(context.Context, int) ([]string, error)
}

// LabelPlan is the exact mutation a human must review and confirm.
type LabelPlan struct {
	ID            string    `json:"plan_id"`
	Action        string    `json:"action"`
	ItemID        string    `json:"item_id"`
	ProjectPath   string    `json:"project_path"`
	ProjectID     int       `json:"project_id"`
	IssueIID      int       `json:"issue_iid"`
	Title         string    `json:"title"`
	Label         string    `json:"label"`
	BeforeState   string    `json:"before_state"`
	BeforeLabels  []string  `json:"before_labels,omitempty"`
	BeforeUpdated time.Time `json:"before_updated_at"`
	CreatedAt     time.Time `json:"created_at"`
	ExpiresAt     time.Time `json:"expires_at"`
	Confirmation  string    `json:"confirmation"`
}

// LabelResult reports a successfully applied action.
type LabelResult struct {
	PlanID      string    `json:"plan_id"`
	Action      string    `json:"action"`
	ItemID      string    `json:"item_id"`
	ProjectPath string    `json:"project_path"`
	IssueIID    int       `json:"issue_iid"`
	Label       string    `json:"label"`
	AppliedAt   time.Time `json:"applied_at"`
}

type storedPlan struct {
	plan       LabelPlan
	projectID  int
	actor      Actor
	inProgress bool
}

// Config wires the approval service. Writer is optional so the dry-run plan
// remains usable when a write credential has not yet been configured.
type Config struct {
	Snapshot state.Reader
	Reader   IssueReader
	Labels   LabelReader
	Writer   IssueWriter
	Audit    state.AuditRecorder
	Trigger  func()
	PlanTTL  time.Duration
	Now      func() time.Time
	Log      *slog.Logger
}

// Service owns short-lived plans and enforces actor binding, expiry, live
// freshness checks, audit-before-write, and one-time confirmation.
type Service struct {
	snapshot state.Reader
	reader   IssueReader
	labels   LabelReader
	writer   IssueWriter
	audit    state.AuditRecorder
	trigger  func()
	planTTL  time.Duration
	now      func() time.Time
	log      *slog.Logger

	mu    sync.Mutex
	plans map[string]*storedPlan
}

// New validates and constructs an approval service.
func New(cfg Config) (*Service, error) {
	if cfg.Snapshot == nil {
		return nil, errors.New("action snapshot reader is required")
	}
	if cfg.Reader == nil {
		return nil, errors.New("action GitLab reader is required")
	}
	if cfg.Labels == nil {
		return nil, errors.New("action GitLab label reader is required")
	}
	if cfg.Audit == nil {
		return nil, errors.New("action audit recorder is required")
	}
	if cfg.PlanTTL <= 0 {
		cfg.PlanTTL = defaultPlanTTL
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Trigger == nil {
		cfg.Trigger = func() {}
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	return &Service{
		snapshot: cfg.Snapshot,
		reader:   cfg.Reader,
		labels:   cfg.Labels,
		writer:   cfg.Writer,
		audit:    cfg.Audit,
		trigger:  cfg.Trigger,
		planTTL:  cfg.PlanTTL,
		now:      cfg.Now,
		log:      cfg.Log,
		plans:    make(map[string]*storedPlan),
	}, nil
}

// MutationEnabled reports whether Flux has a separate credential for approved
// GitLab writes.
func (s *Service) MutationEnabled() bool {
	return s.writer != nil
}

// AvailableLabels returns labels defined in GitLab for the target project that
// are not already assigned to the issue. It always reads the live issue and
// GitLab label catalog rather than trusting the cached snapshot.
func (s *Service) AvailableLabels(ctx context.Context, itemID string) ([]string, error) {
	itemID = strings.TrimSpace(itemID)
	snapshot, ok := s.snapshot.Get()
	if !ok {
		return nil, ErrSnapshotUnavailable
	}
	target, err := targetFor(snapshot, itemID)
	if err != nil {
		return nil, err
	}
	issue, err := s.reader.GetIssue(ctx, target.projectID, target.issueIID)
	if err != nil {
		s.log.Warn("GitLab action issue lookup failed", "item_id", itemID, "error", err)
		return nil, fmt.Errorf("%w: read issue", ErrGitLabUnavailable)
	}
	if err := target.matches(issue); err != nil {
		return nil, err
	}
	if issue.State != domain.IssueOpen {
		return nil, fmt.Errorf("%w: issue is no longer open", ErrActionConflict)
	}
	labels, err := s.labels.ListProjectLabels(ctx, target.projectID)
	if err != nil {
		s.log.Warn("GitLab action label lookup failed", "item_id", itemID, "error", err)
		return nil, fmt.Errorf("%w: list project labels", ErrGitLabUnavailable)
	}
	return unusedLabels(labels, issue.Labels), nil
}

// PlanAddLabel validates the current read model, reads the live issue and
// current GitLab label catalog, and creates a short-lived exact plan without
// changing GitLab.
func (s *Service) PlanAddLabel(ctx context.Context, itemID, label string, actor Actor) (LabelPlan, error) {
	if strings.TrimSpace(actor.Subject) == "" {
		return LabelPlan{}, ErrActorRequired
	}
	itemID = strings.TrimSpace(itemID)
	label, err := normalizeLabel(label)
	if err != nil {
		return LabelPlan{}, err
	}

	snapshot, ok := s.snapshot.Get()
	if !ok {
		return LabelPlan{}, ErrSnapshotUnavailable
	}
	target, err := targetFor(snapshot, itemID)
	if err != nil {
		return LabelPlan{}, err
	}
	issue, err := s.reader.GetIssue(ctx, target.projectID, target.issueIID)
	if err != nil {
		s.log.Warn("GitLab action issue lookup failed", "item_id", itemID, "error", err)
		return LabelPlan{}, fmt.Errorf("%w: read issue", ErrGitLabUnavailable)
	}
	if err := target.matches(issue); err != nil {
		return LabelPlan{}, err
	}
	if issue.State != domain.IssueOpen {
		return LabelPlan{}, fmt.Errorf("%w: issue is not open", ErrActionConflict)
	}
	if hasLabel(issue.Labels, label) {
		return LabelPlan{}, fmt.Errorf("%w: label is already present", ErrActionConflict)
	}
	available, err := s.labels.ListProjectLabels(ctx, target.projectID)
	if err != nil {
		s.log.Warn("GitLab action label lookup failed", "item_id", itemID, "error", err)
		return LabelPlan{}, fmt.Errorf("%w: list project labels", ErrGitLabUnavailable)
	}
	if !containsLabel(available, label) {
		return LabelPlan{}, fmt.Errorf("%w: %q", ErrLabelUnavailable, label)
	}

	now := s.now().UTC()
	planID, err := randomID()
	if err != nil {
		return LabelPlan{}, fmt.Errorf("create action plan ID: %w", err)
	}
	plan := LabelPlan{
		ID:            planID,
		Action:        AddLabelAction,
		ItemID:        target.itemID,
		ProjectPath:   target.projectPath,
		ProjectID:     target.projectID,
		IssueIID:      target.issueIID,
		Title:         issue.Title,
		Label:         label,
		BeforeState:   string(issue.State),
		BeforeLabels:  append([]string(nil), issue.Labels...),
		BeforeUpdated: issue.UpdatedAt,
		CreatedAt:     now,
		ExpiresAt:     now.Add(s.planTTL),
		Confirmation:  fmt.Sprintf("add label %q to %s", label, target.itemID),
	}
	if err := s.recordAudit(plan, actor, "planned", ""); err != nil {
		return LabelPlan{}, err
	}

	s.mu.Lock()
	s.expireLocked(now)
	s.plans[plan.ID] = &storedPlan{plan: plan, projectID: target.projectID, actor: actor}
	s.mu.Unlock()
	return clonePlan(plan), nil
}

// ConfirmAddLabel verifies the exact human confirmation and current GitLab
// state, then performs the one allowed mutation at most once.
func (s *Service) ConfirmAddLabel(ctx context.Context, planID, confirmation string, actor Actor) (LabelResult, error) {
	if strings.TrimSpace(actor.Subject) == "" {
		return LabelResult{}, ErrActorRequired
	}
	planID = strings.TrimSpace(planID)
	if planID == "" {
		return LabelResult{}, ErrPlanNotFound
	}

	now := s.now().UTC()
	s.mu.Lock()
	stored, ok := s.plans[planID]
	if !ok || stored.actor.Subject != actor.Subject {
		s.mu.Unlock()
		return LabelResult{}, ErrPlanNotFound
	}
	if !now.Before(stored.plan.ExpiresAt) {
		plan := clonePlan(stored.plan)
		delete(s.plans, planID)
		s.mu.Unlock()
		_ = s.recordAudit(plan, actor, "expired", "plan expired before confirmation")
		return LabelResult{}, ErrPlanExpired
	}
	s.expireLocked(now)
	if stored.inProgress {
		s.mu.Unlock()
		return LabelResult{}, ErrActionConflict
	}
	if strings.TrimSpace(confirmation) != stored.plan.Confirmation {
		s.mu.Unlock()
		_ = s.recordAudit(stored.plan, actor, "rejected", "confirmation mismatch")
		return LabelResult{}, ErrConfirmationRequired
	}
	stored.inProgress = true
	plan := clonePlan(stored.plan)
	projectID := stored.projectID
	s.mu.Unlock()
	defer s.consumePlan(plan.ID)

	issue, err := s.reader.GetIssue(ctx, projectID, plan.IssueIID)
	if err != nil {
		s.log.Warn("GitLab action confirmation lookup failed", "plan_id", plan.ID, "error", err)
		s.recordFailure(plan, actor, "GitLab issue lookup failed")
		return LabelResult{}, fmt.Errorf("%w: read issue", ErrGitLabUnavailable)
	}
	if err := plan.matches(issue); err != nil {
		s.recordFailure(plan, actor, "issue changed since plan")
		return LabelResult{}, err
	}
	if issue.State != domain.IssueOpen {
		s.recordFailure(plan, actor, "issue is no longer open")
		return LabelResult{}, fmt.Errorf("%w: issue is no longer open", ErrActionConflict)
	}
	if hasLabel(issue.Labels, plan.Label) {
		s.recordFailure(plan, actor, "label is already present")
		return LabelResult{}, fmt.Errorf("%w: label is already present", ErrActionConflict)
	}
	available, err := s.labels.ListProjectLabels(ctx, projectID)
	if err != nil {
		s.log.Warn("GitLab action confirmation label lookup failed", "plan_id", plan.ID, "error", err)
		s.recordFailure(plan, actor, "GitLab project label lookup failed")
		return LabelResult{}, fmt.Errorf("%w: list project labels", ErrGitLabUnavailable)
	}
	if !containsLabel(available, plan.Label) {
		s.recordFailure(plan, actor, "label is no longer available in GitLab")
		return LabelResult{}, fmt.Errorf("%w: %q", ErrLabelUnavailable, plan.Label)
	}
	if s.writer == nil {
		s.recordFailure(plan, actor, "GitLab mutation credential is not configured")
		return LabelResult{}, ErrMutationUnavailable
	}
	if err := s.recordAudit(plan, actor, "approved", ""); err != nil {
		return LabelResult{}, err
	}
	if err := s.writer.AddIssueLabel(ctx, projectID, plan.IssueIID, plan.Label); err != nil {
		s.log.Warn("approved GitLab action failed", "plan_id", plan.ID, "error", err)
		s.recordFailure(plan, actor, "GitLab issue update failed")
		return LabelResult{}, fmt.Errorf("%w: update issue", ErrGitLabUnavailable)
	}
	appliedAt := s.now().UTC()
	if err := s.recordAudit(plan, actor, "applied", ""); err != nil {
		s.log.Error("GitLab action applied but audit recording failed", "plan_id", plan.ID, "error", err)
		s.trigger()
		return LabelResult{}, err
	}
	s.trigger()
	return LabelResult{
		PlanID:      plan.ID,
		Action:      plan.Action,
		ItemID:      plan.ItemID,
		ProjectPath: plan.ProjectPath,
		IssueIID:    plan.IssueIID,
		Label:       plan.Label,
		AppliedAt:   appliedAt,
	}, nil
}

type issueTarget struct {
	itemID      string
	projectPath string
	projectID   int
	issueIID    int
}

func targetFor(snapshot domain.Snapshot, itemID string) (issueTarget, error) {
	if len(itemID) > maxItemIDBytes || itemID == "" {
		return issueTarget{}, ErrInvalidRequest
	}
	for _, item := range snapshot.Sprint.WorkItems {
		if item.ID != itemID {
			continue
		}
		projectPath := strings.TrimSpace(item.ProjectPath)
		if item.ProjectID <= 0 || projectPath == "" {
			return issueTarget{}, fmt.Errorf("%w: issue is not project-qualified", ErrInvalidRequest)
		}
		separator := strings.LastIndexByte(itemID, '#')
		if separator <= 0 || separator == len(itemID)-1 || itemID[:separator] != projectPath {
			return issueTarget{}, fmt.Errorf("%w: issue reference is not project-qualified", ErrInvalidRequest)
		}
		iid, err := strconv.Atoi(itemID[separator+1:])
		if err != nil || iid <= 0 {
			return issueTarget{}, fmt.Errorf("%w: issue IID is invalid", ErrInvalidRequest)
		}
		return issueTarget{itemID: itemID, projectPath: projectPath, projectID: item.ProjectID, issueIID: iid}, nil
	}
	return issueTarget{}, ErrTargetNotFound
}

func (target issueTarget) matches(issue gitlab.Issue) error {
	if issue.IID != target.issueIID || issue.ProjectID != target.projectID {
		return fmt.Errorf("%w: GitLab issue identity changed", ErrActionConflict)
	}
	return nil
}

func (plan LabelPlan) matches(issue gitlab.Issue) error {
	if issue.IID != plan.IssueIID || issue.ProjectID != plan.ProjectID || string(issue.State) != plan.BeforeState || issue.Title != plan.Title {
		return fmt.Errorf("%w: identity or title changed", ErrActionConflict)
	}
	if !plan.BeforeUpdated.IsZero() && !issue.UpdatedAt.Equal(plan.BeforeUpdated) {
		return fmt.Errorf("%w: activity changed", ErrActionConflict)
	}
	return nil
}

func normalizeLabel(label string) (string, error) {
	label = strings.TrimSpace(label)
	if label == "" || len(label) > maxLabelBytes {
		return "", fmt.Errorf("%w: label must be 1-%d bytes", ErrInvalidRequest, maxLabelBytes)
	}
	for _, r := range label {
		if r == ',' || unicode.IsControl(r) {
			return "", fmt.Errorf("%w: label must not contain commas or control characters", ErrInvalidRequest)
		}
	}
	return label, nil
}

func hasLabel(labels []string, wanted string) bool {
	for _, label := range labels {
		if strings.EqualFold(label, wanted) {
			return true
		}
	}
	return false
}

func containsLabel(labels []string, wanted string) bool {
	for _, label := range labels {
		if strings.TrimSpace(label) == wanted {
			return true
		}
	}
	return false
}

func unusedLabels(available, current []string) []string {
	result := make([]string, 0, len(available))
	seen := make(map[string]struct{}, len(available))
	for _, label := range available {
		label = strings.TrimSpace(label)
		if label == "" || hasLabel(current, label) {
			continue
		}
		if _, ok := seen[label]; ok {
			continue
		}
		seen[label] = struct{}{}
		result = append(result, label)
	}
	sort.SliceStable(result, func(i, j int) bool {
		left, right := strings.ToLower(result[i]), strings.ToLower(result[j])
		if left == right {
			return result[i] < result[j]
		}
		return left < right
	})
	return result
}

func (s *Service) consumePlan(planID string) {
	s.mu.Lock()
	delete(s.plans, planID)
	s.mu.Unlock()
}

func (s *Service) expireLocked(now time.Time) {
	for id, plan := range s.plans {
		if !now.Before(plan.plan.ExpiresAt) {
			delete(s.plans, id)
		}
	}
}

func (s *Service) recordFailure(plan LabelPlan, actor Actor, reason string) {
	if err := s.recordAudit(plan, actor, "failed", reason); err != nil {
		s.log.Error("GitLab action failure audit failed", "plan_id", plan.ID, "error", err)
	}
}

func (s *Service) recordAudit(plan LabelPlan, actor Actor, outcome, failure string) error {
	auditID, err := randomID()
	if err != nil {
		return fmt.Errorf("%w: create audit ID", ErrAuditUnavailable)
	}
	event := state.AuditEvent{
		ID:           auditID,
		RecordedAt:   s.now().UTC(),
		Action:       plan.Action,
		PlanID:       plan.ID,
		ActorSubject: actor.Subject,
		ActorName:    actor.Name,
		ItemID:       plan.ItemID,
		ProjectPath:  plan.ProjectPath,
		ProjectID:    plan.ProjectID,
		IssueIID:     plan.IssueIID,
		Label:        plan.Label,
		Outcome:      outcome,
		Error:        failure,
	}
	if err := s.audit.RecordAudit(event); err != nil {
		return fmt.Errorf("%w: %v", ErrAuditUnavailable, err)
	}
	return nil
}

func clonePlan(plan LabelPlan) LabelPlan {
	plan.BeforeLabels = append([]string(nil), plan.BeforeLabels...)
	return plan
}

func randomID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes[:]), nil
}
