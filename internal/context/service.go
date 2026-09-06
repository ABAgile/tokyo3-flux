// Package humancontext owns the browser approval boundary for human-provided
// delivery context. These records are an explicitly labeled overlay and never
// change the GitLab-derived read model.
package humancontext

import (
	stdcontext "context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"abagile.com/tokyo3/flux/internal/domain"
	"abagile.com/tokyo3/flux/internal/state"
)

const (
	defaultPlanTTL        = 10 * time.Minute
	maxStatementBytes     = 2000
	maxCategoryBytes      = 80
	maxItemIDs            = 20
	maxItemIDBytes        = 300
	maxMilestoneBytes     = 200
	maxDecisionOwnerBytes = 200
	maxSourceURLs         = 5
	maxSourceURLBytes     = 500
	maxPlans              = 1000
)

var (
	ErrActorRequired        = errors.New("authenticated context actor is required")
	ErrInvalidInput         = errors.New("invalid human context request")
	ErrPlanNotFound         = errors.New("context plan not found")
	ErrPlanExpired          = errors.New("context plan expired")
	ErrConfirmationRequired = errors.New("context confirmation does not match the plan")
	ErrPlanLimit            = errors.New("too many context plans are pending")
	ErrRedactionForbidden   = errors.New("context redaction is not authorized")
	ErrContextConflict      = errors.New("context changed before confirmation")
	ErrContextUnavailable   = errors.New("human context storage is unavailable")
)

// Actor identifies the authenticated human who supplied the context.
type Actor struct {
	Subject string
	Name    string
}

// Input is the human-supplied portion of a context record. The HTTP handler
// parses and validates date strings before passing normalized times here.
type Input struct {
	Kind           domain.ContextKind
	Statement      string
	Category       string
	ItemIDs        []string
	Milestone      string
	ScopeAction    string
	DecisionOwner  string
	ReportingFrom  *time.Time
	ReportingUntil *time.Time
	EffectiveAt    *time.Time
	SourceURLs     []string
	SupersedesID   string
}

// Plan is the exact context record shown to a human before confirmation.
type Plan struct {
	ID           string              `json:"plan_id"`
	Operation    string              `json:"operation"`
	Entry        domain.HumanContext `json:"entry"`
	Confirmation string              `json:"confirmation"`
	OriginalHash string              `json:"original_hash,omitempty"`
	CreatedAt    time.Time           `json:"created_at"`
	ExpiresAt    time.Time           `json:"expires_at"`
}

type storedPlan struct {
	plan       Plan
	actor      Actor
	inProgress bool
}

// Config wires the context approval service.
type Config struct {
	Store          state.ContextStore
	PlanTTL        time.Duration
	Now            func() time.Time
	Log            *slog.Logger
	RedactSubjects []string
}

// Service creates short-lived, actor-bound context plans and persists only
// explicitly confirmed records.
type Service struct {
	store          state.ContextStore
	planTTL        time.Duration
	now            func() time.Time
	log            *slog.Logger
	redactSubjects map[string]struct{}

	mu    sync.Mutex
	plans map[string]*storedPlan
}

