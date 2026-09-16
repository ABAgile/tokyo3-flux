package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	basecrypto "github.com/abagile/tokyo3-base/crypto"
	"github.com/abagile/tokyo3-base/sealedcookie"
	"github.com/abagile/tokyo3-base/session"
	"golang.org/x/oauth2"
)

const flowTTL = 10 * time.Minute

// Config contains the GitLab OAuth application settings. The client secret is
// kept server-side; it is never placed in a browser cookie or agent context.
type Config struct {
	GitLabURL    string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	Scopes       []string
	HTTPClient   *http.Client
	Log          *slog.Logger
}

// Authenticator implements the browser Authorization Code flow against
// GitLab's OAuth provider and issues Flux's sealed session cookie.
type Authenticator struct {
	oauth      oauth2.Config
	gitlabURL  string
	userURL    string
	httpClient *http.Client
	sessions   *session.Manager
	flowCookie sealedcookie.Cookie
	log        *slog.Logger
}

// NewGitLab validates OAuth settings and constructs an authenticator. The
// session manager supplies the sealed session key, cookie scope, clock, and
// session lifetime.
func NewGitLab(cfg Config, sessions *session.Manager) (*Authenticator, error) {
	if sessions == nil {
		return nil, errors.New("GitLab auth session manager is required")
	}
	baseURL, err := parseBaseURL(cfg.GitLabURL)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(cfg.ClientID) == "" {
		return nil, errors.New("GitLab OAuth client ID is required")
	}
	if strings.TrimSpace(cfg.ClientSecret) == "" {
		return nil, errors.New("GitLab OAuth client secret is required")
	}
	if strings.TrimSpace(cfg.RedirectURL) == "" {
		return nil, errors.New("GitLab OAuth redirect URL is required")
	}
	redirectURL, err := url.Parse(cfg.RedirectURL)
	if err != nil || redirectURL.Scheme == "" || redirectURL.Host == "" {
		return nil, errors.New("GitLab OAuth redirect URL must be absolute")
	}
	if len(cfg.Scopes) == 0 {
		cfg.Scopes = []string{"read_user"}
	}
	for i := range cfg.Scopes {
		cfg.Scopes[i] = strings.TrimSpace(cfg.Scopes[i])
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 15 * time.Second}
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}

	return &Authenticator{
		gitlabURL: baseURL,
		oauth: oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			Endpoint: oauth2.Endpoint{
				AuthURL:  baseURL + "/oauth/authorize",
				TokenURL: baseURL + "/oauth/token",
			},
			RedirectURL: cfg.RedirectURL,
			Scopes:      cfg.Scopes,
		},
		userURL:    baseURL + "/api/v4/user",
		httpClient: cfg.HTTPClient,
		sessions:   sessions,
		flowCookie: sessions.SiblingCookie("oauth_flow"),
		log:        cfg.Log,
	}, nil
}

// Handler returns the login, callback, and logout routes.
func (a *Authenticator) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /auth/login", a.login)
	mux.HandleFunc("GET /auth/callback", a.callback)
	mux.Handle("GET /auth/logout", a.sessions.LogoutHandler())
	return mux
}

type flowState struct {
	State    string `json:"state"`
	Verifier string `json:"verifier"`
	ReturnTo string `json:"return_to"`
}

type gitlabUser struct {
	ID        int64  `json:"id"`
	Username  string `json:"username"`
	Name      string `json:"name"`
	Email     string `json:"email"`
	AvatarURL string `json:"avatar_url"`
	State     string `json:"state"`
}

func (a *Authenticator) login(w http.ResponseWriter, r *http.Request) {
	state, err := randomState()
	if err != nil {
		a.log.Error("GitLab OAuth state generation failed", "error", err)
		http.Error(w, "login initialization failed", http.StatusInternalServerError)
		return
	}
	verifier, err := randomState()
	if err != nil {
		a.log.Error("GitLab OAuth verifier generation failed", "error", err)
		http.Error(w, "login initialization failed", http.StatusInternalServerError)
		return
	}
	flow := flowState{
		State:    state,
		Verifier: verifier,
		ReturnTo: a.sessions.SafeReturnTo(r.URL.Query().Get("return_to")),
	}
	if err := a.flowCookie.Set(w, r, flow, flowTTL); err != nil {
		a.log.Error("GitLab OAuth flow cookie failed", "error", err)
		http.Error(w, "login initialization failed", http.StatusInternalServerError)
		return
	}
	challenge := pkceChallenge(verifier)
	authURL := a.oauth.AuthCodeURL(state,
		oauth2.SetAuthURLParam("code_challenge", challenge),
		oauth2.SetAuthURLParam("code_challenge_method", "S256"),
	)
	http.Redirect(w, r, authURL, http.StatusSeeOther)
}

