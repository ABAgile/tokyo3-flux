# Flux frontend conventions

The planning UI is plain ES modules and CSS under `internal/planningui/static/`, embedded with `go:embed`.
There is no application build step or runtime package installation.
Preact and HTM are vendored in `modules/vendor-preact.js`; all dynamic views, widgets and dialog markup render Preact VNodes.
One Preact `App` in `modules/app-shell.js` renders the whole body once; every change after that is a store update.
UI state lives in one store (`modules/state.js`), changes go through named actions (`modules/actions.js`), and components subscribe to what they read.

## Rendering with Preact

- Import Preact runtime APIs directly from `modules/vendor-preact.js`; `modules/vdom.js` binds HTM's `html` tag to Preact's `h` and provides `memo` and `shallowEqual`.
  Use HTM templates, not JSX or raw HTML injection.
- `tools/vendor/package-lock.json` pins the runtime and bundler; `make vendor-web` rebuilds the checked-in bundle.
  Never edit the generated bundle by hand; preserve the licenses in `tools/vendor/`.
- One update path: components read with `useStore(selector)` and change state through actions that make one `setState` patch.
  `state` is a read-only view for handlers and controllers; writing to it throws.
  Keep each selector to the values the component renders, and pass an equality function when it returns an object.

  ```js
  const view = useStore((current) => current.view);
  export function setPresentation(next) {
    setState({ presentation: next, bulkSelection: new Set() });
  }
  ```

- Replace values, never mutate them: arrays, maps, sets and board entities get new objects.
  The store holds data only — no DOM nodes, functions or timers; those live in component refs or module variables.

  ```js
  setState((current) => ({ burndownExpanded: toggled(current.burndownExpanded, id) }));
  ```

- Component-owned reads use `useRequest`; list every identity that restarts the work, especially the workspace root.
  Writes use `useMutation`, which refuses a second submission and aborts on unmount; `api` and `apiUpload` forward `signal`.
  Key request-owning components by workspace root and record so a switch remounts them.

  ```js
  const page = useRequest((signal) => api(`${root}/items/${id}/comments`, { signal }), [root, id]);
  ```

- Dialogs are data: `openDialog(type, props)` stores `{ type, props }`, and the App's `DIALOGS` map names the component.
  Props are the snapshot captured at opening; opening a dialog replaces the current one.
  Dialog components render `FormDialog`, or `CommandDialog` for one revision-checked command.

  ```js
  openDialog('label.delete', { label, count });
  export function DeleteLabelDialog({ label, count }) {
    return html`<${CommandDialog} title="Delete label" command=${() => ({ kind: 'label.delete', target: label.name })}>…</${CommandDialog}>`;
  }
  ```

- Widgets take props, not imperative handles.
  `MultiSelect` is uncontrolled with `defaultValue` or controlled with `value` and `onChange`; remote pickers pass `entries`, `status`, `onQuery` and `onOpenChange`.

  ```js
  html`<${MultiSelect} name="gitlab_user" title="GitLab user" entries=${entries} value=${selected} status=${status} single=${true} onQuery=${setQuery} onChange=${setSelected} />`;
  ```

- Anything with state, identity or list membership is a component with a stable domain `key` on its element; board cards and List rows are `memo` components.

  ```js
  html`${peers.map((item) => html`<${Card} key=${item.id} item=${item} context=${context} />`)}`;
  ```

- Native form drafts stay uncontrolled (`defaultValue`) unless the UI owns the changing value; widgets report committed changes with `useCommittedChange`.
- Document and window listeners, timers, observers and focus lookups live in `modules/ui-hooks.js` effects (`useEventListener`, `useDismiss`, `useFocusRestore`, `focusByKey`); every resource needs cleanup.
  Drag and drop are `useDraggable`/`useDropZone` props; tooltips are `useAttachmentTooltip`/`useObservationTooltip` props.
  `make lint-web` fails on `$(`, `document.querySelector`, `addEventListener` and `state.x =` outside `api.js`, `actions.js` and `ui-hooks.js`.