// New validates and constructs the human context service.
func New(cfg Config) (*Service, error) {
	if cfg.Store == nil {
		return nil, errors.New("human context store is required")
	}
	if cfg.PlanTTL <= 0 {
		cfg.PlanTTL = defaultPlanTTL
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	redactSubjects := make(map[string]struct{}, len(cfg.RedactSubjects))
	for _, subject := range cfg.RedactSubjects {
		if subject = strings.TrimSpace(subject); subject != "" {
			redactSubjects[subject] = struct{}{}
		}
	}
	return &Service{
		store:          cfg.Store,
		planTTL:        cfg.PlanTTL,
		now:            cfg.Now,
		log:            cfg.Log,
		redactSubjects: redactSubjects,
		plans:          make(map[string]*storedPlan),
	}, nil
}

// Plan creates an exact, short-lived dry-run without writing a context entry.
// If SupersedesID is supplied, the plan is an append-only correction to the
// latest revision of that context ID.
func (s *Service) Plan(input Input, actor Actor) (Plan, error) {
	actor.Subject = strings.TrimSpace(actor.Subject)
	actor.Name = strings.TrimSpace(actor.Name)
	if actor.Subject == "" {
		return Plan{}, ErrActorRequired
	}
	normalized, err := normalizeInput(input)
	if err != nil {
		return Plan{}, err
	}
	now := s.now().UTC()
	planID, err := randomID()
	if err != nil {
		return Plan{}, fmt.Errorf("create context plan ID: %w", err)
	}
	entryID := planID
	revision := 1
	createdAt := now
	operation := "record"
	originalHash := ""
	if normalized.SupersedesID != "" {
		current, currentErr := s.currentContext(normalized.SupersedesID)
		if currentErr != nil {
			return Plan{}, currentErr
		}
		if current.Status != domain.ContextStatusConfirmed {
			return Plan{}, fmt.Errorf("%w: context is not currently confirmed", ErrInvalidInput)
		}
		if current.Kind != normalized.Kind {
			return Plan{}, fmt.Errorf("%w: a correction must keep the original context kind", ErrInvalidInput)
		}
		entryID = current.ID
		revision = current.Revision + 1
		createdAt = current.CreatedAt
		operation = "correction"
		originalHash = current.ContentHash
	}
	entry := domain.HumanContext{
		ID:             entryID,
		Revision:       revision,
		Kind:           normalized.Kind,
		Status:         domain.ContextStatusProposed,
		Confidence:     domain.ContextConfidenceProposed,
		CreatedAt:      createdAt,
		UpdatedAt:      now,
		AuthorSubject:  actor.Subject,
		Statement:      normalized.Statement,
		Category:       normalized.Category,
		ContentHash:    inputContentHash(normalized),
		ItemIDs:        append([]string(nil), normalized.ItemIDs...),
		Milestone:      normalized.Milestone,
		ScopeAction:    normalized.ScopeAction,
		DecisionOwner:  normalized.DecisionOwner,
		ReportingFrom:  cloneTime(normalized.ReportingFrom),
		ReportingUntil: cloneTime(normalized.ReportingUntil),
		EffectiveAt:    cloneTime(normalized.EffectiveAt),
		SourceURLs:     append([]string(nil), normalized.SourceURLs...),
		SupersedesID:   normalized.SupersedesID,
	}
	plan := Plan{
		ID:           planID,
		Operation:    operation,
		Entry:        entry,
		OriginalHash: originalHash,
		Confirmation: "confirm context " + planID,
		CreatedAt:    now,
		ExpiresAt:    now.Add(s.planTTL),
	}
	if err := s.storePlan(plan, actor, now); err != nil {
		return Plan{}, err
	}
	return clonePlan(plan), nil
}

func (s *Service) storePlan(plan Plan, actor Actor, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked(now)
	if len(s.plans) >= maxPlans {
		return ErrPlanLimit
	}
	s.plans[plan.ID] = &storedPlan{plan: clonePlan(plan), actor: actor}
	return nil
}

func (s *Service) currentContext(id string) (domain.HumanContext, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return domain.HumanContext{}, ErrPlanNotFound
	}
	result, err := s.store.ContextHistory(id)
	if err != nil {
		if errors.Is(err, state.ErrContextNotFound) {
			return domain.HumanContext{}, fmt.Errorf("%w: %s", state.ErrContextNotFound, id)
		}
		return domain.HumanContext{}, fmt.Errorf("%w: context lookup", ErrContextUnavailable)
	}
	if len(result.Revisions) == 0 {
		return domain.HumanContext{}, fmt.Errorf("%w: %s", state.ErrContextNotFound, id)
	}
	return result.Revisions[len(result.Revisions)-1], nil
}

