# ADR 0001: Preact + HTM, JSDoc-checked ES modules, no application build

- Status: Accepted
- Date: 2026-09-30
- Deciders: Szeto Bo
- Supersedes: the hand-written DOM reconciler and the interim lit-html renderer
- Scope: `internal/planningui/static/`, `tools/`, frontend checks.
  The Go backend is covered in the "Related decisions" section.

## Context

Flux is a Go backend (`flux serve`) with a browser planning UI.
The UI is embedded in the Go binary with `go:embed` and served from a fixed allowlist (`/`, `/app.js`, `/styles.css`, single-level `/modules/*.js`).

Constraints that shaped the decisions:

1. **Security policy.**
   The CSP is `script-src 'self'; style-src 'self'`.
   There are no inline scripts, no inline styles, and no `eval`.
   This rules out import maps, which are inline script blocks.
   It also rules out CDN runtime dependencies and `style="…"` strings.
2. **Deployment footprint.**
   The existing Dockerfile compiles the embedded UI with Go only (`CGO_ENABLED=0`); neither the image build nor server startup requires Node.
   There is no runtime package installation.
3. **UI complexity.**
   About 12k lines of JS across about 60 modules: a board and list with drag and drop, dialogs, a Markdown editor, attachments with upload progress, polling, optimistic updates with rollback, and URL-synced state.
   It has to handle 1,000-card boards.
4. **Contract coupling.**
   The `/api/v2` JSON contract is shared by the browser, the `flux` CLI, and the Pi extension.
   Drift between the Go structs and the UI is a real risk.
5. **Mechanical guardrails.**
   Types, lint rules, and tests enforce frontend conventions without relying solely on review.

The UI began as a single hand-written DOM script.
It was split into ES modules (`ace216a`) and then grew a custom keyed reconciler, card signatures, and per-section patch routines.
Maintaining that reconciler was the pain point that led to this ADR.

## Decisions

### D1. Renderer: Preact (over hand-crafted DOM, and over lit-html)

**Decision.**
Use Preact 10 with hooks.
One `App` owns the body-level shell; subsequent updates flow through store subscriptions or component-local hooks.

**Options considered.**
Hand-crafted DOM, lit-html (implemented on a branch, `40b806f..0a968f7`), and Preact + HTM (`f8c50e0..86af81a`).

**Before/after measurements (2026-09-30).**
Remeasured all four revisions on the same Linux arm64 host with headless Chromium 152.0.7977.82, a 1440 × 1000 viewport, and Node 24.18.1 / Go 1.27.1 for the harness.
Each revision used its own `tests/board-perf.browser.js` through the current `tests/run-browser.sh`, with a freshly created, seeded disposable database.
Synthetic cards exist only in the page; no team data was used.
All render timings below are medians of seven samples, in milliseconds, including forced style/layout.

| Renderer and revision | Cards | Initial | Unchanged refresh | One title change |
|---|---:|---:|---:|---:|
| Original DOM (`2c40a08`) | 100 | 16.4 | 4.4 | 4.4 |
| Original DOM (`2c40a08`) | 500 | 70.7 | 24.3 | 23.5 |
| Original DOM (`2c40a08`) | 1000 | 157.2 | 54.2 | 52.9 |
| lit-html (`0a968f7`) | 100 | 17.1 | 1.4 | 1.1 |
| lit-html (`0a968f7`) | 500 | 78.8 | 6.9 | 6.0 |
| lit-html (`0a968f7`) | 1000 | 177.0 | 17.9 | 17.1 |
| Interim Preact + HTM (`5acace8`) | 100 | 14.9 | 1.3 | 1.8 |
| Interim Preact + HTM (`5acace8`) | 500 | 73.6 | 7.8 | 7.6 |
| Interim Preact + HTM (`5acace8`) | 1000 | 159.5 | 20.3 | 19.5 |
| Current Preact + HTM (`729d010`) | 100 | 17.6 | 0.4 | 0.4 |
| Current Preact + HTM (`729d010`) | 500 | 89.6 | 0.8 | 0.9 |
| Current Preact + HTM (`729d010`) | 1000 | 170.6 | 1.0 | 1.0 |

At 1,000 cards, the measured render/layout segment in the current single-store, selector-backed, memoized-card design is roughly 54× faster for an unchanged refresh and 53× faster for a title change than the original DOM path.
Initial rendering is about 9% slower than the original DOM path; this is an update-path improvement, not a universal rendering-speed win.
All four revisions inserted 13,767 elements on the 1,000-card initial render and zero on an unchanged refresh.
The original DOM path inserted six elements on a title change; the other three inserted none.

