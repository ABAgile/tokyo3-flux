# Preact + HTM renderer experiment

## Scope and ownership

This branch starts at `main` (`3513fc9`) and renders every dynamic view and dialog with Preact/HTM.
It reuses the view/template boundaries developed on `lit-html` (`0a968f7`) rather than rewriting the same feature behavior independently.
The old DOM reconciler, card signatures and per-section patch routines are removed.
No Go, CSS, API, authentication or CSP behavior is intentionally changed.

The shell still owns navigation, shared planning state, native dialogs and revision-checked commands.
Rendering factories return VNodes; Preact owns each render host's children.
The adapter in `modules/preact.js` provides keyed lists, explicit mount/unmount boundaries and logical focus recovery.
It does not implement another diff algorithm or reinterpret lit syntax.
HTM binds directly to Preact's `h`.

Stateful widgets are Preact function components that own interaction state with hooks and acquire outside listeners, subscriptions and observers in effects with cleanup.
This removes the former nested-controller roots and makes component identity, state, and lifetime visible to the renderer.
Native form drafts remain uncontrolled unless the application owns their changing value, so unrelated renders do not reset user input.
The shell, session state and revision-checked command flows remain plain ES modules; they are shared domain behavior rather than renderer-specific component state.

The remaining imperative boundaries are intentional: shell control state, native form submission, drag/drop, tooltip positioning, rendered-once dialog skeletons and user-owned disclosure/focus state.
Do not let a second renderer patch component-owned children.
A keyed card moving between columns changes its Preact parent and remounts; its logical focus and open attachment disclosure are explicitly restored.
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
The checked-in Preact/HTM runtime is 14,514 bytes, approximately 6.1 KB gzip; this lit bundle is 11,903 bytes, approximately 4.8 KB gzip.
The board measurements above predate the hook-component migration and are a historical hybrid-renderer baseline, not a benchmark of the current component implementation.
Re-run both renderer probes on the same browser host before drawing performance conclusions from the migrated implementation.
Normal application builds require no npm installation.

## Decision considerations

- Preact supplies component identity, hooks and effect cleanup for independently interactive widgets.
  The comparison keeps shared shell/domain controllers outside both renderers while implementing widget-local state with each renderer's native model.
- lit-html fits plain template rendering with the shared imperative shell and has a smaller bundle in the recorded sample.
  Widget lifetimes and cleanup still need an explicit owner outside its template primitives.
- Import maps are not used for runtime delivery: browser import maps are inline script blocks, which conflicts with Flux's `script-src 'self'` policy and prohibition on inline scripts.
  Loading the packages from a CDN would also add an external runtime dependency.
  Keep the reproducibly bundled, same-origin runtime generated by `make vendor-web`.
- Neither library removes the need for stable domain keys, API validation, request-generation guards, CSP-safe Markdown, permission checks or performance measurements.
- No virtualization, application build step, React compatibility layer, global state package or speculative component framework was added.

Run `tests/run-browser.sh board-perf` for the probe and `tests/run-browser.sh` for behavior coverage, always against disposable test databases.
Use an explicit `PLAYWRIGHT_CLI_SESSION` and a private `FLUX_BROWSER_HOST` when sharing a remote browser service.
