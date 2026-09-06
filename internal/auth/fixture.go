package auth

import (
	"errors"
	"net/http"

	"github.com/abagile/tokyo3-base/session"
)

// NewFixture returns a local-only login handler for fixture mode. It creates a
// clearly synthetic identity and must only be exposed on a loopback listener.
func NewFixture(sessions *session.Manager) (http.Handler, error) {
	if sessions == nil {
		return nil, errors.New("fixture auth session manager is required")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /auth/login", func(w http.ResponseWriter, r *http.Request) {
		fixtureLogin(w, r, sessions)
	})
	mux.Handle("GET /auth/logout", sessions.LogoutHandler())
	return mux, nil
}

func fixtureLogin(w http.ResponseWriter, r *http.Request, sessions *session.Manager) {
	sess, err := sessions.NewSession()
	if err != nil {
		http.Error(w, "fixture session initialization failed", http.StatusInternalServerError)
		return
	}
	sess.Subject = "fixture-user"
	sess.Name = "Local fixture user"
	if err := sessions.IssueSession(w, r, sess); err != nil {
		http.Error(w, "fixture session initialization failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, sessions.SafeReturnTo(r.URL.Query().Get("return_to")), http.StatusSeeOther)
}