// PlanRedaction creates an exact, actor-authorized plan to scrub free text for
// a retained context ID. The original content is never returned by this plan.
func (s *Service) PlanRedaction(id string, actor Actor) (Plan, error) {
	actor.Subject = strings.TrimSpace(actor.Subject)
	actor.Name = strings.TrimSpace(actor.Name)
	if actor.Subject == "" {
		return Plan{}, ErrActorRequired
	}
	current, err := s.currentContext(id)
	if err != nil {
		return Plan{}, err
	}
	if current.Status != domain.ContextStatusConfirmed {
		return Plan{}, fmt.Errorf("%w: context is not currently confirmed", ErrInvalidInput)
	}
	if !s.canRedact(current, actor.Subject) {
		return Plan{}, ErrRedactionForbidden
	}
	now := s.now().UTC()
	planID, err := randomID()
	if err != nil {
		return Plan{}, fmt.Errorf("create context redaction plan ID: %w", err)
	}
	entry := domain.HumanContext{
		ID:            current.ID,
		Revision:      current.Revision + 1,
		Kind:          current.Kind,
		Status:        domain.ContextStatusProposed,
		Confidence:    domain.ContextConfidenceProposed,
		CreatedAt:     current.CreatedAt,
		UpdatedAt:     now,
		AuthorSubject: actor.Subject,
	}
	plan := Plan{
		ID:           planID,
		Operation:    "redact",
		Entry:        entry,
		OriginalHash: current.ContentHash,
		Confirmation: "confirm context redaction " + planID,
		CreatedAt:    now,
		ExpiresAt:    now.Add(s.planTTL),
	}
	if err := s.storePlan(plan, actor, now); err != nil {
		return Plan{}, err
	}
	return clonePlan(plan), nil
}

func (s *Service) canRedact(entry domain.HumanContext, subject string) bool {
	if len(s.redactSubjects) > 0 {
		_, ok := s.redactSubjects[subject]
		return ok
	}
	return strings.TrimSpace(entry.AuthorSubject) == subject
}

// Confirm persists the exact plan once, after actor and confirmation checks.
func (s *Service) Confirm(ctx stdcontext.Context, planID, confirmation string, actor Actor) (domain.HumanContext, error) {
	actor.Subject = strings.TrimSpace(actor.Subject)
	actor.Name = strings.TrimSpace(actor.Name)
	if actor.Subject == "" {
		return domain.HumanContext{}, ErrActorRequired
	}
	planID = strings.TrimSpace(planID)
	if planID == "" {
		return domain.HumanContext{}, ErrPlanNotFound
	}
	now := s.now().UTC()
	s.mu.Lock()
	stored, ok := s.plans[planID]
	if !ok || stored.actor.Subject != actor.Subject {
		s.mu.Unlock()
		return domain.HumanContext{}, ErrPlanNotFound
	}
	if !now.Before(stored.plan.ExpiresAt) {
		delete(s.plans, planID)
		s.mu.Unlock()
		return domain.HumanContext{}, ErrPlanExpired
	}
	s.expireLocked(now)
	if stored.inProgress {
		s.mu.Unlock()
		return domain.HumanContext{}, ErrConfirmationRequired
	}
	if strings.TrimSpace(confirmation) != stored.plan.Confirmation {
		s.mu.Unlock()
		return domain.HumanContext{}, ErrConfirmationRequired
	}
	stored.inProgress = true
	entry := cloneHumanContext(stored.plan.Entry)
	operation := stored.plan.Operation
	s.mu.Unlock()
	defer s.consumePlan(planID)
	if operation == "redact" {
		entry.Status = domain.ContextStatusRedacted
		entry.Confidence = domain.ContextConfidenceConfirmed
		entry.Statement = "[redacted]"
	} else {
		entry.Status = domain.ContextStatusConfirmed
		entry.Confidence = domain.ContextConfidenceConfirmed
	}

	if err := contextDone(ctx); err != nil {
		return domain.HumanContext{}, err
	}
	var persistErr error
	if operation == "redact" {
		redactor, ok := s.store.(state.ContextRedactor)
		if !ok {
			persistErr = ErrContextUnavailable
		} else {
			persistErr = redactor.RedactContext(entry)
		}
	} else {
		persistErr = s.store.RecordContext(entry)
	}
	if persistErr != nil {
		s.log.Error("human context persistence failed", "context_id", entry.ID, "operation", operation, "error", persistErr)
		if errors.Is(persistErr, state.ErrContextConflict) {
			return domain.HumanContext{}, ErrContextConflict
		}
		return domain.HumanContext{}, fmt.Errorf("%w: persist context", ErrContextUnavailable)
	}
	return entry, nil
}

