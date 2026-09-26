# Flux frontend conventions

The planning UI is plain ES modules and CSS under `internal/planningui/static/`, embedded with `go:embed`.
There is no application build step or runtime package installation.
Preact and HTM are vendored in `modules/vendor-preact.js`; all dynamic views, widgets and dialog markup render Preact VNodes.
The body is owned by the Preact `App` root in `modules/app-shell.js`; shared shell state and domain/session command controllers remain plain ES modules.
Stateful UI widgets and shell chrome are Preact function components.

## Rendering with Preact

- Import the runtime only through `modules/preact.js`; use HTM templates, not JSX or raw HTML injection.
- `tools/vendor/package-lock.json` pins the runtime and bundler; `make vendor-web` rebuilds the checked-in bundle.
  Never edit the generated bundle by hand; preserve the licenses in `tools/vendor/`.
- Components receive data and actions as props; domain/session state and revision-checked commands remain in the existing controllers.
  Template factories are pure VNode builders; never put a DOM node inside an HTM expression.
- Each render root owns its host's children exclusively; the handwritten reconciler has been removed.
  Use `replaceContent(host, ...)` when replacing a static host's content and `unmountIsland(host)` before removing a render root.
  `mount(host, template)` starts a fresh form lifetime and returns an update function that ignores stale updates after replacement.
- Stateful widgets are function components.
  Keep local interaction state in Preact hooks, pass domain data and actions as props, and use stable domain keys when an identity change needs a fresh lifetime.
  Shared UI reads use a selector and state changes use `setState`; keep each selector focused on the values the component renders.
  Replace top-level values for nested updates; do not mutate selected arrays, maps or sets in place.

  ```js
  const board = useStore((current) => current.board);
  setState({ view: 'sprints' });
  ```

  Use `useReducer` for related state transitions; do not mirror reducer state in refs to work around stale closures.

  ```js
  const [state, dispatch] = useReducer(reducer, initialState);
  dispatch({ type: 'loaded', data });
  ```

  Effects own outside listeners, subscriptions, animation frames and observers; every acquired resource needs cleanup.
  Keep native form drafts uncontrolled unless the UI genuinely owns their changing value.
- Async effects use `useRequest`; include every identity that should restart work, especially workspace root, in its dependency list.
  It supplies an `AbortSignal`, keeps prior data while reloading, and suppresses results after abort.
  `api(path, { signal })` forwards cancellation to `fetch`.

  ```js
  const result = useRequest((signal) => api(`/api/v2/items/${id}`, { signal }), [root, id]);
  ```

- Open popovers and menus use `useDismiss(ref, open, onDismiss)` instead of module-level document listeners.

  ```js
  const ref = useRef(null);
  useDismiss(ref, open, onClose);
  ```

- `attach(setup, ...args)` is only for one-time, element-local wiring such as board/list drag handlers or chip decoration; handlers must read current data by stable ID at event time.
  Use component effects for external resources, never `attach`.
- Native text fields are uncontrolled (`defaultValue`) unless their value is owned by reactive state, such as project search.
  Keep user edits intact across unrelated renders.
  `syncDisabled` synchronizes controls also written by `renderControls`; one writer per attribute remains the goal.
- Use Preact style objects for dynamic colors and CSS variables; Preact applies these through CSSOM, which preserves the existing CSP.
  Never pass a style string or use `dangerouslySetInnerHTML`.
- `nodeOf` is restricted to rendered-once shell nodes/form skeletons; dispose it before removing its host.
  Board/List updates always render VNodes, including observation icons.
  Keys preserve identity within a parent; cross-column card moves also restore logical focus and open attachment disclosures.
- Use stable domain keys for lists, and hook effects with cleanup for lifecycle work.
  Do not add module-level listeners or timers.
- Rendered-once workspace and integration forms keep their submission controller's ownership of input values, busy flags and status lines.
  Do not add competing reactive bindings without migrating that controller too.
- No CSS, API or CSP changes are part of the migration; never introduce inline styles, scripts or `eval`.
- `tests/preact-fixture.mjs` serves an API-free fixture for `tests/preact.browser.js`; it requires no database and must bind only to a private test interface.

## Rules

- Keep the security policy: `script-src 'self'`, `style-src 'self'`; no inline scripts, inline styles or `eval`.
- Only `/`, `/app.js`, `/styles.css` and single-level `/modules/*.js` are served.
- Keep the `/api/v2` JSON contract unchanged; Pi, the CLI and the browser tests depend on it.
- Keep `modules/format.js` at that path and free of imports; `tests/date-format.test.mjs` loads it as a data URL.
- During refactors, move code as-is.
  Rewrites, behavior-changing renames and "while I'm here" fixes go in separate follow-ups.
- For UI work, read `DESIGN.md` (tokens and global rules), then only the `docs/design/` area files for the modules you change; its area table maps each area to its modules and CSS files.
  Move design text as-is when reorganizing it; rule changes are separate edits.

