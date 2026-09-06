package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMachineTokenGate(t *testing.T) {
	const token = "0123456789abcdef0123456789abcdef"
	machineToken, err := NewMachineToken(token)
	if err != nil {
		t.Fatalf("NewMachineToken() error = %v", err)
	}
	machine := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	browser := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	handler := machineToken.Gate(machine, browser)

	tests := []struct {
		name       string
		authorize  string
		wantStatus int
		wantHeader string
	}{
		{name: "valid token", authorize: "Bearer " + token, wantStatus: http.StatusNoContent},
		{name: "case insensitive scheme", authorize: "bearer " + token, wantStatus: http.StatusNoContent},
		{name: "browser session fallback", wantStatus: http.StatusTeapot},
		{name: "invalid token", authorize: "Bearer wrong-token", wantStatus: http.StatusUnauthorized, wantHeader: `Bearer realm="flux-api"`},
		{name: "write rejected", authorize: "Bearer " + token, wantStatus: http.StatusMethodNotAllowed},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			method := http.MethodGet
			if test.name == "write rejected" {
				method = http.MethodPost
			}
			request := httptest.NewRequest(method, "/api/today", nil)
			if test.authorize != "" {
				request.Header.Set("Authorization", test.authorize)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d", response.Code, test.wantStatus)
			}
			if got := response.Header().Get("WWW-Authenticate"); got != test.wantHeader {
				t.Fatalf("WWW-Authenticate = %q, want %q", got, test.wantHeader)
			}
		})
	}
}

func TestNewMachineTokenValidation(t *testing.T) {
	if token, err := NewMachineToken(""); err != nil || token != nil {
		t.Fatalf("empty token = %#v, %v; want nil, nil", token, err)
	}
	if _, err := NewMachineToken(strings.Repeat("x", minimumMachineTokenLength-1)); err == nil {
		t.Fatal("short token error = nil")
	}
	if token, err := NewMachineToken(strings.Repeat("x", minimumMachineTokenLength)); err != nil || token == nil {
		t.Fatalf("minimum token = %#v, %v; want configured token", token, err)
	}
}