The probes exercise equivalent scenarios through different integration paths: historical revisions clear `#planning-body` for the initial render and call `hooks.renderContent()`, while the current revision changes workspace identity and synchronously flushes Preact's captured render batch.
Render timings exclude data preparation and, in the current probe, synchronous `setState` subscriber notification; they are not end-to-end update latency.
The current probe separately measures interactions including event dispatch, subscriber notification where applicable, render, and layout:

| Current interaction | Samples | 100 cards | 500 cards | 1000 cards |
|---|---:|---:|---:|---:|
| Search keystroke, before debounce | 7 | 0.1 | 0.1 | 0.1 |
| Drag-over mark change | 40 | 0.3 | 0.1 | 0.2 |
| Attachment tooltip show/hide | 14 | 0.1 | 0.1 | 0.1 |
| One card's attachment list arriving | 7 | 0.5 | 1.0 | 1.7 |

These are per-interaction medians in milliseconds, not maxima.
Search does not include the later debounced filtering work, and attachment arrival does not include the network request.
Browser timers are coarse at these small durations.
These synthetic, single-host results do not measure cold-load/network performance or guarantee user-visible latency.

To repeat the comparison, set `FLUX_BROWSER_PG` to a disposable Postgres service whose role has `CREATEDB`, then run from the repository root with the same local Playwright configuration:

```sh
sources=$(mktemp -d)
mkdir -p /tmp/playwright/flux-adr-perf
results=$(mktemp -d /tmp/playwright/flux-adr-perf/repeat.XXXXXX)
for revision in 2c40a08 0a968f7 5acace8 729d010; do
  mkdir -p "$sources/$revision"
  git archive "$revision" | tar -x -C "$sources/$revision"
  cp tests/run-browser.sh "$sources/$revision/tests/run-browser.sh"
  FLUX_BROWSER_OUT="$results/$revision" PLAYWRIGHT_CLI_SESSION=flux-adr-perf \
    sh "$sources/$revision/tests/run-browser.sh" board-perf
done
```

The runner migrates, seeds, and drops each test database and saves the raw JSON in each revision's `board-perf.result`.
No checkout of the working tree is needed.

**Rationale.**

- Raw rendering speed did not separate lit-html from Preact.
  Both inserted zero elements on unchanged refreshes, and the hand-written renderer inserted six on a title edit.
- Preact supplies component identity, hooks, effect cleanup, and error boundaries.
  Flux has many independently interactive widgets (multi-select, Markdown editor, attachment tooltips, drag and drop) whose listeners, observers, and requests need an owner with a lifecycle.
  By contrast, lit-html renders templates but leaves widget lifetime to hand-written code, which was the failure mode of the old reconciler.
- Preact's hooks model maps cleanly onto the `useRequest` / `useMutation` abort-on-unmount discipline and focus-as-state.

**Consequences.**

- Positive: the reconciler, signatures, and patch routines are deleted.
  Re-render cost is bounded by store selectors and `memo`.
- Negative: the checked-in bundle is larger (15.7 kB, about 6.5 kB gzip, vs 11.9 kB / 4.8 kB for lit-html; decimal units).
  `memo` (the component wrapper) is only in `preact/compat`, which isn't vendored, so `vdom.js` provides a ~20-line shallow-props equivalent.
  Hooks such as `useMemo` and `useCallback` come from `preact/hooks` and are used normally.
  Preact-specific rules now exist (keys, selectors, uncontrolled drafts).
- Not adopted: React compat, virtualization, and a third-party state library.
  The store implementation is about 120 lines (`store.js`), with another 125 lines for application state and selectors (`state.js`).

### D2. Templating: HTM tagged templates (over JSX)

**Decision.**
Write markup as ``html`…` `` with HTM bound to Preact's `h`.
JSX is not used.

**Rationale.**

- HTM runs in the browser with no compile step.
  JSX must be transformed, which would itself require a build stage (see D4).
- HTM output is identical in kind to `h()` VNodes, so there is no second rendering path.

**Consequences.**

- Negative: `tsc` does not check element names or props inside `html` templates.
  Mitigations in `AGENTS.md`:
  - Shared widgets (`MultiSelect`, `MarkdownEditor`, `FormDialog`, `CommandDialog`, `Card`) are rendered with `h(Widget, props, children)` so their props are type-checked, and the `typed-widgets` Biome rule rejects them inside templates.
  - Event handlers inside templates name their event types explicitly.
- HTM is pinned and vendored with its license.
  It is small and stable, but it has fewer maintainers than JSX tooling.
- Revisit if template typos become a recurring defect source.
  Adopting JSX would mean reopening D4.

### D3. Typing: JSDoc + `tsc --checkJs` with `strict` (over full TypeScript)

