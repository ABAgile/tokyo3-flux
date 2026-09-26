# Flux frontend conventions

The planning UI is plain ES modules and CSS under `internal/planningui/static/`, embedded with `go:embed`.
There is no build step and there are no npm runtime dependencies.
The one browser library, lit-html, is vendored as `modules/vendor-lit-html.js`; see [Rendering with lit-html](#rendering-with-lit-html).

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
Feature modules export functions and constants only; any document listeners or timers sit in an `init*()`/`start*()` function that `app.js` calls.

| Layer | Modules |
|---|---|
| Base | `vendor-lit-html`, `lit`, `dom`, `api`, `format`, `markdown`, `layout`, `item-command` |
| State | `state` (every reassigned shell variable, as `state.<name>`), `hooks` |
| Services | `permissions`, `notices`, `items`, `controls`, `people`, `reconcile`, `multi-select`, `due-dates`, `gitlab-catalog`, `mount`, `filters`, `view-burndown`, `commands`, `item-attachments`, `dialog`, `drag`, `gitlab`, `item-comments`, `url-state` |
| Item | `item-links`, `item-editor`, `item-detail` |
| Views | `view-board`, `view-archive`, `bulk`, `view-list`, `view-velocity`, `view-sprints`, `view-integration`, `view-projects`, `view-labels`, `view-members`, `view-proposals`, `view-history`, `shortcuts`, `view-gate`, `sync` |
| Shell | `app.js`: imports, hooks, `render`/`renderPageRoot`/`renderContent`, event wiring and startup |

## Rendering with lit-html

Board cards, columns and the Archive list are lit-html templates; every other view still builds nodes with `dom.js` and patches them with `reconcile.js`.

- Import lit only from `modules/lit.js`, never from `vendor-lit-html.js`.
  `vendor-lit-html.js` is generated: change the pinned version or `tools/vendor/lit-html.entry.js` and run `make vendor-web`; never edit the bundle by hand.
- A template describes the whole component on every render; lit updates only what changed, so focus, hover and open `<details>` survive.
  Key lists with `repeat(items, (item) => item.id, template)`.
- Never bind a `style` attribute or use lit's `styleMap`: its first render writes the attribute, which `style-src 'self'` blocks.
  Use `styleProps({ 'background-color': value })`, which sets properties through the CSSOM.
- One owner per attribute.
  A template binds an attribute, property or class only if no other code writes it: `renderControls` owns `disabled` on `[data-write]` controls and `draggable`; drag, file-drop and tooltip code own their classes, `aria-describedby` and tooltip positions.
  Use `classMap` for classes, since it leaves classes added by other code alone.
- Code outside a template never moves, removes or re-texts nodes a template created; it re-renders instead (`hooks.renderContent()`).
  `refreshDueDateBadges` and `patchObservationUI` skip `.card` descendants for this reason.
- Wire imperative behaviour (drag, drop, file drops) with `attach(setup, ...args)`: it runs once per element, so pass stable ids and read changing data from `state` at event time.
- Leaf helpers shared with imperative views have a `*Template` form; the node form wraps it with `nodeOf`/`nodesOf`, and the nodes it returns are plain DOM that callers may mutate.
- Split static and dynamic text only with care: text split across nodes can shape a fraction of a pixel differently, so bind one string where exact width matters (`` ${`${count} shown`} ``).

## CSS file map

`static/styles/NNN-*.css` are joined in name order into `/styles.css`; order is cascade order, so moving a rule can change which rule wins.
Insert new files in the numbering gaps and compare the style snapshot after any move.
Each file holds one feature, including its media queries; a feature's responsive rules sit at the end of its own file unless the cascade needs them later (`106-list-responsive` follows `104-item-detail`).

| JS module | CSS files |
|---|---|
| `app.js`, `mount`, `layout` | `010-tokens`, `020-base`, `030-shell` (sidebar, notices, section heads, page stack, empty state, skip link), `130-motion` |
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
  `tests/board-perf.browser.js` times board renders on synthetic boards of 100, 500 and 1000 cards; compare runs on one machine only.
- Tool versions are pinned in the `Makefile` (`BIOME_VERSION`, `RUMDL_VERSION`, `LIT_HTML_VERSION`, `ESBUILD_VERSION`) and in CI.
  Set `BIOME=biome` or `RUMDL=rumdl` to use installed binaries.
