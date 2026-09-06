package gitlab

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
)

const (
	defaultHTTPTimeout = 20 * time.Second
	pageSize           = 100
	maxPages           = 1000
)

// Config contains the connection settings for a GitLab API client.
type Config struct {
	URL           string
	Token         string
	HTTPClient    *http.Client
	BlockedLabels []string
}

// Client reads the GitLab REST API and converts its responses into Flux's
// normalized domain model.
type Client struct {
	baseURL       *url.URL
	token         string
	httpClient    *http.Client
	blockedLabels []string
}

// APIError describes a non-successful GitLab API response.
type APIError struct {
	StatusCode int
	Status     string
	Body       string
}

func (e *APIError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("GitLab API: %s", e.Status)
	}
	return fmt.Sprintf("GitLab API: %s: %s", e.Status, e.Body)
}

// New validates the GitLab connection settings and constructs a client.
func New(cfg Config) (*Client, error) {
	rawURL := strings.TrimSpace(cfg.URL)
	if rawURL == "" {
		return nil, errors.New("GitLab URL is required")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("parse GitLab URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("GitLab URL must use http or https")
	}
	if parsed.Host == "" {
		return nil, errors.New("GitLab URL must include a host")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("GitLab URL must not include a query or fragment")
	}
	if strings.TrimSpace(cfg.Token) == "" {
		return nil, errors.New("GitLab token is required")
	}

	parsed.Path = strings.TrimRight(parsed.Path, "/")
	if !strings.HasSuffix(parsed.Path, "/api/v4") {
		parsed.Path += "/api/v4"
	}
	parsed.RawPath = ""

	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultHTTPTimeout}
	}

	blockedLabels := make([]string, 0, len(cfg.BlockedLabels))
	for _, label := range cfg.BlockedLabels {
		if label = strings.TrimSpace(label); label != "" {
			blockedLabels = append(blockedLabels, label)
		}
	}
	if len(blockedLabels) == 0 {
		blockedLabels = []string{"status::blocked", "blocked"}
	}

	return &Client{
		baseURL:       parsed,
		token:         cfg.Token,
		httpClient:    httpClient,
		blockedLabels: blockedLabels,
	}, nil
}

// Snapshot returns the normalized status snapshot for the current GitLab
// group milestone. The milestone is selected from active group milestones on
// every refresh; issues from all projects and subgroups are included.
func (c *Client) Snapshot(ctx context.Context, target, goal string) (domain.Snapshot, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		return domain.Snapshot{}, errors.New("GitLab group is required")
	}

	milestones, err := c.listMilestones(ctx, target)
	if err != nil {
		return domain.Snapshot{}, err
	}
	milestone, err := selectCurrentMilestone(milestones, time.Now().UTC())
	if err != nil {
		return domain.Snapshot{}, err
	}
	return c.snapshotForMilestone(ctx, target, milestone, goal)
}

// ListMilestones returns the active group milestones available for a cockpit
// selection. The GitLab service token stays on the server.
func (c *Client) ListMilestones(ctx context.Context, target string) ([]domain.Milestone, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		return nil, errors.New("GitLab group is required")
	}
	milestones, err := c.listMilestones(ctx, target)
	if err != nil {
		return nil, err
	}
	result := make([]domain.Milestone, 0, len(milestones))
	for _, milestone := range milestones {
		if strings.TrimSpace(milestone.Title) == "" || (milestone.State != "" && milestone.State != "active") {
			continue
		}
		result = append(result, domain.Milestone{
			Name:      milestone.Title,
			Goal:      milestone.Description,
			State:     milestone.State,
			StartDate: milestone.StartDate,
			DueDate:   milestone.DueDate,
		})
	}
	return result, nil
}

// SnapshotForMilestone returns a snapshot for a specifically selected active
// group milestone. It does not change the background rolling milestone or the
// reconciled store.
func (c *Client) SnapshotForMilestone(ctx context.Context, target, name, goal string) (domain.Snapshot, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		return domain.Snapshot{}, errors.New("GitLab group is required")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return domain.Snapshot{}, errors.New("GitLab milestone is required")
	}

	milestones, err := c.listMilestones(ctx, target)
	if err != nil {
		return domain.Snapshot{}, err
	}
	var selected milestoneResponse
	for _, milestone := range milestones {
		if milestone.Title == name && (milestone.State == "" || milestone.State == "active") {
			selected = milestone
			break
		}
	}
	if selected.Title == "" {
		return domain.Snapshot{}, fmt.Errorf("active GitLab milestone %q not found", name)
	}
	return c.snapshotForMilestone(ctx, target, selected, goal)
}