**Decision.**
Source files are `.js`.
Types are JSDoc, checked by a pinned `tsc` with `noEmit` through `tools/types/tsconfig.json`.

- `strict` is on, including `noImplicitAny` and `strictNullChecks`.
  `@type {any}` is not used to silence the checker.
- Shared contracts live in `tools/types/flux.d.ts` as `Flux.*` (store `State`, board entities, `Lookups`, `RowContext`, `Command`, `DialogProps`).
- `vendor-preact.d.ts` types the vendored bundle for the checker only, and is never served.
- The Go↔TS board contract has two checks: Go's `TestBoardJSONContract` compares a fully populated board against `tests/fixtures/board.json` and checks public-field coverage; `tsc` checks that fixture's recursive keys and value types against `Flux.Board` in `tools/types/board-contract.ts`.

**Options considered.**
Full TypeScript (`.ts` + compile or strip step), untyped JS, and JSDoc with checking.

**Rationale.**

- What is served is what is written.
  A browser-native module graph needs no source maps, no emit step, and no mismatch between debugged and shipped code.
- Full TypeScript would introduce an application build stage (D4) to gain types that `tsc --checkJs` already provides.
- It was adopted incrementally (`checkJs` → `strictNullChecks` → `noImplicitAny` → `strict`), which let the checker find real bugs early.
  For example, declared `links.show` props were corrected on the first run.
- `.d.ts` files cover what JSDoc expresses poorly (the `Flux.*` namespace, dialog-props maps).

**Consequences.**

- Negative: JSDoc is verbose, and generics and casts are awkward (`/** @type {…} */ (x)`).
  Every parameter needs an annotation.
  `tsc` still does not see inside `html` templates (see D2).
- Negative: TypeScript and Biome are run via pinned `npx` versions, which requires Node at check time.
  Developers and CI need network or a cache.
  `make check-web` covers lint, types, and tests.
- Native type stripping (Node or browsers) and TypeScript enums and namespaces are not relied on.
- Revisit if a build stage is adopted for another reason (D4).
  `.ts` would then be nearly free.

### D4. No application build stage; one checked-in vendor bundle

**Decision.**
Application modules and CSS are served as written.

- `make vendor-web` rebuilds `vendor-preact.js` with esbuild from a lockfile-pinned `tools/vendor/package.json` (preact 10.29.8, htm 3.1.1, esbuild 0.28.2).
- The output is committed, and licenses are preserved inline.
- Nothing in the Docker or Go build invokes Node.
- CSS is plain files (`styles/NNN-*.css`) joined in name order into `/styles.css`.
  There is no preprocessor.

**Options considered.**
A full bundler pipeline (Vite, esbuild) for app and vendor code, import maps, and a CDN.

**Rationale.**

- Import maps conflict with `script-src 'self'`, and a CDN adds an external runtime dependency (both rejected explicitly in the renderer write-up).
- A reproducible, reviewable vendored bundle keeps supply-chain exposure in one lockfile and one command.
- The Go binary stays self-contained, and the asset ETags are content hashes, so shell revalidation is cheap (`c40fdd0`).

**Consequences.**

- Positive: Go-only image builds, instant edit→reload, no toolchain drift in the shipped artifact.
- Negative: no tree-shaking, minification, or bundler-generated chunks for app code.
  Cold loads request about 60 separate ES modules.
  The shell preloads every allowlisted same-origin JavaScript asset, avoiding serial import discovery, and Go precompresses all assets at startup for clients accepting gzip.
  Encoding-specific content ETags, `Vary: Accept-Encoding`, and `Cache-Control: no-cache` support conditional revalidation on later loads, not fewer cold-load requests.
  HTTP/2 is not guaranteed by `flux serve`; deployment-level multiplexing is optional, not a required mitigation.
  The 15.7 kB vendor bundle is the only minified file.
- Negative: a hand-edited or stale vendor bundle is possible, so the rule is "never edit the bundle; rebuild it".
  CI runs `make vendor-web` and fails if the regenerated bundle differs from the checked-in file.
- Bound: the flat `modules/*.js` allowlist (no subdirectories) is part of the security posture.
- Revisit when any of these hold: bundle or request count hurts measured load time, JSX/TS become necessary, or a dependency cannot be vendored as a single ESM file.

### D5. State architecture: one store, named actions, selectors

- Shared application state lives in one main store (`state.js`).
  Changes go through named actions that issue a single `setState` patch.
  Components subscribe with `useStore(selector)`.
- The store holds plain data only (no DOM nodes, functions, timers, or `Set`s).
  Values are replaced, never mutated, and `state` is a read-only view that throws on write.
- Event-rate values (drag-over marks, tooltips) live in a separate `pointer-state` store, so pointer events do not notify unrelated main-store subscribers.
- Text being typed stays component state until committed.
  Native form drafts are uncontrolled.
