// Package integration observes registered engineering objects. It never writes
// to GitLab and does not reuse legacy issue/milestone planning reconciliation.
package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	p "abagile.com/tokyo3/flux/internal/planning"
)

type Client struct {
	instance        string
	token           string
	http            *http.Client
	slots           chan struct{}
	mu              sync.Mutex
	retryAt         time.Time
	profiles        map[int64]cachedProfile
	projects        []Project
	projectsExpires time.Time
}
type Result struct {
	Observation *p.Observation
	Outcome     string
	RetryAfter  time.Duration
}
type MemberProfile struct {
	Name      string
	Username  string
	AvatarURL string
}
type Project struct {
	ID                int64
	Name              string
	PathWithNamespace string
}
type MergeRequest struct {
	IID       int64
	Title     string
	State     string
	Draft     bool
	UpdatedAt *time.Time
}
type cachedProfile struct {
	profile MemberProfile
	found   bool
	expires time.Time
}

const (
	memberProfileTTL         = 10 * time.Minute
	memberProfileFailureTTL  = time.Minute
	projectCatalogTTL        = time.Minute
	projectPageSize          = 100
	maxCatalogProjects       = 1000
	maxCatalogPages          = maxCatalogProjects / projectPageSize
	maxMergeRequestAssignees = 50
	maxMergeRequestResults   = 50
)

// New accepts a trusted operator-configured instance, never a member-supplied
// URL. HTTPS is mandatory except loopback fixtures. Redirects never carry tokens.
func New(rawURL, token string) (*Client, error) {
	if rawURL == "" && token == "" {
		return nil, nil
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Hostname() == "" || u.User != nil || u.ForceQuery || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" || strings.ContainsAny(rawURL, "\\\r\n\t") {
		return nil, errors.New("invalid GitLab observation instance URL")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return nil, errors.New("invalid GitLab read URL port")
		}
	}
	ip := net.ParseIP(u.Hostname())
	loopback := u.Hostname() == "localhost" || ip != nil && ip.IsLoopback()
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return nil, errors.New("GitLab read URL requires HTTPS (HTTP permitted only on loopback)")
	}
	u.Path = strings.TrimRight(u.Path, "/")
	if u.Path != "" && path.Clean(u.Path) != u.Path {
		return nil, errors.New("GitLab read URL must have a canonical instance path")
	}
	if strings.TrimSpace(token) == "" || strings.ContainsAny(token, "\r\n") {
		return nil, errors.New("GitLab service/read token is required and must be a single line")
	}
	return &Client{instance: u.String(), token: token, http: &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, slots: make(chan struct{}, 4), profiles: map[int64]cachedProfile{}}, nil
}
func (c *Client) Instance() string {
	if c == nil {
		return ""
	}
	return c.instance
}

// Profiles resolves numeric workspace subjects to GitLab profile metadata. It
// is best-effort and intentionally not part of planning state: a provider
// failure leaves the native member record unchanged. Missing profiles and
// short-lived provider failures are cached briefly, so an unavailable or
// unauthorized users endpoint does not turn every board read into another
// provider request.
func (c *Client) Profiles(ctx context.Context, subjects []string) map[string]MemberProfile {
	out := map[string]MemberProfile{}
	if c == nil {
		return out
	}
	ids := make([]int64, 0, len(subjects))
	seen := map[int64]bool{}
	for _, subject := range subjects {
		id, err := strconv.ParseInt(subject, 10, 64)
		if err != nil || id <= 0 || id > p.MaxExternalID || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return out
	}
	now := time.Now()
	missing := make([]int64, 0, len(ids))
	c.mu.Lock()
	if c.profiles == nil {
		c.profiles = map[int64]cachedProfile{}
	}
	for _, id := range ids {
		cached, ok := c.profiles[id]
		if !ok || !now.Before(cached.expires) {
			missing = append(missing, id)
			continue
		}
		if cached.found {
			out[strconv.FormatInt(id, 10)] = cached.profile
		}
	}
	c.mu.Unlock()
	for start := 0; start < len(missing); start += 100 {
		end := min(start+100, len(missing))
		chunk := missing[start:end]
		profiles, ok := c.fetchProfiles(ctx, chunk)
		c.mu.Lock()
		if !ok {
			for _, id := range chunk {
				c.profiles[id] = cachedProfile{expires: now.Add(memberProfileFailureTTL)}
			}
			c.mu.Unlock()
			continue
		}
		for _, id := range missing[start:end] {
			profile, found := profiles[id]
			c.profiles[id] = cachedProfile{profile: profile, found: found, expires: now.Add(memberProfileTTL)}
			if found {
				out[strconv.FormatInt(id, 10)] = profile
			}
		}
		c.mu.Unlock()
	}
	return out
}