func (c *Client) snapshotForMilestone(ctx context.Context, target string, milestone milestoneResponse, goal string) (domain.Snapshot, error) {
	issues, err := c.listIssues(ctx, target, milestone.Title)
	if err != nil {
		return domain.Snapshot{}, err
	}

	workItems := make([]domain.WorkItem, 0, len(issues))
	for _, issue := range issues {
		if issue.ProjectID <= 0 {
			return domain.Snapshot{}, fmt.Errorf("group issue #%d has no project ID", issue.IID)
		}
		projectTarget := strconv.Itoa(issue.ProjectID)
		item := domain.WorkItem{
			ID:           issueIdentifier(issue),
			ProjectID:    issue.ProjectID,
			ProjectPath:  issueProjectPath(issue),
			Title:        issue.Title,
			State:        issueState(issue.State),
			Assignee:     firstIdentityName(issue.Assignees),
			Blocked:      c.hasBlockedLabel(issue.Labels),
			LastActivity: issue.UpdatedAt,
		}

		mergeRequests, err := c.listRelatedMergeRequests(ctx, projectTarget, issue.IID)
		if err != nil {
			return domain.Snapshot{}, fmt.Errorf("issue #%d: %w", issue.IID, err)
		}
		item.MergeRequests = make([]domain.MergeRequest, 0, len(mergeRequests))
		for _, request := range mergeRequests {
			detail, err := c.getMergeRequest(ctx, projectTarget, request.IID)
			if err != nil {
				return domain.Snapshot{}, fmt.Errorf("merge request !%d: %w", request.IID, err)
			}
			item.MergeRequests = append(item.MergeRequests, domain.MergeRequest{
				ID:              fmt.Sprintf("!%d", detail.IID),
				Title:           detail.Title,
				State:           mergeRequestState(detail.State),
				Draft:           detail.Draft || detail.WorkInProgress,
				ReviewRequested: len(detail.Reviewers) > 0,
				Pipeline:        pipelineStatus(detail.HeadPipeline),
			})
		}
		workItems = append(workItems, item)
	}

	if strings.TrimSpace(goal) == "" {
		goal = milestone.Description
	}
	return domain.Snapshot{
		GeneratedAt: time.Now().UTC(),
		Sprint: domain.Sprint{
			Name:      milestone.Title,
			Goal:      goal,
			WorkItems: workItems,
		},
	}, nil
}

type milestoneResponse struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	State       string `json:"state"`
	StartDate   string `json:"start_date"`
	DueDate     string `json:"due_date"`
}

type issueResponse struct {
	IID        int             `json:"iid"`
	ProjectID  int             `json:"project_id"`
	Title      string          `json:"title"`
	State      string          `json:"state"`
	Assignees  []identity      `json:"assignees"`
	Labels     []string        `json:"labels"`
	UpdatedAt  time.Time       `json:"updated_at"`
	References issueReferences `json:"references"`
}

type issueReferences struct {
	Full string `json:"full"`
}

type mergeRequestResponse struct {
	IID            int               `json:"iid"`
	Title          string            `json:"title"`
	State          string            `json:"state"`
	Draft          bool              `json:"draft"`
	WorkInProgress bool              `json:"work_in_progress"`
	Reviewers      []identity        `json:"reviewers"`
	HeadPipeline   *pipelineResponse `json:"head_pipeline"`
}

type pipelineResponse struct {
	Status string `json:"status"`
}

type identity struct {
	Username string `json:"username"`
	Name     string `json:"name"`
}

func (c *Client) listMilestones(ctx context.Context, target string) ([]milestoneResponse, error) {
	path := "/groups/" + url.PathEscape(target) + "/milestones"
	query := url.Values{"state": {"active"}}
	query.Set("include_descendant_groups", "true")
	return list[milestoneResponse](ctx, c, path, query)
}

type milestoneCandidate struct {
	milestone milestoneResponse
	start     time.Time
	due       time.Time
	hasStart  bool
	hasDue    bool
}

