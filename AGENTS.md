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

## Module map

Modules live flat in `static/modules/`; the rank order below is the import direction.
A module imports only modules above it; calls further down the list go through `modules/hooks.js`, which `app.js` fills at startup.
No module imports `app.js`, and Biome's `noImportCycles` rule enforces an acyclic graph.
Feature modules export functions and constants only; any document listeners or timers sit in an `init*()`/`start*()` function that `app.js` calls.

| Layer | Modules |
|---|---|
| Base | `dom`, `api`, `format`, `markdown`, `layout`, `item-command` |
| State | `state` (every reassigned shell variable, as `state.<name>`), `hooks` |
| Services | `permissions`, `notices`, `items`, `controls`, `people`, `reconcile`, `multi-select`, `due-dates`, `gitlab-catalog`, `mount`, `filters`, `view-burndown`, `commands`, `item-attachments`, `dialog`, `drag`, `gitlab`, `item-comments`, `url-state` |
| Item | `item-links`, `item-editor`, `item-detail` |
| Views | `view-board`, `view-archive`, `bulk`, `view-list`, `view-velocity`, `view-sprints`, `view-integration`, `view-projects`, `view-labels`, `view-members`, `view-proposals`, `view-history`, `shortcuts`, `view-gate`, `sync` |
| Shell | `app.js`: imports, hooks, `render`/`renderPageRoot`/`renderContent`, event wiring and startup |

## CSS file map

`static/styles/NNN-*.css` are joined in name order into `/styles.css`; order is cascade order, so moving a rule can change which rule wins.
Insert new files in the numbering gaps and compare the style snapshot after any move.

| JS module | CSS files |
|---|---|
| `app.js`, `mount` | `010-tokens`, `020-base`, `030-shell`, `031-panels`, `036-summaries`, `130-motion` |
| `view-board`, `drag` | `032-board` |
| `view-gate` | `033-workspace-gate`, `150-first-run` |
| `item-comments` | `034-comments` |
| `markdown` | `035-markdown` |
| `dialog`, `item-editor`, `multi-select` | `040-dialog`, `050-forms`, `060-item-editor`, `220-dates` |
| `view-burndown` | `070-burndown` |
| `item-attachments` | `080-attachments`, `170-attachment-progress` |
| `gitlab` | `090-observations` |
| `filters`, `view-list` | `100-filter-list`, `106-list-responsive`, `140-filter-chips` |
| `item-detail` | `104-item-detail` |
| `permissions` | `110-action-icons` |
| `bulk` | `120-bulk` |
| `view-velocity` | `160-velocity` |
| `shortcuts` | `180-shortcuts` |
| `url-state` | `190-card-link` |
| `people` | `200-participants` |
| `view-sprints` | `210-sprint-goal` |

Several files still mix features (for example maintenance rows in `040-dialog.css`); consolidate them only with an unchanged style snapshot.

## Checks

- After editing JS or CSS, run `make fmt-web lint-web`, then `make test-web`.
- After editing Markdown, run `make fmt-md`.
- Before handing off, run `make check-web test-web`.
- Any Go change (for example `web.go`) needs `make check` with `FLUX_TEST_DATABASE_URL` set to a disposable database.
- Browser scripts in `tests/*.browser.js` run through Playwright `run-code` against disposable, seeded workspaces only.
  `tests/style-snapshot.browser.js` returns a JSON style snapshot; save it outside the repository and diff two runs made on the same day.
- Tool versions are pinned in the `Makefile` (`BIOME_VERSION`, `RUMDL_VERSION`) and in CI.
  Set `BIOME=biome` or `RUMDL=rumdl` to use installed binaries.