- Requests are owned: component reads use `useRequest` and writes use `useMutation` (abort on unmount).
  Work that outlives a component uses `workspaceSignal()`, and a workspace switch aborts all of it.
- Focus moves are state (`focusRequestPatch` + `useFocusRequest`), not scheduled callbacks.
- Render failures are contained by `ErrorBoundary` per region, with a backstop for `unhandledrejection` and `error`.

### D6. Mechanical guardrails: Biome + GritQL plugins + import layering

- Biome lints with warnings treated as failures.
- `tools/lint/*.grit` plugins (one rule per file, for speed) reject:
  - `document.querySelector` / `querySelectorAll` outside `ui-hooks.js`, and `addEventListener` outside `ui-hooks.js` or `api.js` (XHR progress)
  - writes to or aliases of `state`
  - store reads inside `*Template` functions
  - shared widgets inside `html` templates
  - `$(` lookups
- `noImportCycles` enforces the layered module map (Base → State → Services → Actions → Item → Views → Shell).
- Naming encodes permission: PascalCase components may subscribe to the store, while `*Template` functions are pure.

**Rationale.**
These rules were written after the same mistakes recurred, and they keep review load low.

**Consequence.**
Biome's plugin system is young.
Plugins under `overrides` are silently ignored, and GritQL regexes cannot use capture groups.
Both are documented in `AGENTS.md`.

### D7. Untrusted content: Markdown rendered to VNodes by a small in-repo renderer

- User Markdown is parsed by `markdown.js` (about 500 lines) into Preact VNodes.
  Text is written as text, so raw HTML is never parsed, and `dangerouslySetInnerHTML` is forbidden.
- Link targets are filtered through `markdownURL` (`http`, `https`, `mailto` only).
- Dynamic colors use Preact style objects (CSSOM), which keeps the CSP intact.
  Style strings are forbidden.
- Hostile link and markup tests in `tests/unit/markdown.test.mjs` run against the real renderer using the minimal DOM shim in `tests/unit/dom.mjs`.

**Trade-off.**
It supports a bounded Markdown subset, including tables, but no images or raw HTML, in exchange for no sanitizer dependency.

### D8. Test strategy

- **Node `node:test` unit tests** for store semantics, filters, optimistic placement and undo, URL restore, lookups, and cancellation, with a minimal DOM shim for hooks.
  Pure logic is tested first, so it runs without a browser.
- **Browser scripts** (`tests/*.browser.js`, run via Playwright against disposable seeded workspaces) for end-to-end behavior, style snapshots, and board performance probes.
  CI runs `rendering`, `planning`, and `drag-labels` against PostgreSQL and Chromium; performance probes remain an explicit local comparison, not a CI latency threshold.
- **Contract test:** Go `TestBoardJSONContract` with a generated fixture, checked against the TS declarations and reused by Node tests.

## Related decisions to record as separate ADRs

These are visible in the code and README but outside this frontend ADR.

| Proposed ADR | Decision summary |
|---|---|
| 0002 Planning is native, GitLab is observation-only | Flux owns planning state. GitLab is read-only (MR and pipeline cache), and agents never write autonomously. Replaced the earlier GitLab-derived cockpit (`49c2f2c`). |
| 0003 Revision-checked, audited, idempotent commands | `POST /changes`: workspace and entity revisions, CSRF, idempotency keys, and planning + audit committed in one transaction. Browser-only writes, with machine tokens read-only. |
| 0004 PostgreSQL only; explicit migrations; split roles | No DDL at serve time, `flux migrate` with an advisory lock, separate runtime and admin credentials, and least-privilege grants. No DELETE on `audit_events`. |
| 0005 Agent integration via Pi, read-only, human-approved proposals | Proposals are drafts that a human previews and accepts. The operation allowlist is `item.move`, `item.rank`, and `item.update`. |
| 0006 Attachment storage and lifecycle | Metadata in Postgres, bytes in a filesystem or NATS Object Store backend, upload reservations, and a durable cleanup queue. |
| 0007 Auth model | GitLab OAuth with PKCE and sealed-cookie sessions, a demo mode restricted to loopback, and machine bearer tokens mapped to explicit viewer subjects. |
| 0008 Cheap freshness and conditional reads | `/revision` probe, board ETag and 304, content-hash asset ETags, and the live-working-set board with archive paging. |

## Open questions

1. Were full TypeScript or JSX evaluated explicitly, or did the no-application-build constraint make them moot?
   The D2 and D3 rationale follows that constraint; a separate evaluation is not established by the implementation.
2. Should the existing Go-only image build remain a hard requirement, or is it a preference?