func selectCurrentMilestone(milestones []milestoneResponse, now time.Time) (milestoneResponse, error) {
	today := dateOnly(now.UTC())
	candidates := make([]milestoneCandidate, 0, len(milestones))
	for _, milestone := range milestones {
		if strings.TrimSpace(milestone.Title) == "" || (milestone.State != "" && milestone.State != "active") {
			continue
		}
		start, hasStart, err := parseMilestoneDate(milestone.StartDate)
		if err != nil {
			return milestoneResponse{}, fmt.Errorf("milestone %q start date: %w", milestone.Title, err)
		}
		due, hasDue, err := parseMilestoneDate(milestone.DueDate)
		if err != nil {
			return milestoneResponse{}, fmt.Errorf("milestone %q due date: %w", milestone.Title, err)
		}
		if hasStart && hasDue && due.Before(start) {
			return milestoneResponse{}, fmt.Errorf("milestone %q due date is before its start date", milestone.Title)
		}
		candidates = append(candidates, milestoneCandidate{
			milestone: milestone,
			start:     start,
			due:       due,
			hasStart:  hasStart,
			hasDue:    hasDue,
		})
	}
	if len(candidates) == 0 {
		return milestoneResponse{}, errors.New("no active GitLab milestone found")
	}

	current := make([]milestoneCandidate, 0, len(candidates))
	started := make([]milestoneCandidate, 0, len(candidates))
	future := make([]milestoneCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		isStarted := !candidate.hasStart || !candidate.start.After(today)
		if isStarted {
			started = append(started, candidate)
		}
		if isStarted && (!candidate.hasDue || !candidate.due.Before(today)) {
			current = append(current, candidate)
		}
		if candidate.hasStart && candidate.start.After(today) {
			future = append(future, candidate)
		}
	}
	if len(current) > 0 {
		return mostRecentMilestone(current).milestone, nil
	}
	if len(started) > 0 {
		// An active overdue milestone remains current until it is closed.
		return mostRecentMilestone(started).milestone, nil
	}
	if len(future) > 0 {
		return earliestMilestone(future).milestone, nil
	}
	return milestoneResponse{}, errors.New("no current GitLab milestone found")
}

func parseMilestoneDate(value string) (time.Time, bool, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, false, nil
	}
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil {
		return time.Time{}, false, err
	}
	return parsed.UTC(), true, nil
}

func dateOnly(value time.Time) time.Time {
	value = value.UTC()
	return time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, time.UTC)
}

func mostRecentMilestone(candidates []milestoneCandidate) milestoneCandidate {
	sort.SliceStable(candidates, func(i, j int) bool {
		left, right := candidates[i], candidates[j]
		if left.hasStart != right.hasStart {
			return left.hasStart
		}
		if left.hasStart && !left.start.Equal(right.start) {
			return left.start.After(right.start)
		}
		if left.hasDue != right.hasDue {
			return left.hasDue
		}
		if left.hasDue && !left.due.Equal(right.due) {
			return left.due.Before(right.due)
		}
		return left.milestone.Title < right.milestone.Title
	})
	return candidates[0]
}

func earliestMilestone(candidates []milestoneCandidate) milestoneCandidate {
	sort.SliceStable(candidates, func(i, j int) bool {
		left, right := candidates[i], candidates[j]
		if left.hasStart != right.hasStart {
			return left.hasStart
		}
		if left.hasStart && !left.start.Equal(right.start) {
			return left.start.Before(right.start)
		}
		if left.hasDue != right.hasDue {
			return left.hasDue
		}
		if left.hasDue && !left.due.Equal(right.due) {
			return left.due.Before(right.due)
		}
		return left.milestone.Title < right.milestone.Title
	})
	return candidates[0]
}

func (c *Client) listIssues(ctx context.Context, target, milestone string) ([]issueResponse, error) {
	path := "/groups/" + url.PathEscape(target) + "/issues"
	query := url.Values{
		"milestone": {milestone},
		"order_by":  {"updated_at"},
		"sort":      {"desc"},
		"state":     {"all"},
	}
	query.Set("include_subgroups", "true")
	return list[issueResponse](ctx, c, path, query)
}

func issueIdentifier(issue issueResponse) string {
	if reference := strings.TrimSpace(issue.References.Full); reference != "" {
		return reference
	}
	if issue.ProjectID > 0 {
		return fmt.Sprintf("project/%d#%d", issue.ProjectID, issue.IID)
	}
	return fmt.Sprintf("#%d", issue.IID)
}

func issueProjectPath(issue issueResponse) string {
	reference := strings.TrimSpace(issue.References.Full)
	separator := strings.LastIndexByte(reference, '#')
	if separator <= 0 {
		return ""
	}
	return reference[:separator]
}

