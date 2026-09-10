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
	"strconv"
	"strings"
	"sync"
	"time"

	p "abagile.com/tokyo3/flux/internal/planning"
)

type Client struct {
	instance string
	token    string
	http     *http.Client
	slots    chan struct{}
	mu       sync.Mutex
	retryAt  time.Time
}
type Result struct {
	Observation *p.Observation
	Outcome     string
	RetryAfter  time.Duration
}

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
	return &Client{instance: u.String(), token: token, http: &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, slots: make(chan struct{}, 4)}, nil
}
func (c *Client) Instance() string {
	if c == nil {
		return ""
	}
	return c.instance
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
func (c *Client) Fetch(ctx context.Context, target p.LinkTarget) Result {
	if c == nil {
		return failed("disabled")
	}
	if target.Project <= 0 || target.Project > p.MaxExternalID || target.Number <= 0 || target.Number > p.MaxExternalID || (target.Kind != "mr" && target.Kind != "pipeline") {
		return failed("invalid")
	}
	c.mu.Lock()
	retry := time.Until(c.retryAt)
	c.mu.Unlock()
	if retry > 0 {
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
		wait := retryDelay(res.Header.Get("Retry-After"))
		c.mu.Lock()
		until := time.Now().Add(wait)
		if until.After(c.retryAt) {
			c.retryAt = until
		}
		c.mu.Unlock()
		return Result{Outcome: "rate_limited", RetryAfter: wait}
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
			obs.Pipeline.CurrentHead = data.SHA != "" && data.SHA == pipe.SHA
			if !obs.Pipeline.CurrentHead {
				obs.Pipeline.State = "unknown"
			}
		}
	} else {
		obs.Pipeline = normalize(&data)
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
