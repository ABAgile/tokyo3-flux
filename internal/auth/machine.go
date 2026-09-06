package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
)

const minimumMachineTokenLength = 32

// MachineToken is a scoped, read-only API credential. Only its digest is kept
// in memory after configuration so the raw token is not retained by the
// request middleware.
type MachineToken struct {
	digest [sha256.Size]byte
}

// NewMachineToken constructs the optional Flux API credential. An empty value
// disables machine access; configured tokens must be long enough for a
// generated secret rather than a human password.
func NewMachineToken(raw string) (*MachineToken, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	if len(raw) < minimumMachineTokenLength {
		return nil, errors.New("flux API token must be at least 32 characters")
	}
	return &MachineToken{digest: sha256.Sum256([]byte(raw))}, nil
}

// Gate permits a valid Bearer token to reach machineHandler and sends all
// requests without a Bearer credential through browserHandler. An invalid
// Bearer credential receives 401 instead of a browser login redirect.
func (t *MachineToken) Gate(machineHandler, browserHandler http.Handler) http.Handler {
	if t == nil {
		return browserHandler
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		credential, present := bearerCredential(r.Header.Get("Authorization"))
		if !present {
			browserHandler.ServeHTTP(w, r)
			return
		}
		if t.matches(credential) {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				w.Header().Set("Allow", "GET, HEAD")
				http.Error(w, "machine credential is read-only", http.StatusMethodNotAllowed)
				return
			}
			machineHandler.ServeHTTP(w, r)
			return
		}
		w.Header().Set("WWW-Authenticate", `Bearer realm="flux-api"`)
		http.Error(w, "invalid API credentials", http.StatusUnauthorized)
	})
}

func (t *MachineToken) matches(value string) bool {
	digest := sha256.Sum256([]byte(value))
	return subtle.ConstantTimeCompare(t.digest[:], digest[:]) == 1
}

func bearerCredential(value string) (string, bool) {
	parts := strings.Fields(value)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		return "", false
	}
	return parts[1], true
}