type profileResponse struct {
	ID        int64  `json:"id"`
	Username  string `json:"username"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
}

func (c *Client) fetchProfiles(ctx context.Context, ids []int64) (map[int64]MemberProfile, bool) {
	select {
	case c.slots <- struct{}{}:
		defer func() { <-c.slots }()
	default:
		return nil, false
	}
	endpoint, err := url.Parse(c.instance + "/api/v4/users")
	if err != nil {
		return nil, false
	}
	query := endpoint.Query()
	for _, id := range ids {
		query.Add("user_ids[]", strconv.FormatInt(id, 10))
	}
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, false
	}
	request.Header.Set("PRIVATE-TOKEN", c.token)
	request.Header.Set("Accept", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return nil, false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, false
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(body) > 1<<20 {
		return nil, false
	}
	var data []profileResponse
	if json.Unmarshal(body, &data) != nil {
		return nil, false
	}
	profiles := make(map[int64]MemberProfile, len(data))
	for _, user := range data {
		if user.ID <= 0 || user.ID > p.MaxExternalID || len(user.Username) > 120 || len(user.Name) > 120 || len(user.AvatarURL) > 2048 {
			continue
		}
		name := bounded(strings.TrimSpace(user.Name), 120)
		username := bounded(strings.TrimSpace(user.Username), 120)
		if name == "" {
			name = username
		}
		profiles[user.ID] = MemberProfile{Name: name, Username: username, AvatarURL: c.safeAvatarURL(user.AvatarURL)}
	}
	return profiles, true
}

type projectResponse struct {
	ID                int64  `json:"id"`
	Name              string `json:"name"`
	PathWithNamespace string `json:"path_with_namespace"`
}
type mergeRequestResponse struct {
	ID        int64      `json:"id"`
	IID       int64      `json:"iid"`
	ProjectID int64      `json:"project_id"`
	Title     string     `json:"title"`
	State     string     `json:"state"`
	Draft     bool       `json:"draft"`
	UpdatedAt *time.Time `json:"updated_at"`
}

// Projects returns projects visible to the configured read connector. The
// short cache keeps opening the approval dialog from repeatedly querying
// GitLab while retaining a bounded catalog for the browser.
func (c *Client) Projects(ctx context.Context) ([]Project, error) {
	if c == nil {
		return nil, errors.New("GitLab connector is disabled")
	}
	now := time.Now()
	c.mu.Lock()
	if now.Before(c.projectsExpires) {
		out := append([]Project(nil), c.projects...)
		c.mu.Unlock()
		return out, nil
	}
	c.mu.Unlock()
	if retry := c.retryRemaining(); retry > 0 {
		return nil, fmt.Errorf("GitLab connector is rate limited for %s", retry)
	}

	select {
	case c.slots <- struct{}{}:
		defer func() { <-c.slots }()
	default:
		return nil, errors.New("GitLab connector is busy")
	}
	projects, err := c.fetchProjects(ctx)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.projects = append([]Project(nil), projects...)
	c.projectsExpires = time.Now().Add(projectCatalogTTL)
	c.mu.Unlock()
	return projects, nil
}

func (c *Client) fetchProjects(ctx context.Context) ([]Project, error) {
	endpoint, err := url.Parse(c.instance + "/api/v4/projects")
	if err != nil {
		return nil, errors.New("invalid GitLab project catalog endpoint")
	}
	query := endpoint.Query()
	query.Set("membership", "true")
	query.Set("simple", "true")
	query.Set("per_page", strconv.Itoa(projectPageSize))
	query.Set("order_by", "name")
	query.Set("sort", "asc")
	projects := []Project{}
	seen := map[int64]struct{}{}
	for page := 1; ; page++ {
		if page > maxCatalogPages {
			return nil, errors.New("GitLab project catalog exceeds the supported limit")
		}
		query.Set("page", strconv.Itoa(page))
		endpoint.RawQuery = query.Encode()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
		if err != nil {
			return nil, errors.New("create GitLab project catalog request")
		}
		request.Header.Set("PRIVATE-TOKEN", c.token)
		request.Header.Set("Accept", "application/json")
		response, err := c.http.Do(request)
		if err != nil {
			return nil, errors.New("request GitLab project catalog")
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
		response.Body.Close()
		if readErr != nil || len(body) > 1<<20 {
			return nil, errors.New("GitLab project catalog response is invalid")
		}
		if response.StatusCode == http.StatusTooManyRequests {
			c.setRetryAfter(response.Header.Get("Retry-After"))
			return nil, errors.New("GitLab project catalog is rate limited")
		}
		if response.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("GitLab project catalog returned %s", response.Status)
		}
		var data []projectResponse
		if err := json.Unmarshal(body, &data); err != nil {
			return nil, errors.New("GitLab project catalog response is invalid")
		}
		if len(data) > projectPageSize {
			return nil, errors.New("GitLab project catalog response is too large")
		}
		for _, project := range data {
			name := strings.TrimSpace(project.Name)
			pathWithNamespace := strings.TrimSpace(project.PathWithNamespace)
			if project.ID <= 0 || project.ID > p.MaxExternalID || len(name) > 240 || len(pathWithNamespace) > 512 || name == "" {
				return nil, errors.New("GitLab project catalog response is invalid")
			}
			if _, ok := seen[project.ID]; ok {
				continue
			}
			seen[project.ID] = struct{}{}
			projects = append(projects, Project{ID: project.ID, Name: bounded(name, 240), PathWithNamespace: bounded(pathWithNamespace, 512)})
			if len(projects) > maxCatalogProjects {
				return nil, errors.New("GitLab project catalog exceeds the supported limit")
			}
		}
		if len(data) == 0 {
			break
		}
		nextRaw := strings.TrimSpace(response.Header.Get("X-Next-Page"))
		if nextRaw == "" {
			if len(data) < projectPageSize || page == maxCatalogPages {
				break
			}
			continue
		}
		next, err := strconv.Atoi(nextRaw)
		if err != nil || next <= page || next > maxCatalogPages {
			return nil, errors.New("GitLab project catalog pagination is invalid")
		}
		page = next - 1
	}
	return projects, nil
}

// MergeRequests searches recent merge requests in one approved project. An
// optional assignee list narrows the search to GitLab user IDs; the caller must
// resolve those IDs from workspace authority before calling this method.
func (c *Client) MergeRequests(ctx context.Context, projectID int64, search string, assigneeIDs ...int64) ([]MergeRequest, error) {
	if c == nil || projectID <= 0 || projectID > p.MaxExternalID {
		return nil, errors.New("invalid GitLab merge-request search")
	}
	if len(search) > 120 || strings.ContainsAny(search, "\r\n") {
		return nil, errors.New("GitLab merge-request search is invalid")
	}
	search = strings.TrimSpace(search)
	assignees := make([]int64, 0, len(assigneeIDs))
	seenAssignees := map[int64]struct{}{}
	for _, id := range assigneeIDs {
		if id <= 0 || id > p.MaxExternalID {
			return nil, errors.New("invalid GitLab merge-request assignee")
		}
		if _, ok := seenAssignees[id]; ok {
			continue
		}
		seenAssignees[id] = struct{}{}
		assignees = append(assignees, id)
	}
	if len(assignees) > maxMergeRequestAssignees {
		return nil, errors.New("too many GitLab merge-request assignees")
	}
	if retry := c.retryRemaining(); retry > 0 {
		return nil, fmt.Errorf("GitLab connector is rate limited for %s", retry)
	}
	select {
	case c.slots <- struct{}{}:
		defer func() { <-c.slots }()
	default:
		return nil, errors.New("GitLab connector is busy")
	}
	if len(assignees) == 0 {
		data, err := c.fetchMergeRequests(ctx, projectID, search, 0)
		if err != nil {
			return nil, err
		}
		return normalizeMergeRequests(projectID, data)
	}
	data := make([]mergeRequestResponse, 0, len(assignees)*maxMergeRequestResults)
	for _, assignee := range assignees {
		page, err := c.fetchMergeRequests(ctx, projectID, search, assignee)
		if err != nil {
			return nil, err
		}
		data = append(data, page...)
	}
	return normalizeMergeRequests(projectID, data)
}

func (c *Client) fetchMergeRequests(ctx context.Context, projectID int64, search string, assigneeID int64) ([]mergeRequestResponse, error) {
	endpoint := fmt.Sprintf("%s/api/v4/projects/%d/merge_requests", c.instance, projectID)
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, errors.New("invalid GitLab merge-request search endpoint")
	}
	query := parsed.Query()
	query.Set("state", "all")
	query.Set("order_by", "updated_at")
	query.Set("sort", "desc")
	query.Set("per_page", strconv.Itoa(maxMergeRequestResults))
	if assigneeID > 0 {
		query.Set("assignee_id", strconv.FormatInt(assigneeID, 10))
	}
	if search != "" {
		if iid, parseErr := strconv.ParseInt(search, 10, 64); parseErr == nil && iid > 0 && iid <= p.MaxExternalID {
			query.Set("iids[]", strconv.FormatInt(iid, 10))
		} else {
			query.Set("search", search)
			query.Set("in", "title")
		}
	}
	parsed.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, errors.New("create GitLab merge-request search request")
	}
	request.Header.Set("PRIVATE-TOKEN", c.token)
	request.Header.Set("Accept", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return nil, errors.New("request GitLab merge-request search")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusTooManyRequests {
		c.setRetryAfter(response.Header.Get("Retry-After"))
		return nil, errors.New("GitLab merge-request search is rate limited")
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitLab merge-request search returned %s", response.Status)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(body) > 1<<20 {
		return nil, errors.New("GitLab merge-request search response is invalid")
	}
	var data []mergeRequestResponse
	if err := json.Unmarshal(body, &data); err != nil || len(data) > maxMergeRequestResults {
		return nil, errors.New("GitLab merge-request search response is invalid")
	}
	return data, nil
}

func normalizeMergeRequests(projectID int64, data []mergeRequestResponse) ([]MergeRequest, error) {
	out := make([]MergeRequest, 0, min(len(data), maxMergeRequestResults))
	seen := map[int64]struct{}{}
	for _, mr := range data {
		if mr.ID <= 0 || mr.ID > p.MaxExternalID || mr.IID <= 0 || mr.IID > p.MaxExternalID || mr.ProjectID != projectID || len(mr.Title) > 240 || len(mr.State) > 40 || strings.TrimSpace(mr.Title) == "" {
			return nil, errors.New("GitLab merge-request search response is invalid")
		}
		if _, ok := seen[mr.IID]; ok {
			continue
		}
		seen[mr.IID] = struct{}{}
		out = append(out, MergeRequest{IID: mr.IID, Title: bounded(mr.Title, 240), State: bounded(mr.State, 40), Draft: mr.Draft, UpdatedAt: mr.UpdatedAt})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].UpdatedAt == nil {
			return out[j].UpdatedAt != nil
		}
		if out[j].UpdatedAt == nil {
			return false
		}
		if !out[i].UpdatedAt.Equal(*out[j].UpdatedAt) {
			return out[i].UpdatedAt.After(*out[j].UpdatedAt)
		}
		return out[i].IID > out[j].IID
	})
	if len(out) > maxMergeRequestResults {
		out = out[:maxMergeRequestResults]
	}
	return out, nil
}

type response struct {
	UpdatedAt    *time.Time `json:"updated_at"`
	ID           int64      `json:"id"`
	IID          int64      `json:"iid"`
	ProjectID    int64      `json:"project_id"`
	WebURL       string     `json:"web_url"`
	Title        string     `json:"title"`
	State        string     `json:"state"`
	Draft        bool       `json:"draft"`
	Review       string     `json:"detailed_merge_status"`
	SHA          string     `json:"sha"`
	Status       string     `json:"status"`
	HeadPipeline *response  `json:"head_pipeline"`
}

func failed(outcome string) Result { return Result{Outcome: outcome, RetryAfter: 30 * time.Second} }
func (c *Client) retryRemaining() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.Until(c.retryAt)
}
func (c *Client) setRetryAfter(raw string) time.Duration {
	wait := retryDelay(raw)
	c.mu.Lock()
	until := time.Now().Add(wait)
	if until.After(c.retryAt) {
		c.retryAt = until
	}
	c.mu.Unlock()
	return wait
}
func (c *Client) Fetch(ctx context.Context, target p.LinkTarget) Result {
	if c == nil {
		return failed("disabled")
	}
	if target.Project <= 0 || target.Project > p.MaxExternalID || target.Number <= 0 || target.Number > p.MaxExternalID || (target.Kind != "mr" && target.Kind != "pipeline") {
		return failed("invalid")
	}
	if retry := c.retryRemaining(); retry > 0 {
		return Result{Outcome: "rate_limited", RetryAfter: retry}
	}
	select {
	case c.slots <- struct{}{}:
		defer func() { <-c.slots }()
	default:
		return failed("busy")
	}
	endpoint := "pipelines"
	if target.Kind == "mr" {
		endpoint = "merge_requests"
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/api/v4/projects/%d/%s/%d", c.instance, target.Project, endpoint, target.Number), nil)
	if err != nil {
		return failed("unavailable")
	}
	request.Header.Set("PRIVATE-TOKEN", c.token)
	request.Header.Set("Accept", "application/json")
	res, err := c.http.Do(request)
	if err != nil {
		return failed("unavailable")
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case 401, 403:
		return failed("inaccessible")
	case 404:
		return failed("not_found") // GitLab also hides unauthorized objects as 404.
	case 429:
		return Result{Outcome: "rate_limited", RetryAfter: c.setRetryAfter(res.Header.Get("Retry-After"))}
	case 200:
	default:
		return failed("unavailable")
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, (1<<20)+1))
	if err != nil || len(body) > 1<<20 {
		return failed("invalid_response")
	}
	var data response
	if json.Unmarshal(body, &data) != nil || data.ProjectID != target.Project || data.ID <= 0 || data.ID > p.MaxExternalID || len(data.SHA) > 128 {
		return failed("invalid_response")
	}
	if target.Kind == "mr" && data.IID != target.Number || target.Kind == "pipeline" && data.ID != target.Number {
		return failed("invalid_response")
	}
	obs := &p.Observation{URL: c.safeURL(data.WebURL), SourceUpdatedAt: data.UpdatedAt}
	if target.Kind == "mr" {
		obs.Title = bounded(data.Title, 240)
		obs.MRState = bounded(data.State, 40)
		obs.Draft = data.Draft
		obs.Review = bounded(data.Review, 80)
		obs.HeadSHA = data.SHA
		if pipe := data.HeadPipeline; pipe != nil && pipe.ID > 0 {
			if pipe.ID > p.MaxExternalID || len(pipe.SHA) > 128 {
				return failed("invalid_response")
			}
			obs.Pipeline = normalize(pipe)
			obs.Pipeline.URL = c.safeURL(pipe.WebURL)
			obs.Pipeline.CurrentHead = data.SHA != "" && data.SHA == pipe.SHA
			if !obs.Pipeline.CurrentHead {
				obs.Pipeline.State = "unknown"
			}
		}
	} else {
		obs.Pipeline = normalize(&data)
		obs.Pipeline.URL = c.safeURL(data.WebURL)
	}
	return Result{Observation: obs, Outcome: "ok", RetryAfter: 30 * time.Second}
}
func normalize(v *response) *p.Pipeline {
	state := "unknown"
	switch v.Status {
	case "created", "waiting_for_resource", "preparing", "pending", "scheduled":
		state = "pending"
	case "running", "success", "failed", "canceled", "skipped", "manual":
		state = v.Status
	}
	return &p.Pipeline{SourceUpdatedAt: v.UpdatedAt, ID: v.ID, SHA: bounded(v.SHA, 128), State: state, ProviderState: bounded(v.Status, 80)}
}
func bounded(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
func (c *Client) safeURL(raw string) string {
	u, err := url.Parse(raw)
	base, _ := url.Parse(c.instance)
	if err != nil || len(raw) > 2048 || u.Scheme != base.Scheme || u.Host != base.Host || u.User != nil || u.ForceQuery || u.RawQuery != "" || u.Fragment != "" || !strings.HasPrefix(u.Path, base.Path+"/") {
		return ""
	}
	return u.String()
}
func (c *Client) safeAvatarURL(raw string) string {
	if len(raw) > 2048 {
		return ""
	}
	u, err := url.Parse(raw)
	base, baseErr := url.Parse(c.instance)
	if err != nil || baseErr != nil || u.User != nil || u.ForceQuery || u.Fragment != "" || u.RawPath != "" || path.Clean(u.Path) != u.Path {
		return ""
	}
	if u.Scheme == base.Scheme && u.Host == base.Host && u.RawQuery == "" {
		return u.String()
	}
	return safeGravatarURL(u)
}
func safeGravatarURL(u *url.URL) string {
	if u == nil || u.Scheme != "https" || u.Port() != "" || !gravatarHost(u.Hostname()) {
		return ""
	}
	const prefix = "/avatar/"
	hash := strings.TrimPrefix(u.Path, prefix)
	if !strings.HasPrefix(u.Path, prefix) || (len(hash) != 32 && len(hash) != 64) {
		return ""
	}
	for _, char := range hash {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
			return ""
		}
	}
	return "https://" + strings.ToLower(u.Hostname()) + prefix + strings.ToLower(hash)
}
func gravatarHost(host string) bool {
	switch strings.ToLower(strings.TrimSuffix(host, ".")) {
	case "gravatar.com", "www.gravatar.com", "secure.gravatar.com":
		return true
	default:
		return false
	}
}
func retryDelay(raw string) time.Duration {
	delay := time.Minute
	if seconds, err := strconv.ParseInt(raw, 10, 64); err == nil && seconds > 0 {
		if seconds > 3600 {
			seconds = 3600
		}
		delay = time.Duration(seconds) * time.Second
	} else if date, err := http.ParseTime(raw); err == nil {
		delay = time.Until(date)
	}
	if delay < 30*time.Second {
		return 30 * time.Second
	}
	if delay > time.Hour {
		return time.Hour
	}
	return delay
}
