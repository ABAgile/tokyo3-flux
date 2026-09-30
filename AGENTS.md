# Flux frontend conventions

The planning UI is plain ES modules and CSS under `internal/planningui/static/`, embedded with `go:embed`.
There is no application build step or runtime package installation.
Preact and HTM are vendored in `modules/vendor-preact.js`; all dynamic views, widgets and dialog markup render Preact VNodes.
One Preact `App` in `modules/app-shell.js` renders the whole body once; every change after that is a store update.
UI state lives in one store (`modules/state.js`), changes go through named actions (`modules/actions.js`), and components subscribe to what they read.

## Rendering with Preact

- Modules are type-checked without a build step: `make typecheck-web` runs `tsc --checkJs` over them with `tools/types/tsconfig.json`.
  Shared contracts live in `tools/types/flux.d.ts` as `Flux.*` — the store `State`, board entities, `Lookups`, `RowContext`, `Command` and every dialog's props in `DialogProps` — and modules refer to them in JSDoc.
  A new state key goes into `Flux.State` and a new dialog into `Flux.DialogProps` and the App's `DIALOGS` map; its component takes `@param {Flux.DialogProps['type']} props`.
  `modules/vendor-preact.d.ts` types the bundle's exports for the checker only; it is never served.
  `noImplicitAny` is on: every parameter, destructured prop and module-level `let` carries a JSDoc type, reusing a `Flux.*` type before adding one; do not silence it with `@type {any}`.
  `tsc` does not check the inside of `html` templates, so a handler written there names its event, `(/** @type {Flux.TargetEvent<HTMLInputElement>} */ event) => …` when it reads `currentTarget`.
  `strictNullChecks` is on: a DOM ref names its element, `useRef(/** @type {HTMLInputElement | null} */ (null))`, and an action the UI offers only while a workspace is open reads it through `requireBoard()`, `requireRoot()` and `sessionCSRF()` from `modules/state.js`, which throw when that precondition is broken; code that can run without a board checks `state.board` instead.
- Import Preact runtime APIs directly from `modules/vendor-preact.js`; `modules/vdom.js` binds HTM's `html` tag to Preact's `h` and provides `memo` and `shallowEqual`.
  Use HTM templates, not JSX or raw HTML injection.
  `tsc` does not check props inside `html` templates, so the shared widgets — `MultiSelect`, `MarkdownEditor`, `FormDialog`, `CommandDialog` and `Card` — are rendered with `h(Widget, props, children)`, which is checked against their `Flux.*Props`; the `typed-widgets` lint rule rejects them in templates.
  A widget that other modules render gets a props type in `flux.d.ts` and joins that rule.
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

- Replace values, never mutate them: arrays and board entities get new objects.
  Store values are plain data — lists of ids are arrays, not `Set`s — so they compare, print and serialize like the rest of the state; build a `Set` locally with `useMemo` where lookups need one.
  The store holds data only — no DOM nodes, functions or timers; those live in component refs or module variables.

  ```js
  setState((current) => ({ burndownExpanded: toggled(current.burndownExpanded, id) }));
  ```

- Component-owned reads use `useRequest`; list every identity that restarts the work, especially the workspace root.
  Writes use `useMutation`, which refuses a second submission and aborts on unmount; `api` and `apiUpload` forward `signal`.
  Request-owning components read `root` with `useStore` and are keyed by it and their record, so a switch remounts them and aborts their work; they need no root checks after `await`.

  ```js
  const page = useRequest((signal) => api(`${root}/items/${id}/comments`, { signal }), [root, id]);
  ```

- Work that outlives its component — card-drop uploads, board and page loads, polls, a link attached after the editor closed — takes `workspaceSignal()` from `modules/workspace-session.js`.
  Every change of workspace root calls `beginWorkspaceSession()`, which aborts all of it; check `signal.aborted` after `await` and treat `isAbortError` rejections as silent.
  Board and workspace-list loads go through `beginLoad`/`finishLoad` in `sync.js`: a new load aborts the one in flight.

  ```js
  const signal = workspaceSignal();
  const page = await viewPage(view, signal);
  if (!signal.aborted) setState(page);
  ```

- Dialogs are data: `openDialog(type, props)` stores `{ type, props }`, and the App's `DIALOGS` map names the component.
  Props are the snapshot captured at opening; opening a dialog replaces the current one.
  Dialog components render `FormDialog`, or `CommandDialog` for one revision-checked command.

  ```js
  openDialog('label.delete', { label, count });
  export function DeleteLabelDialog({ label, count }) {
    return h(CommandDialog, { title: 'Delete label', command: () => ({ kind: 'label.delete', target: label.name }) }, html`…`);
  }
  ```

- Widgets take props, not imperative handles.
  `MultiSelect` is uncontrolled with `defaultValue` or controlled with `value` and `onChange`; remote pickers pass `entries`, `status`, `onQuery` and `onOpenChange`.

  ```js
  h(MultiSelect, { name: 'gitlab_user', title: 'GitLab user', entries, value: selected, status, single: true, onQuery: setQuery, onChange: setSelected });
  ```

- Anything with state, identity or list membership is a component with a stable domain `key` on its element; board cards and List rows are `memo` components.

  ```js
  html`${peers.map((item) => h(Card, { key: item.id, item, context, isBlocked, attachmentsOpen, onAttachmentsToggle }))}`;
  ```

- Naming says what may subscribe: PascalCase components may read the store with `useStore`, while `*Template` functions (56 of them) are pure and take everything they render as arguments; the `pure-templates` lint rule enforces this.
  A template that needs store data gets it from the component that calls it, or becomes a component.
