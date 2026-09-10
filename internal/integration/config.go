package integration

import (
	"errors"
	"os"
	"strings"
	"time"

	"github.com/abagile/tokyo3-base/envutil"
)

type Settings struct {
	Client        *Client
	Interval      time.Duration
	WebhookSecret string
}

// FromEnv shares the OAuth instance URL and uses a server-only read credential.
// No service token means no connector, even when OAuth has an instance URL.
func FromEnv() (Settings, error) {
	var out Settings
	token := os.Getenv("FLUX_GITLAB_SERVICE_TOKEN")
	var raw string
	if token != "" {
		raw = os.Getenv("FLUX_GITLAB_URL")
	}
	var err error
	if out.Client, err = New(raw, token); err != nil {
		return out, err
	}
	interval, err := envutil.Duration("FLUX_GITLAB_REFRESH_INTERVAL")
	if err != nil {
		return out, errors.New("FLUX_GITLAB_REFRESH_INTERVAL must be a duration")
	}
	if strings.TrimSpace(os.Getenv("FLUX_GITLAB_REFRESH_INTERVAL")) == "" {
		interval = time.Minute
	}
	if interval != 0 && (interval < 30*time.Second || interval > time.Hour) {
		return out, errors.New("FLUX_GITLAB_REFRESH_INTERVAL must be 0 or between 30s and 1h")
	}
	if out.Client != nil {
		out.Interval = interval
	}
	out.WebhookSecret = os.Getenv("FLUX_GITLAB_WEBHOOK_SECRET")
	if out.WebhookSecret != "" && (len(out.WebhookSecret) < 32 || strings.TrimSpace(out.WebhookSecret) == "" || strings.ContainsAny(out.WebhookSecret, "\r\n") || out.Client == nil || out.Interval == 0) {
		return out, errors.New("native GitLab webhooks require a read connector, automatic refresh and a secret of at least 32 characters")
	}
	return out, nil
}
