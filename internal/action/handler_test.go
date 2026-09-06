package action

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"abagile.com/tokyo3/flux/internal/gitlab"
	basesession "github.com/abagile/tokyo3-base/session"
)

func TestHandlerPlansAndConfirmsWithBrowserSessionAndCSRF(t *testing.T) {
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	client := &fakeIssueClient{issues: []gitlab.Issue{testIssue(now), testIssue(now), testIssue(now)}}
	audit := &fakeAudit{}
	triggered := 0
	service := testService(t, client, audit, &triggered, now)
	sessions, err := basesession.New(basesession.Config{
		SessionKey:   bytes.Repeat([]byte{0x11}, 32),
		CookiePrefix: "flux",
		SessionTTL:   time.Hour,
		Now: func() time.Time {
			return now
		},
	})
	if err != nil {
		t.Fatalf("session.New() error = %v", err)
	}
	handler, err := NewHandler(service, sessions)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	gated := sessions.Gate(handler)

	request := httptest.NewRequest(http.MethodPost, "/api/actions/labels/plan", bytes.NewBufferString(`{"item_id":"team/platform/service#12","label":"reviewed"}`))
	response := httptest.NewRecorder()
	gated.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated plan status = %d, want %d", response.Code, http.StatusUnauthorized)
	}

	loginRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	loginResponse := httptest.NewRecorder()
	sess, err := sessions.NewSession()
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
	sess.Subject = "user-1"
	sess.Name = "Alex"
	if err := sessions.IssueSession(loginResponse, loginRequest, sess); err != nil {
		t.Fatalf("IssueSession() error = %v", err)
	}
	cookies := loginResponse.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("session cookies = %d, want one", len(cookies))
	}

	csrfRequest := httptest.NewRequest(http.MethodGet, "/api/actions/csrf", nil)
	csrfRequest.AddCookie(cookies[0])
	csrfResponse := httptest.NewRecorder()
	gated.ServeHTTP(csrfResponse, csrfRequest)
	if csrfResponse.Code != http.StatusOK {
		t.Fatalf("CSRF status = %d, want %d", csrfResponse.Code, http.StatusOK)
	}
	var csrf struct {
		Token string `json:"csrf_token"`
	}
	if err := json.NewDecoder(csrfResponse.Body).Decode(&csrf); err != nil {
		t.Fatalf("decode CSRF response: %v", err)
	}
	if csrf.Token == "" {
		t.Fatal("CSRF token is empty")
	}

	labelsRequest := httptest.NewRequest(http.MethodGet, "/api/actions/labels?item_id=team%2Fplatform%2Fservice%2312", nil)
	labelsRequest.AddCookie(cookies[0])
	labelsResponse := httptest.NewRecorder()
	gated.ServeHTTP(labelsResponse, labelsRequest)
	if labelsResponse.Code != http.StatusOK {
		t.Fatalf("labels status = %d, want %d: %s", labelsResponse.Code, http.StatusOK, labelsResponse.Body.String())
	}
	var available struct {
		Labels []string `json:"labels"`
	}
	if err := json.NewDecoder(labelsResponse.Body).Decode(&available); err != nil {
		t.Fatalf("decode labels response: %v", err)
	}
	if len(available.Labels) == 0 || available.Labels[0] != "reviewed" {
		t.Fatalf("available labels = %v, want reviewed first", available.Labels)
	}

	planRequest := httptest.NewRequest(http.MethodPost, "/api/actions/labels/plan", bytes.NewBufferString(`{"item_id":"team/platform/service#12","label":"reviewed"}`))
	planRequest.AddCookie(cookies[0])
	planRequest.Header.Set("X-CSRF-Token", csrf.Token)
	planResponse := httptest.NewRecorder()
	gated.ServeHTTP(planResponse, planRequest)
	if planResponse.Code != http.StatusOK {
		t.Fatalf("plan status = %d, want %d: %s", planResponse.Code, http.StatusOK, planResponse.Body.String())
	}
	var planned struct {
		Status string    `json:"status"`
		Plan   LabelPlan `json:"plan"`
	}
	if err := json.NewDecoder(planResponse.Body).Decode(&planned); err != nil {
		t.Fatalf("decode plan response: %v", err)
	}
	if planned.Status != "planned" || planned.Plan.ID == "" {
		t.Fatalf("planned response = %+v", planned)
	}

	confirmBody, err := json.Marshal(addLabelConfirmRequest{PlanID: planned.Plan.ID, Confirmation: planned.Plan.Confirmation})
	if err != nil {
		t.Fatalf("marshal confirmation: %v", err)
	}
	confirmRequest := httptest.NewRequest(http.MethodPost, "/api/actions/labels/confirm", bytes.NewReader(confirmBody))
	confirmRequest.AddCookie(cookies[0])
	confirmRequest.Header.Set("X-CSRF-Token", csrf.Token)
	confirmResponse := httptest.NewRecorder()
	gated.ServeHTTP(confirmResponse, confirmRequest)
	if confirmResponse.Code != http.StatusOK {
		t.Fatalf("confirm status = %d, want %d: %s", confirmResponse.Code, http.StatusOK, confirmResponse.Body.String())
	}
	if client.writeCalls != 1 || client.writeLabel != "reviewed" || triggered != 1 {
		t.Fatalf("mutation = writes %d label %q triggers %d", client.writeCalls, client.writeLabel, triggered)
	}

	service.writer = nil
	statusRequest := httptest.NewRequest(http.MethodGet, "/api/actions/status", nil)
	statusRequest.AddCookie(cookies[0])
	statusResponse := httptest.NewRecorder()
	gated.ServeHTTP(statusResponse, statusRequest)
	if statusResponse.Code != http.StatusOK {
		t.Fatalf("disabled status = %d, want %d", statusResponse.Code, http.StatusOK)
	}
	var actionStatus struct {
		Enabled bool   `json:"mutation_enabled"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(statusResponse.Body).Decode(&actionStatus); err != nil {
		t.Fatalf("decode disabled status: %v", err)
	}
	if actionStatus.Enabled || actionStatus.Message != "GitLab mutations disabled: FLUX_GITLAB_WRITE_TOKEN is not configured." {
		t.Fatalf("disabled action status = %+v", actionStatus)
	}

	disabledPlanRequest := httptest.NewRequest(http.MethodPost, "/api/actions/labels/plan", bytes.NewBufferString(`{"item_id":"team/platform/service#12","label":"reviewed"}`))
	disabledPlanRequest.AddCookie(cookies[0])
	disabledPlanRequest.Header.Set("X-CSRF-Token", csrf.Token)
	disabledPlanResponse := httptest.NewRecorder()
	gated.ServeHTTP(disabledPlanResponse, disabledPlanRequest)
	if disabledPlanResponse.Code != http.StatusServiceUnavailable || !bytes.Contains(disabledPlanResponse.Body.Bytes(), []byte(mutationDisabledMessage)) {
		t.Fatalf("disabled plan response = %d %s", disabledPlanResponse.Code, disabledPlanResponse.Body.String())
	}
}

func TestHandlerRejectsMissingCSRF(t *testing.T) {
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	client := &fakeIssueClient{issues: []gitlab.Issue{testIssue(now)}}
	service := testService(t, client, &fakeAudit{}, new(int), now)
	sessions, err := basesession.New(basesession.Config{
		SessionKey:   bytes.Repeat([]byte{0x22}, 32),
		CookiePrefix: "flux",
		SessionTTL:   time.Hour,
		Now:          func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("session.New() error = %v", err)
	}
	handler, err := NewHandler(service, sessions)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}

	loginRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	loginResponse := httptest.NewRecorder()
	sess, _ := sessions.NewSession()
	sess.Subject = "user-1"
	if err := sessions.IssueSession(loginResponse, loginRequest, sess); err != nil {
		t.Fatalf("IssueSession() error = %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/actions/labels/plan", bytes.NewBufferString(`{"item_id":"team/platform/service#12","label":"reviewed"}`))
	request.AddCookie(loginResponse.Result().Cookies()[0])
	response := httptest.NewRecorder()
	sessions.Gate(handler).ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("missing CSRF status = %d, want %d", response.Code, http.StatusForbidden)
	}
}
