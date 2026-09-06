package humancontext

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
	"abagile.com/tokyo3/flux/internal/state"
	basesession "github.com/abagile/tokyo3-base/session"
)

func TestHandlerRequiresBrowserSessionCSRFAndConfirmation(t *testing.T) {
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	store, err := state.OpenFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("OpenFileStore() error = %v", err)
	}
	service, err := New(Config{Store: store, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	sessions, err := basesession.New(basesession.Config{
		SessionKey:   bytes.Repeat([]byte{0x42}, 32),
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
	gated := sessions.Gate(handler)

	unauthenticated := httptest.NewRequest(http.MethodPost, "/api/context/plan", bytes.NewBufferString(`{"kind":"delay_explanation"}`))
	unauthenticatedResponse := httptest.NewRecorder()
	gated.ServeHTTP(unauthenticatedResponse, unauthenticated)
	if unauthenticatedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want %d", unauthenticatedResponse.Code, http.StatusUnauthorized)
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
	cookie := loginResponse.Result().Cookies()[0]

	csrfRequest := httptest.NewRequest(http.MethodGet, "/api/context/csrf", nil)
	csrfRequest.AddCookie(cookie)
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

	missingCSRF := httptest.NewRequest(http.MethodPost, "/api/context/plan", bytes.NewBufferString(`{"kind":"delay_explanation"}`))
	missingCSRF.AddCookie(cookie)
	missingCSRFResponse := httptest.NewRecorder()
	gated.ServeHTTP(missingCSRFResponse, missingCSRF)
	if missingCSRFResponse.Code != http.StatusForbidden {
		t.Fatalf("missing CSRF status = %d, want %d", missingCSRFResponse.Code, http.StatusForbidden)
	}

	body := `{"kind":"delay_explanation","statement":"A dependency is pending.","category":"dependency","item_ids":["team/project#12"],"reporting_from":"2026-02-01T00:00:00Z","reporting_until":"2026-02-03T00:00:00Z"}`
	planRequest := httptest.NewRequest(http.MethodPost, "/api/context/plan", bytes.NewBufferString(body))
	planRequest.AddCookie(cookie)
	planRequest.Header.Set("X-CSRF-Token", csrf.Token)
	planResponse := httptest.NewRecorder()
	gated.ServeHTTP(planResponse, planRequest)
	if planResponse.Code != http.StatusOK {
		t.Fatalf("plan status = %d, want %d: %s", planResponse.Code, http.StatusOK, planResponse.Body.String())
	}
	var planned struct {
		Status string `json:"status"`
		Plan   Plan   `json:"plan"`
	}
	if err := json.NewDecoder(planResponse.Body).Decode(&planned); err != nil {
		t.Fatalf("decode plan response: %v", err)
	}
	if planned.Status != "planned" || planned.Plan.ID == "" || planned.Plan.Entry.AuthorSubject != "user-1" {
		t.Fatalf("planned response = %+v", planned)
	}

	confirmBody, err := json.Marshal(confirmRequest{PlanID: planned.Plan.ID, Confirmation: planned.Plan.Confirmation})
	if err != nil {
		t.Fatalf("marshal confirmation: %v", err)
	}
	confirmRequestHTTP := httptest.NewRequest(http.MethodPost, "/api/context/confirm", bytes.NewReader(confirmBody))
	confirmRequestHTTP.AddCookie(cookie)
	confirmRequestHTTP.Header.Set("X-CSRF-Token", csrf.Token)
	confirmResponse := httptest.NewRecorder()
	gated.ServeHTTP(confirmResponse, confirmRequestHTTP)
	if confirmResponse.Code != http.StatusOK {
		t.Fatalf("confirm status = %d, want %d: %s", confirmResponse.Code, http.StatusOK, confirmResponse.Body.String())
	}
	var confirmed struct {
		Status  string              `json:"status"`
		Context domain.HumanContext `json:"context"`
	}
	if err := json.NewDecoder(confirmResponse.Body).Decode(&confirmed); err != nil {
		t.Fatalf("decode confirm response: %v", err)
	}
	if confirmed.Status != "confirmed" || confirmed.Context.ID != planned.Plan.ID {
		t.Fatalf("confirmed response = %+v", confirmed)
	}

	redactBody := `{"context_id":"` + planned.Plan.Entry.ID + `"}`
	redactPlanRequest := httptest.NewRequest(http.MethodPost, "/api/context/redact/plan", bytes.NewBufferString(redactBody))
	redactPlanRequest.AddCookie(cookie)
	redactPlanRequest.Header.Set("X-CSRF-Token", csrf.Token)
	redactPlanResponse := httptest.NewRecorder()
	gated.ServeHTTP(redactPlanResponse, redactPlanRequest)
	if redactPlanResponse.Code != http.StatusOK {
		t.Fatalf("redaction plan status = %d, want %d: %s", redactPlanResponse.Code, http.StatusOK, redactPlanResponse.Body.String())
	}
	var redaction struct {
		Plan Plan `json:"plan"`
	}
	if err := json.NewDecoder(redactPlanResponse.Body).Decode(&redaction); err != nil {
		t.Fatalf("decode redaction plan: %v", err)
	}
	redactConfirmBody, err := json.Marshal(confirmRequest{PlanID: redaction.Plan.ID, Confirmation: redaction.Plan.Confirmation})
	if err != nil {
		t.Fatalf("marshal redaction confirmation: %v", err)
	}
	redactConfirmRequest := httptest.NewRequest(http.MethodPost, "/api/context/redact/confirm", bytes.NewReader(redactConfirmBody))
	redactConfirmRequest.AddCookie(cookie)
	redactConfirmRequest.Header.Set("X-CSRF-Token", csrf.Token)
	redactConfirmResponse := httptest.NewRecorder()
	gated.ServeHTTP(redactConfirmResponse, redactConfirmRequest)
	if redactConfirmResponse.Code != http.StatusOK {
		t.Fatalf("redaction confirm status = %d, want %d: %s", redactConfirmResponse.Code, http.StatusOK, redactConfirmResponse.Body.String())
	}
	entries, err := store.ListContext(state.ContextQuery{Limit: 10})
	if err != nil {
		t.Fatalf("ListContext after redaction error = %v", err)
	}
	if len(entries.Entries) != 0 {
		t.Fatalf("redacted entries = %+v, want none", entries.Entries)
	}
}