var allowedCategories = map[string]struct{}{
	"dependency":        {},
	"review":            {},
	"environment":       {},
	"scope":             {},
	"external_decision": {},
	"other":             {},
}

func normalizeInput(input Input) (Input, error) {
	input.Kind = domain.ContextKind(strings.TrimSpace(string(input.Kind)))
	if input.Kind != domain.ContextKindDelayExplanation && input.Kind != domain.ContextKindScopeChange {
		return Input{}, fmt.Errorf("%w: kind must be delay_explanation or scope_change", ErrInvalidInput)
	}
	input.Statement = normalizeText(input.Statement)
	if input.Statement == "" || len(input.Statement) > maxStatementBytes || hasControl(input.Statement) {
		return Input{}, fmt.Errorf("%w: statement must be 1-%d bytes", ErrInvalidInput, maxStatementBytes)
	}
	input.Category = strings.ToLower(strings.TrimSpace(input.Category))
	if input.Category == "" || len(input.Category) > maxCategoryBytes || hasControl(input.Category) {
		return Input{}, fmt.Errorf("%w: category is required and must be at most %d bytes", ErrInvalidInput, maxCategoryBytes)
	}
	if _, ok := allowedCategories[input.Category]; !ok {
		return Input{}, fmt.Errorf("%w: category %q is not supported", ErrInvalidInput, input.Category)
	}
	input.SupersedesID = strings.TrimSpace(input.SupersedesID)
	if len(input.SupersedesID) > maxItemIDBytes || hasControl(input.SupersedesID) {
		return Input{}, fmt.Errorf("%w: supersedes ID is too long or contains control characters", ErrInvalidInput)
	}
	var err error
	input.ItemIDs, err = normalizeList(input.ItemIDs, maxItemIDs, maxItemIDBytes, "item ID")
	if err != nil {
		return Input{}, err
	}
	input.Milestone = strings.TrimSpace(input.Milestone)
	if len(input.Milestone) > maxMilestoneBytes || hasControl(input.Milestone) {
		return Input{}, fmt.Errorf("%w: milestone is too long or contains control characters", ErrInvalidInput)
	}
	input.DecisionOwner = strings.TrimSpace(input.DecisionOwner)
	if len(input.DecisionOwner) > maxDecisionOwnerBytes || hasControl(input.DecisionOwner) {
		return Input{}, fmt.Errorf("%w: decision owner is too long or contains control characters", ErrInvalidInput)
	}
	input.SourceURLs, err = normalizeURLs(input.SourceURLs)
	if err != nil {
		return Input{}, err
	}
	if input.ReportingFrom == nil || input.ReportingUntil == nil {
		return Input{}, fmt.Errorf("%w: reporting_from and reporting_until are required", ErrInvalidInput)
	}
	from, until := input.ReportingFrom.UTC(), input.ReportingUntil.UTC()
	if !until.After(from) {
		return Input{}, fmt.Errorf("%w: reporting_until must be after reporting_from", ErrInvalidInput)
	}
	input.ReportingFrom = &from
	input.ReportingUntil = &until
	if input.Kind == domain.ContextKindScopeChange {
		input.ScopeAction = strings.TrimSpace(input.ScopeAction)
		switch input.ScopeAction {
		case "add", "remove", "defer":
		default:
			return Input{}, fmt.Errorf("%w: scope_action must be add, remove, or defer", ErrInvalidInput)
		}
		if input.EffectiveAt == nil {
			return Input{}, fmt.Errorf("%w: effective_at is required for a scope change", ErrInvalidInput)
		}
	} else {
		input.ScopeAction = ""
		input.DecisionOwner = ""
		input.EffectiveAt = nil
	}
	if input.EffectiveAt != nil {
		value := input.EffectiveAt.UTC()
		input.EffectiveAt = &value
	}
	return input, nil
}