## Module map

Modules live flat in `static/modules/`; the rank order below is the import direction.
A module imports only modules above it; calls further down the list go through `modules/hooks.js`, which `app.js` fills at startup.
No module imports `app.js`, and Biome's `noImportCycles` rule enforces an acyclic graph.
Feature modules export functions and constants; any document listeners or timers sit in an `init*()`/`start*()` function that `app.js` calls.

| Layer | Modules |
|---|---|
| Base | `vendor-preact`, `preact`, `store`, `ui-hooks`, `gate-components`, `dom`, `api`, `format`, `markdown`, `layout`, `item-command` |
| State | `state` (every reassigned shell variable, as `state.<name>`), `hooks` |
| Services | `permissions`, `notices`, `items`, `controls`, `people`, `multi-select`, `due-dates`, `gitlab-catalog`, `mount`, `filters`, `view-burndown`, `commands`, `item-attachments`, `dialog`, `drag`, `gitlab`, `item-comments`, `url-state` |
| Item | `item-links`, `item-editor`, `item-detail` |
| Views | `view-board`, `view-archive`, `bulk`, `view-list`, `view-velocity`, `view-sprints`, `view-integration`, `view-projects`, `view-labels`, `view-members`, `view-proposals`, `view-history`, `shortcuts`, `view-gate`, `sync` |
| Shell | `app-shell`: body-level `App`, page frame and native dialog markup; `app.js`: imports, hooks, `render`/`renderPageRoot`/`renderContent`, controller wiring and startup |

## CSS file map

`static/styles/NNN-*.css` are joined in name order into `/styles.css`; order is cascade order, so moving a rule can change which rule wins.
Insert new files in the numbering gaps and compare the style snapshot after any move.
Each file holds one feature, including its media queries; a feature's responsive rules sit at the end of its own file unless the cascade needs them later (`106-list-responsive` follows `104-item-detail`).

| JS module | CSS files |
|---|---|
| `app-shell`, `app.js`, `mount`, `layout` | `010-tokens`, `020-base`, `030-shell` (sidebar, notices, section heads, page stack, empty state, skip link), `130-motion` |
| `view-sprints` | `031-panels` (panels, sprint panel, metrics), `210-sprint-goal` |
| `view-board`, `drag` | `032-board` (columns, cards, drag cursors, drop marks), `036-summaries` (project lens) |
| `view-gate` | `033-workspace-gate` (workspace choice and first run) |
| `item-comments` | `034-comments` |
| `markdown` | `035-markdown` |
| `view-archive`, `view-history` | `037-archive-history` |
| `dialog` | `040-dialog` (dialog chrome, form grid, help and error lines) |
| `view-projects`, `view-members`, `view-labels` | `045-maintenance` (maintenance rows, member roles, label palette, integration chips) |
| `multi-select`, `view-integration` | `050-forms` (consent, multi-select, help popovers) |
| `view-proposals` | `055-proposals` |
| `item-editor` | `060-item-editor` (layout, head, status summary), `220-dates` |
| `view-burndown` | `070-burndown` |
| `gitlab`, `item-links` | `090-gitlab` (MR paste row, observation icons) |
| `filters` | `100-filters` (filter bar, presentation toggle, chips) |
| `view-list` | `102-list`, `106-list-responsive` |
| `item-detail` | `104-item-detail` |
| `item-attachments` | `108-attachments` (tiles, tooltip, progress, drop targets) |
| `permissions` | `110-action-icons` |
| `bulk` | `120-bulk` |
| `view-velocity` | `160-velocity` |
| `shortcuts` | `180-shortcuts` |
| `url-state` | `190-card-link` |
| `people` | `200-participants` (avatars, assignee, participant stacks) |
| `due-dates` | `220-dates` (due badges, overdue marks) |

## Checks

- After editing JS or CSS, run `make fmt-web lint-web`, then `make test-web`.
- After editing Markdown, run `make fmt-md`.
- Before handing off, run `make check-web test-web`.
- Any Go change (for example `web.go`) needs `make check` with `FLUX_TEST_DATABASE_URL` set to a disposable database.
- Browser scripts in `tests/*.browser.js` run through Playwright `run-code` against disposable, seeded workspaces only.
  `tests/style-snapshot.browser.js` returns a JSON style snapshot; save it outside the repository and diff two runs made on the same day.
  `tests/rendering.browser.js` checks root ownership and cross-column focus/disclosure preservation.
  `tests/board-perf.browser.js` measures synthetic 100/500/1000-card boards; compare runs on the same browser host only.
- Tool versions are pinned in the `Makefile` (`BIOME_VERSION`, `RUMDL_VERSION`) and in CI.
  Set `BIOME=biome` or `RUMDL=rumdl` to use installed binaries.