func (a *Authenticator) callback(w http.ResponseWriter, r *http.Request) {
	var flow flowState
	if err := a.flowCookie.Read(r, &flow); err != nil {
		http.Error(w, "login session expired; start again", http.StatusBadRequest)
		return
	}
	a.flowCookie.Clear(w, r)

	query := r.URL.Query()
	if providerError := query.Get("error"); providerError != "" {
		http.Error(w, "GitLab login was not completed", http.StatusUnauthorized)
		return
	}
	if flow.State == "" || flow.Verifier == "" || subtle.ConstantTimeCompare([]byte(flow.State), []byte(query.Get("state"))) != 1 {
		http.Error(w, "state mismatch; start again", http.StatusBadRequest)
		return
	}
	code := query.Get("code")
	if code == "" {
		http.Error(w, "authorization code missing", http.StatusBadRequest)
		return
	}

	ctx := context.WithValue(r.Context(), oauth2.HTTPClient, a.httpClient)
	token, err := a.oauth.Exchange(ctx, code, oauth2.SetAuthURLParam("code_verifier", flow.Verifier))
	if err != nil || token == nil || token.AccessToken == "" {
		a.log.Warn("GitLab OAuth token exchange failed", "error", err)
		http.Error(w, "login exchange failed", http.StatusBadGateway)
		return
	}
	user, err := a.fetchUser(r.Context(), token)
	if err != nil {
		a.log.Warn("GitLab OAuth user lookup failed", "error", err)
		http.Error(w, "login identity lookup failed", http.StatusBadGateway)
		return
	}
	if user.State != "" && user.State != "active" {
		http.Error(w, "GitLab account is not active", http.StatusForbidden)
		return
	}

	sess, err := a.sessions.NewSession()
	if err != nil {
		a.log.Error("Flux session creation failed", "error", err)
		http.Error(w, "session initialization failed", http.StatusInternalServerError)
		return
	}
	sess.Subject = strconv.FormatInt(user.ID, 10)
	sess.Email = user.Email
	sess.Name = user.Name
	if sess.Name == "" {
		sess.Name = user.Username
	}
	if avatar := safeAvatarURL(a.gitlabURL, user.AvatarURL); avatar != "" {
		sess.Extra, _ = json.Marshal(struct {
			AvatarURL string `json:"avatar_url"`
		}{AvatarURL: avatar})
	}
	if err := a.sessions.IssueSession(w, r, sess); err != nil {
		a.log.Error("Flux session issuance failed", "error", err)
		http.Error(w, "session initialization failed", http.StatusInternalServerError)
		return
	}
	a.log.Info("GitLab OAuth login completed", "subject", sess.Subject, "username", user.Username)
	http.Redirect(w, r, flow.ReturnTo, http.StatusSeeOther)
}

func (a *Authenticator) fetchUser(ctx context.Context, token *oauth2.Token) (gitlabUser, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, a.userURL, nil)
	if err != nil {
		return gitlabUser{}, fmt.Errorf("create user request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token.AccessToken)
	response, err := a.httpClient.Do(request)
	if err != nil {
		return gitlabUser{}, fmt.Errorf("request user: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 8<<10))
		return gitlabUser{}, fmt.Errorf("user endpoint %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	var user gitlabUser
	if err := json.NewDecoder(response.Body).Decode(&user); err != nil {
		return gitlabUser{}, fmt.Errorf("decode user: %w", err)
	}
	if user.ID == 0 || user.Username == "" {
		return gitlabUser{}, errors.New("user endpoint returned incomplete identity")
	}
	return user, nil
}

func safeAvatarURL(baseRaw, raw string) string {
	if len(raw) > 2048 {
		return ""
	}
	base, err := url.Parse(baseRaw)
	avatar, avatarErr := url.Parse(raw)
	if err != nil || avatarErr != nil || avatar.User != nil || avatar.ForceQuery || avatar.Fragment != "" || avatar.RawPath != "" || path.Clean(avatar.Path) != avatar.Path {
		return ""
	}
	if avatar.Scheme == base.Scheme && avatar.Host == base.Host && avatar.RawQuery == "" {
		return avatar.String()
	}
	return safeGravatarURL(avatar)
}

func safeGravatarURL(avatar *url.URL) string {
	if avatar == nil || avatar.Scheme != "https" || avatar.Port() != "" || !gravatarHost(avatar.Hostname()) {
		return ""
	}
	const prefix = "/avatar/"
	hash := strings.TrimPrefix(avatar.Path, prefix)
	if !strings.HasPrefix(avatar.Path, prefix) || (len(hash) != 32 && len(hash) != 64) {
		return ""
	}
	for _, char := range hash {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
			return ""
		}
	}
	query, ok := safeGravatarQuery(avatar.RawQuery)
	if !ok {
		return ""
	}
	value := "https://" + strings.ToLower(avatar.Hostname()) + prefix + strings.ToLower(hash)
	if query != "" {
		value += "?" + query
	}
	return value
}

func safeGravatarQuery(raw string) (string, bool) {
	values, err := url.ParseQuery(raw)
	if err != nil {
		return "", false
	}
	out := url.Values{}
	for key, entries := range values {
		if len(entries) != 1 {
			return "", false
		}
		value := entries[0]
		switch key {
		case "d":
			switch strings.ToLower(value) {
			case "404", "blank", "identicon", "mm", "monsterid", "mp", "retro", "robohash", "wavatar":
				out.Set(key, strings.ToLower(value))
			default:
				return "", false
			}
		case "r":
			switch strings.ToLower(value) {
			case "g", "pg", "r", "x":
				out.Set(key, strings.ToLower(value))
			default:
				return "", false
			}
		case "f":
			if strings.ToLower(value) != "y" {
				return "", false
			}
			out.Set(key, "y")
		case "s", "size":
			size, err := strconv.Atoi(value)
			if err != nil || size < 1 || size > 2048 {
				return "", false
			}
			out.Set(key, strconv.Itoa(size))
		default:
			return "", false
		}
	}
	return out.Encode(), true
}

func gravatarHost(host string) bool {
	switch strings.ToLower(strings.TrimSuffix(host, ".")) {
	case "gravatar.com", "www.gravatar.com", "secure.gravatar.com":
		return true
	default:
		return false
	}
}

func parseBaseURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("parse GitLab URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errors.New("GitLab URL must use http or https")
	}
	if parsed.Host == "" {
		return "", errors.New("GitLab URL must include a host")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("GitLab URL must not include credentials, query, or fragment")
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func randomState() (string, error) {
	bytes, err := basecrypto.RandomBytes(32)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