- Render helpers take the data they read; they never read the store.
  Name, label, project, sprint, column and participant resolution takes the board lookups from `selectLookups` (`modules/lookups.js`), which keep their identity until an indexed list changes.
  Cards and List rows receive them in the row context, so a memoized row re-renders exactly when something it can show changes.

  ```js
  const lookups = useStore(selectLookups);
  html`${item.labels.map((name) => labelBadgeTemplate(lookups, name))}`;
  ```

- Element ids a control needs without a form name come from `useId()` in the owning component, prefixed by purpose (`multi-select-${id}`), so the modal editor and the detail pane never collide and a re-render keeps them.
- Native form drafts stay uncontrolled (`defaultValue`) unless the UI owns the changing value; widgets report committed changes with `useCommittedChange`.
- Document and window listeners, timers, observers and focus lookups live in `modules/ui-hooks.js` effects (`useEventListener`, `useDismiss`, `useFocusRestore`, `focusKey`); every resource needs cleanup.
- Focus moves are state, never scheduled callbacks.
  An action adds `focusRequestPatch(scope, key)` to the patch that renders the target, and the component named by `scope` consumes it with `useFocusRequest(scope, ref)` in a layout effect after that render commits; the dialog host fulfils a request made while a modal dialog was open, then returns focus to its opener.
  Local focus follows a nonce or flag in component state and a layout effect, as the detail pane's `focusNonce` does.
  Drag and drop are `useDraggable`/`useDropZone` props; tooltips are `useAttachmentTooltip`/`useObservationTooltip` props.
  Values that change at pointer-event rate live in `modules/pointer-state.js`, a separate store, so a drag-over or hover notifies only drop zones and tooltip triggers; text a user is typing stays component state until it is committed, as the search field does after its debounce.
  The guardrails are Biome GritQL plugins in `tools/lint/`, one rule per file (a combined rule defeats Biome's node prefilter and is several times slower), matched on the syntax tree so layout and nesting do not hide a violation.
  They reject `$(`, document queries and `addEventListener` outside `ui-hooks.js` (and `api.js` for XHR progress), `document.activeElement` outside `ui-hooks.js` and `dialog-state.js`, writes to or aliases of the `state` and `pointer` views, `useState` capturing store state, store reads inside `*Template` functions, store imports in `items.js`, `people.js` and `lookups.js`, and shared widgets inside `html` templates.
  GritQL regexes must not use capture groups, and plugins listed under Biome `overrides` are silently ignored.
- The planning content, the List detail pane and the dialog host each render inside an `ErrorBoundary` (`modules/error-boundary.js`), keyed or reset by what they show, so a render failure replaces only that part with a Retry notice.
  A store selector that throws re-selects during render, so its error reaches the nearest boundary instead of interrupting `setState`.
  The `App` itself is an outer boundary around the shell whose fallback offers Reload; the failed shell unmounts, which stops its effects.
  Boundaries see render and effect failures only: the shell's `unhandledrejection` and `error` window listeners pass everything else to `reportUnexpectedError` (`modules/notices.js`), which logs it and shows it in the error bar unless it is an `AbortError`.
  Fire-and-forget `void` calls still handle their expected failures themselves; the listeners are the backstop.
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
| Base | `vendor-preact`, `vdom`, `store`, `ui-hooks`, `error-boundary`, `dom`, `api`, `workspace-session`, `format`, `markdown`, `layout`, `item-command`, `multi-select` |
| State | `state`: the store with every shared UI value, as data; `pointer-state`: the event-rate drop mark and attachment tooltip in their own store |
| Services | `permissions`, `notices`, `focus-request`, `lookups`, `items`, `people`, `tooltip`, `dialog-state`, `page-data`, `gate-components`, `gitlab-catalog`, `due-dates`, `filters`, `item-attachments`, `item-comments`, `url-state`, `view-burndown`, `view-velocity`, `sync`, `commands` |
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
| `app-shell`, `app.js`, `actions`, `layout`, `error-boundary` | `010-tokens`, `020-base`, `030-shell` (sidebar, notices, section heads, page stack, empty state, skip link), `130-motion` |
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

- After editing JS or CSS, run `make fmt-web lint-web typecheck-web`, then `make test-web`.
- After editing Markdown, run `make fmt-md`.
- Before handing off, run `make check-web test-web`.
- Any Go change (for example `web.go`) needs `make check` with `FLUX_TEST_DATABASE_URL` set to a disposable database.
- `tests/unit/*.test.mjs` run in Node with `node:test` as part of `make test-web`: store semantics, filter rules, optimistic placement and undo, board merging, URL restore, lookups and workspace cancellation.
  Test pure logic there first; `tests/unit/dom.mjs` is just enough DOM for Preact to render hooks.
  Keep such logic in functions that take the state they read, so it runs without a browser.
- Browser scripts in `tests/*.browser.js` run through Playwright `run-code` against disposable, seeded workspaces only.
  `tests/style-snapshot.browser.js` returns a JSON style snapshot; save it outside the repository and diff two runs made on the same day.
  `tests/rendering.browser.js` checks store-driven identity and cross-column focus/disclosure preservation.
  `tests/board-perf.browser.js` measures synthetic 100/500/1000-card boards; compare runs on the same browser host only.
- Tool versions are pinned in the `Makefile` (`BIOME_VERSION`, `RUMDL_VERSION`, `TYPESCRIPT_VERSION`) and in CI.
  Set `BIOME=biome`, `RUMDL=rumdl` or `TSC=tsc` to use installed binaries.
