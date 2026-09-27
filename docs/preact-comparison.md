# Preact + HTM renderer experiment

## Scope and ownership

This branch starts at `main` (`3513fc9`) and renders every dynamic view and dialog with Preact/HTM.
It reuses the view/template boundaries developed on `lit-html` (`0a968f7`) rather than rewriting the same feature behavior independently.
The old DOM reconciler, card signatures and per-section patch routines are removed.
No Go, CSS, API, authentication or CSP behavior is intentionally changed.

A body-level Preact `App` renders once and owns the sidebar, navigation, heading, status and undo bars, page frame and native dialogs.
Every later change is a store update: components subscribe to the values they render, and named actions in `modules/actions.js` make one `setState` patch each.
The store holds replaced, never mutated, data only; DOM nodes, timers and request bookkeeping live in component refs, effects or module variables.
Dialogs are `{ type, props }` records looked up in the App's dialog map, so a dialog is a component with its own submit handler and a snapshot of its opening props.
`app.js` calls Preact's `render` once, while `modules/vdom.js` binds HTM to Preact's `h` and provides a shallow-props `memo`.
No second reconciler, manual re-render path or rendered-once island API remains.

Stateful widgets are Preact function components that own interaction state with hooks and reducers, and acquire outside listeners, requests, subscriptions and observers in effects with cleanup.
Widgets take props instead of exposing imperative handles; component-owned reads use `useRequest` and writes `useMutation`, both aborted on unmount.
Native form drafts remain uncontrolled unless the application owns their changing value, so unrelated renders do not reset user input.
Revision-checked command flows remain plain ES modules; they are shared domain behavior rather than renderer-specific component state.

Remaining direct DOM work is limited to browser interactions: native dialog `showModal`/`close` in one `Modal` effect, file input activation, the detached drag preview image, geometry-based tooltip positioning and one focus-restore effect for keyed controls that are recreated.
These operations must not become a second renderer for component-owned children.
A keyed card moving between columns changes its Preact parent and remounts; its logical focus is restored and its attachment disclosure is board state.
Within one parent, keyed nodes retain identity.

## Validation

All six database-backed browser suites pass through the configured remote Playwright service:

- Planning: workspaces, projects, sprints, comments, attachments, stale edits, archive/restore and optimistic rollback.
- Drag/labels: ordering, filtered moves, WIP rejection, labels and viewer controls.
- Integration: approvals, MR association, member management, revocation and read-only access.
- Background: polling, cache convergence and preservation of planning drafts.
- Proposals: consent, exact historical diffs, stale rejection and machine-write denial.
- Rendering: keyed identity, cross-column focus/disclosure and root disposal.

The isolated component suite also verifies CSP-safe text/Markdown, form contracts, nested effect cleanup, stale-update rejection and removal of outside-click listeners.
Functional suites cover light/dark layouts at 1440, 768 and 390 pixels and keyboard workflows.
The same-day style snapshots across 66 view/theme/width captures have identical visible element paths and computed styles to the pre-migration baseline.
Raw snapshots differ in renderer bookkeeping and discarded hidden dialog contents; those are not visual differences.
Run `node tests/compare-style-snapshots.mjs BEFORE.result AFTER.result` to reproduce the visible-path/computed-style comparison; use the functional tests separately for text, form behavior and accessibility.

## Measured board rendering cost

Example run on 2026-09-26, using one remote browser host, fresh disposable databases and the same `tests/board-perf.browser.js` probe for all three renderers.
Each cell is the median of seven runs in milliseconds, including forced style/layout.
These are synthetic board results, not a general browser benchmark or an end-to-end latency guarantee.

| Renderer | Cards | Initial render | Unchanged refresh | One title change |
|---|---:|---:|---:|---:|
| Original DOM | 100 | 8.2 | 2.6 | 2.7 |
| lit-html | 100 | 10.4 | 1.0 | 0.9 |
| Preact + HTM | 100 | 9.6 | 1.1 | 1.6 |
| Original DOM | 500 | 48.0 | 17.6 | 17.6 |
| lit-html | 500 | 55.5 | 6.7 | 6.1 |
| Preact + HTM | 500 | 50.2 | 8.0 | 8.2 |
| Original DOM | 1000 | 111.3 | 46.3 | 44.8 |
| lit-html | 1000 | 120.9 | 18.8 | 18.2 |
| Preact + HTM | 1000 | 108.5 | 20.6 | 20.3 |

Both library renderers inserted zero elements on unchanged refreshes and title-only updates.
The original renderer inserted six elements on a title update.
Cold-render ordering varies between runs; treat small differences as noise rather than a framework guarantee.
The checked-in Preact/HTM runtime, including `Component`, context and `options`, is 15,306 bytes, approximately 6.4 KB gzip; this lit bundle is 11,903 bytes, approximately 4.8 KB gzip.
The board measurements above predate the hook-component migration and are a historical hybrid-renderer baseline.

After moving to a single store-driven update path with memoized cards (2026-09-27, same probe, one remote browser host), updates are measured as a board replacement in the store; unchanged entities keep their identity across refreshes:

| Cards | Initial render | Unchanged refresh | One title change |
|---:|---:|---:|---:|
| 100 | 10.9 | 0.3 | 0.3 |
| 500 | 53.0 | 0.7 | 0.8 |
| 1000 | 112.4 | 1.0 | 1.2 |

Initial renders insert the same element counts as before; compare runs on the same browser host only.
Normal application builds require no npm installation.

## Decision considerations

- Preact supplies component identity, hooks and effect cleanup for independently interactive widgets and the shell.
  Shared domain/session controllers stay outside both renderers while widget-local state uses each renderer's native model.
- lit-html fits plain template rendering with the shared imperative shell and has a smaller bundle in the recorded sample.
  Widget lifetimes and cleanup still need an explicit owner outside its template primitives.
- Import maps are not used for runtime delivery: browser import maps are inline script blocks, which conflicts with Flux's `script-src 'self'` policy and prohibition on inline scripts.
  Loading the packages from a CDN would also add an external runtime dependency.
  Keep the reproducibly bundled, same-origin runtime generated by `make vendor-web`.
- Neither library removes the need for stable domain keys, API validation, request-generation guards, CSP-safe Markdown, permission checks or performance measurements.
- No virtualization, application build step, React compatibility layer, global state package or speculative component framework was added.

Run `tests/run-browser.sh board-perf` for the probe and `tests/run-browser.sh` for behavior coverage, always against disposable test databases.
Use an explicit `PLAYWRIGHT_CLI_SESSION` and a private `FLUX_BROWSER_HOST` when sharing a remote browser service.