func normalizeText(value string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
}

func normalizeList(values []string, maxCount, maxBytes int, label string) ([]string, error) {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if len(value) > maxBytes || hasControl(value) {
			return nil, fmt.Errorf("%w: %s is too long or contains control characters", ErrInvalidInput, label)
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
		if len(result) > maxCount {
			return nil, fmt.Errorf("%w: at most %d %ss are allowed", ErrInvalidInput, maxCount, label)
		}
	}
	sort.Strings(result)
	return result, nil
}

func normalizeURLs(values []string) ([]string, error) {
	result, err := normalizeList(values, maxSourceURLs, maxSourceURLBytes, "source URL")
	if err != nil {
		return nil, err
	}
	for _, raw := range result {
		parsed, err := url.Parse(raw)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
			return nil, fmt.Errorf("%w: source URLs must be absolute HTTP(S) URLs without credentials", ErrInvalidInput)
		}
	}
	return result, nil
}

func hasControl(value string) bool {
	for _, r := range value {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

func contextDone(ctx stdcontext.Context) error {
	if ctx == nil {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}

func inputContentHash(input Input) string {
	value := struct {
		Kind           domain.ContextKind `json:"kind"`
		Statement      string             `json:"statement"`
		Category       string             `json:"category"`
		ItemIDs        []string           `json:"item_ids,omitempty"`
		Milestone      string             `json:"milestone,omitempty"`
		ScopeAction    string             `json:"scope_action,omitempty"`
		DecisionOwner  string             `json:"decision_owner,omitempty"`
		ReportingFrom  *time.Time         `json:"reporting_from,omitempty"`
		ReportingUntil *time.Time         `json:"reporting_until,omitempty"`
		EffectiveAt    *time.Time         `json:"effective_at,omitempty"`
		SourceURLs     []string           `json:"source_urls,omitempty"`
	}{
		Kind:           input.Kind,
		Statement:      input.Statement,
		Category:       input.Category,
		ItemIDs:        input.ItemIDs,
		Milestone:      input.Milestone,
		ScopeAction:    input.ScopeAction,
		DecisionOwner:  input.DecisionOwner,
		ReportingFrom:  input.ReportingFrom,
		ReportingUntil: input.ReportingUntil,
		EffectiveAt:    input.EffectiveAt,
		SourceURLs:     input.SourceURLs,
	}
	data, _ := json.Marshal(value)
	hash := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(hash[:])
}

func (s *Service) expireLocked(now time.Time) {
	for id, plan := range s.plans {
		if !now.Before(plan.plan.ExpiresAt) {
			delete(s.plans, id)
		}
	}
}

func (s *Service) consumePlan(id string) {
	s.mu.Lock()
	delete(s.plans, id)
	s.mu.Unlock()
}

func cloneTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copyOf := value.UTC()
	return &copyOf
}

func cloneHumanContext(entry domain.HumanContext) domain.HumanContext {
	copyOf := entry
	copyOf.ItemIDs = append([]string(nil), entry.ItemIDs...)
	copyOf.SourceURLs = append([]string(nil), entry.SourceURLs...)
	copyOf.ReportingFrom = cloneTime(entry.ReportingFrom)
	copyOf.ReportingUntil = cloneTime(entry.ReportingUntil)
	copyOf.EffectiveAt = cloneTime(entry.EffectiveAt)
	return copyOf
}

func clonePlan(plan Plan) Plan {
	copyOf := plan
	copyOf.Entry = cloneHumanContext(plan.Entry)
	return copyOf
}

func randomID() (string, error) {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(data[:]), nil
}