func (c *Client) listRelatedMergeRequests(ctx context.Context, project string, issueIID int) ([]mergeRequestResponse, error) {
	path := fmt.Sprintf("/projects/%s/issues/%d/related_merge_requests", url.PathEscape(project), issueIID)
	return list[mergeRequestResponse](ctx, c, path, nil)
}

func (c *Client) getMergeRequest(ctx context.Context, project string, requestIID int) (mergeRequestResponse, error) {
	path := fmt.Sprintf("/projects/%s/merge_requests/%d", url.PathEscape(project), requestIID)
	var request mergeRequestResponse
	_, err := c.getJSON(ctx, path, nil, &request)
	return request, err
}

func list[T any](ctx context.Context, c *Client, path string, query url.Values) ([]T, error) {
	var result []T
	for page := 1; page <= maxPages; page++ {
		pageQuery := cloneValues(query)
		pageQuery.Set("page", strconv.Itoa(page))
		pageQuery.Set("per_page", strconv.Itoa(pageSize))

		var items []T
		headers, err := c.getJSON(ctx, path, pageQuery, &items)
		if err != nil {
			return nil, err
		}
		result = append(result, items...)

		nextPage := strings.TrimSpace(headers.Get("X-Next-Page"))
		if nextPage == "" || len(items) == 0 {
			return result, nil
		}
		next, err := strconv.Atoi(nextPage)
		if err != nil || next <= page {
			return nil, fmt.Errorf("invalid GitLab pagination header X-Next-Page=%q", nextPage)
		}
		page = next - 1
	}
	return nil, fmt.Errorf("GitLab pagination exceeded %d pages", maxPages)
}

func (c *Client) getJSON(ctx context.Context, path string, query url.Values, output any) (http.Header, error) {
	requestURL := c.endpoint(path, query)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("create GitLab request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("PRIVATE-TOKEN", c.token)

	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("request GitLab API: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 8<<10))
		if readErr != nil {
			return response.Header, fmt.Errorf("read GitLab error response: %w", readErr)
		}
		return response.Header, &APIError{
			StatusCode: response.StatusCode,
			Status:     response.Status,
			Body:       strings.TrimSpace(string(body)),
		}
	}

	if output == nil {
		return response.Header, nil
	}
	if err := json.NewDecoder(response.Body).Decode(output); err != nil {
		return response.Header, fmt.Errorf("decode GitLab response: %w", err)
	}
	return response.Header, nil
}

func (c *Client) endpoint(path string, query url.Values) *url.URL {
	endpoint := *c.baseURL
	rawPath := strings.TrimRight(c.baseURL.EscapedPath(), "/") + path
	decodedPath, err := url.PathUnescape(rawPath)
	if err != nil {
		decodedPath = strings.TrimRight(c.baseURL.Path, "/") + path
	}
	endpoint.Path = decodedPath
	endpoint.RawPath = rawPath
	endpoint.RawQuery = query.Encode()
	return &endpoint
}

func cloneValues(values url.Values) url.Values {
	clone := make(url.Values, len(values))
	for key, entries := range values {
		clone[key] = append([]string(nil), entries...)
	}
	return clone
}

func (c *Client) hasBlockedLabel(labels []string) bool {
	for _, label := range labels {
		for _, blocked := range c.blockedLabels {
			if strings.EqualFold(label, blocked) {
				return true
			}
		}
	}
	return false
}

func firstIdentityName(identities []identity) string {
	if len(identities) == 0 {
		return ""
	}
	if identities[0].Username != "" {
		return identities[0].Username
	}
	return identities[0].Name
}

func issueState(state string) domain.IssueState {
	if state == "closed" {
		return domain.IssueClosed
	}
	return domain.IssueOpen
}

func mergeRequestState(state string) domain.MergeRequestState {
	switch state {
	case "merged":
		return domain.MergeRequestMerged
	case "closed":
		return domain.MergeRequestClosed
	default:
		return domain.MergeRequestOpen
	}
}

func pipelineStatus(pipeline *pipelineResponse) domain.PipelineStatus {
	if pipeline == nil {
		return domain.PipelineUnknown
	}
	switch pipeline.Status {
	case "success":
		return domain.PipelineSuccess
	case "failed":
		return domain.PipelineFailed
	case "running", "preparing":
		return domain.PipelineRunning
	case "created", "pending", "waiting_for_resource":
		return domain.PipelinePending
	case "canceled", "canceling":
		return domain.PipelineCanceled
	default:
		return domain.PipelineUnknown
	}
}
