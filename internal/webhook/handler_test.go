package webhook

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestHandlerAcceptsAuthenticatedGroupEventTriggers(t *testing.T) {
	var triggered atomic.Int32
	var received Event
	handler, err := New(Config{
		Secret:        "webhook-secret",
		ExpectedGroup: "team/platform",
		Trigger:       func() { triggered.Add(1) },
		OnEvent:       func(event Event) error { received = event; return nil },
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodPost, "/webhooks/gitlab", strings.NewReader(`{"group":{"id":77,"full_path":"team/platform"},"project":{"id":42,"path_with_namespace":"team/platform/service"}}`))
	request.Header.Set("X-Gitlab-Token", "webhook-secret")
	request.Header.Set("X-Gitlab-Event", "Issue Hook")
	request.Header.Set("X-Gitlab-Webhook-UUID", "delivery-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if got, want := response.Code, http.StatusAccepted; got != want {
		t.Fatalf("status = %d, want %d", got, want)
	}
	if got := triggered.Load(); got != 1 {
		t.Fatalf("trigger count = %d, want 1", got)
	}
	if received.Kind != "Issue Hook" || received.ProjectID != 42 || received.ProjectPath != "team/platform/service" || received.GroupID != 77 || received.GroupPath != "team/platform" || received.DeliveryID != "delivery-1" {
		t.Fatalf("received event = %+v, want group and delivery metadata", received)
	}
}

func TestHandlerAcceptsAuthenticatedGroupEvent(t *testing.T) {
	var received Event
	handler, err := New(Config{
		Secret:        "webhook-secret",
		ExpectedGroup: "team/platform",
		Trigger:       func() {},
		OnEvent:       func(event Event) error { received = event; return nil },
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodPost, "/webhooks/gitlab", strings.NewReader(`{"group":{"id":77,"full_path":"team/platform"},"project":{"id":42,"path_with_namespace":"team/platform/service"}}`))
	request.Header.Set("X-Gitlab-Token", "webhook-secret")
	request.Header.Set("X-Gitlab-Event", "Pipeline Hook")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if got, want := response.Code, http.StatusAccepted; got != want {
		t.Fatalf("status = %d, want %d", got, want)
	}
	if received.GroupID != 77 || received.GroupPath != "team/platform" {
		t.Fatalf("received event = %+v, want group metadata", received)
	}
}

func TestHandlerRejectsGroupMismatch(t *testing.T) {
	handler, err := New(Config{
		Secret:        "webhook-secret",
		ExpectedGroup: "team/platform",
		Trigger:       func() {},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodPost, "/webhooks/gitlab", strings.NewReader(`{"group":{"id":88,"full_path":"other"},"project":{"id":42,"path_with_namespace":"other/service"}}`))
	request.Header.Set("X-Gitlab-Token", "webhook-secret")
	request.Header.Set("X-Gitlab-Event", "Pipeline Hook")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if got, want := response.Code, http.StatusForbidden; got != want {
		t.Fatalf("status = %d, want %d", got, want)
	}
}

func TestHandlerRejectsInvalidRequests(t *testing.T) {
	handler, err := New(Config{
		Secret:        "webhook-secret",
		ExpectedGroup: "team/platform",
		Trigger:       func() {},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	tests := []struct {
		name   string
		method string
		token  string
		body   string
		status int
	}{
		{name: "wrong method", method: http.MethodGet, token: "webhook-secret", body: `{}`, status: http.StatusMethodNotAllowed},
		{name: "wrong token", method: http.MethodPost, token: "wrong", body: `{}`, status: http.StatusUnauthorized},
		{name: "bad JSON", method: http.MethodPost, token: "webhook-secret", body: `{`, status: http.StatusBadRequest},
		{name: "wrong group", method: http.MethodPost, token: "webhook-secret", body: `{"project":{"id":99,"path_with_namespace":"other/service"}}`, status: http.StatusForbidden},
		{name: "missing event", method: http.MethodPost, token: "webhook-secret", body: `{"project":{"id":42,"path_with_namespace":"team/platform/service"}}`, status: http.StatusBadRequest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, "/webhooks/gitlab", strings.NewReader(test.body))
			request.Header.Set("X-Gitlab-Token", test.token)
			if test.name != "missing event" {
				request.Header.Set("X-Gitlab-Event", "Pipeline Hook")
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if got := response.Code; got != test.status {
				t.Fatalf("status = %d, want %d", got, test.status)
			}
		})
	}
}

func TestHandlerRejectsOversizedPayload(t *testing.T) {
	handler, err := New(Config{Secret: "secret", Trigger: func() {}, MaxBodyBytes: 4})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, "/webhooks/gitlab", strings.NewReader(`{"x":1}`))
	request.Header.Set("X-Gitlab-Token", "secret")
	request.Header.Set("X-Gitlab-Event", "Issue Hook")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusRequestEntityTooLarge)
	}
}
