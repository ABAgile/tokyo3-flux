# Flux frontend conventions

The planning UI is plain ES modules and CSS under `internal/planningui/static/`, embedded with `go:embed`.
There is no build step and there are no npm runtime dependencies.

## Rules

- Keep the security policy: `script-src 'self'`, `style-src 'self'`; no inline scripts, inline styles or `eval`.
- Only `/`, `/app.js`, `/styles.css` and single-level `/modules/*.js` are served.
- Keep the `/api/v2` JSON contract unchanged; Pi, the CLI and the browser tests depend on it.
- Keep `modules/format.js` at that path and free of imports; `tests/date-format.test.mjs` loads it as a data URL.
- During refactors, move code as-is.
  Rewrites, behavior-changing renames and "while I'm here" fixes go in separate follow-ups.
- UI work follows `DESIGN.md`.

## Checks

- After editing JS or CSS, run `make fmt-web lint-web`, then `make test-web`.
- After editing Markdown, run `make fmt-md`.
- Before handing off, run `make check-web test-web`.
- Any Go change (for example `web.go`) needs `make check` with `FLUX_TEST_DATABASE_URL` set to a disposable database.
- Browser scripts in `tests/*.browser.js` run through Playwright `run-code` against disposable, seeded workspaces only.
  `tests/style-snapshot.browser.js` returns a JSON style snapshot; save it outside the repository and diff two runs made on the same day.
- Tool versions are pinned in the `Makefile` (`BIOME_VERSION`, `RUMDL_VERSION`) and in CI.
  Set `BIOME=biome` or `RUMDL=rumdl` to use installed binaries.