- Use Preact style objects for dynamic colors and CSS variables; Preact applies these through CSSOM, which preserves the existing CSP.
  Never pass a style string or use `dangerouslySetInnerHTML`.
- No CSS, API or CSP changes are part of rendering work; never introduce inline styles, scripts or `eval`.
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
A module imports only modules above it, and Biome's `noImportCycles` rule enforces an acyclic graph.
No module imports `app.js`; `app.js` sets the saved theme, renders `App` once and starts the session.

| Layer | Modules |
|---|---|
| Base | `vendor-preact`, `vdom`, `store`, `ui-hooks`, `dom`, `api`, `format`, `markdown`, `layout`, `item-command`, `multi-select` |
| State | `state`: the store with every shared UI value, as data |
| Services | `permissions`, `notices`, `items`, `people`, `tooltip`, `dialog-state`, `page-data`, `gate-components`, `gitlab-catalog`, `due-dates`, `filters`, `item-attachments`, `item-comments`, `url-state`, `view-burndown`, `view-velocity`, `sync`, `commands` |
| Actions | `actions`: navigation, presentation, detail, editor, workspace and startup actions; `dialog`: `Modal`, `FormDialog`, `CommandDialog` and the dialog host; `drag` |
| Item | `gitlab`, `item-links`, `item-editor`, `item-detail` |
| Views | `planning-filters`, `view-board`, `view-archive`, `bulk`, `view-list`, `view-sprints`, `view-integration`, `view-projects`, `view-labels`, `view-members`, `view-proposals`, `view-history`, `view-gate`, `shortcuts` |
| Shell | `app-shell`: the body-level `App`, its effects (shortcuts, polling, URL, due-date clock) and the `DIALOGS` map |

## CSS file map

`static/styles/NNN-*.css` are joined in name order into `/styles.css`; order is cascade order, so moving a rule can change which rule wins.
Insert new files in the numbering gaps and compare the style snapshot after any move.
Each file holds one feature, including its media queries; a feature's responsive rules sit at the end of its own file unless the cascade needs them later (`106-list-responsive` follows `104-item-detail`).

| JS module | CSS files |
|---|---|
| `app-shell`, `app.js`, `actions`, `layout` | `010-tokens`, `020-base`, `030-shell` (sidebar, notices, section heads, page stack, empty state, skip link), `130-motion` |
| `view-sprints` | `031-panels` (panels, sprint panel, metrics), `210-sprint-goal` |
| `view-board`, `drag` | `032-board` (columns, cards, drag cursors, drop marks), `036-summaries` (project lens) |
| `view-gate` | `033-workspace-gate` (workspace choice and first run) |
| `item-comments` | `034-comments` |
| `markdown` | `035-markdown` |
| `view-archive`, `view-history` | `037-archive-history` |
| `dialog`, `dialog-state` | `040-dialog` (dialog chrome, form grid, help and error lines) |
| `view-projects`, `view-members`, `view-labels` | `045-maintenance` (maintenance rows, member roles, label palette, integration chips) |
| `multi-select`, `view-integration` | `050-forms` (consent, multi-select, help popovers) |
| `view-proposals` | `055-proposals` |
| `item-editor` | `060-item-editor` (layout, head, status summary), `220-dates` |
| `view-burndown` | `070-burndown` |
| `gitlab`, `item-links` | `090-gitlab` (MR paste row, observation icons) |
| `filters`, `planning-filters` | `100-filters` (filter bar, presentation toggle, chips) |
| `view-list` | `102-list`, `106-list-responsive` |
| `item-detail` | `104-item-detail` |
| `item-attachments`, `tooltip` | `108-attachments` (tiles, tooltip, progress, drop targets) |
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
  `tests/rendering.browser.js` checks store-driven identity and cross-column focus/disclosure preservation.
  `tests/board-perf.browser.js` measures synthetic 100/500/1000-card boards; compare runs on the same browser host only.
- Tool versions are pinned in the `Makefile` (`BIOME_VERSION`, `RUMDL_VERSION`) and in CI.
  Set `BIOME=biome` or `RUMDL=rumdl` to use installed binaries.
