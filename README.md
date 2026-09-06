# Flux

Flux is an agent-first GitLab SDLC cockpit for the `tokyo3` group. It turns
GitLab's distributed issue, milestone, merge-request, pipeline, and label data
into one small, authenticated read model that humans and Pi can inspect.

GitLab remains the system of record. Flux stores derived state, presents useful
joins and delivery signals, and provides a tightly constrained browser approval
boundary for the small number of mutations it supports.

## Purpose and scope

Flux is intended to make team delivery status easier to see and discuss across
projects and subgroups. It is deliberately a lightweight modular monolith, not
a second project-management system and not a replacement for GitLab, `glab`, or
GitLab Duo.

The current scope is:

- Group-scoped operation through `FLUX_GITLAB_GROUP`.
- The rolling active GitLab milestone as the default sprint view.
- Read-only status and joins for issues, merge requests, pipelines, assignees,
  labels, blockers, review requests, and activity freshness.
- A browser cockpit and machine-readable CLI/API views for agents.
- An append-only, derived history of observed work-item changes, durable sync-run
  provenance, retention, and bounded time-window analysis.
- A browser-approved human context overlay for delay explanations and scope
  changes, with corrections, redaction, retention, and audit metadata.
- Bounded evidence-based standup, sprint-health, refinement, planning, backlog,
  and retrospective reports that keep GitLab evidence separate from human
  context.
- Optional, human-approved addition of one existing GitLab label to an open
  issue in the current rolling view.

Flux does not import GitLab board positions, maintain a competing backlog, or
let Pi directly modify GitLab.

## Highlights

### GitLab-derived delivery model

- Aggregates projects in the configured group and its subgroups.
- Uses project-qualified issue IDs such as `tokyo3/flux#12`.
- Joins related merge requests and their latest relevant pipeline state.
- Uses milestone descriptions as sprint goals, with an optional
  `FLUX_SPRINT_GOAL` override.
- Selects the current active milestone on every reconciliation; no fixed
  milestone or project fallback is required.
- Derives statuses deterministically in this order: done, blocked, pipeline
  failing, awaiting review, stale, todo, and in progress.
- Displays current GitLab labels as compact work-item chips.

### Browser cockpit

The embedded responsive cockpit provides:

- Summary metrics and counts.
- Needs-attention, work, review, and pipeline-failure views.
- Active milestone selection with URL-persisted alternate read-only views.
- System-aware dark mode with a persisted manual preference.
- Freshness timestamps and links/metadata for delivery context.
- `Reload view` to reread the cached snapshot without contacting GitLab.
- `Sync now` to queue one pull reconciliation, with pull state, duration, and
  last-error feedback.
- A label action dialog that follows a dry-run-then-confirm workflow.
- A human-context dialog that previews and confirms delay explanations or scope
  changes without changing the GitLab-derived read model; confirmed entries can
  be corrected or redacted through the same browser approval boundary.

Alternate milestone views are fetched on demand and never change the shared
cached snapshot. They do not expose mutation controls.

### Authentication and security boundaries

- Human browser access uses GitLab OAuth Authorization Code + PKCE and sealed
  Flux sessions.
- `/api/today` and related read views may use a scoped `FLUX_API_TOKEN` Bearer
  credential, limited to `GET` and `HEAD`.
- `FLUX_API_TOKEN` authenticates Pi to Flux; it is not a GitLab credential.
- Pi tools and machine API access are read-only.
- Browser action and human-context write routes require a human session and CSRF
  protection; machine Bearer credentials are rejected there.
- Proposed context is labeled as proposed until confirmation; Pi can read only
  confirmed context and cannot create, approve, correct, or redact it.
- GitLab reconciliation uses `FLUX_GITLAB_SERVICE_TOKEN`, which should remain
  read-only.

### Approval-gated mutation

`FLUX_GITLAB_WRITE_TOKEN` is optional and is never reused as the read token.
When configured, the browser can add an existing, current, non-archived label
that is not already assigned to an open issue. Each action:

1. Reads the current Flux snapshot and live GitLab issue.
2. Reads the current project/ancestor-group label catalog.
3. Creates a short-lived actor-bound dry-run plan.
4. Shows the exact issue, label, previous state, and expiry.
5. Rechecks freshness and label availability on confirmation.
6. Writes once with the separate credential and records secret-free audit events.
7. Triggers reconciliation so the cockpit returns to GitLab-derived state.

Plans expire after ten minutes and confirmations are one-time. If the write
token is absent, the cockpit reports that mutations are disabled and hides the
action controls. Removing labels, arbitrary issue edits, comments, assignment,
milestone changes, and bulk actions are not currently implemented.

### Reconciliation and persistence

- Background pull reconciliation defaults to every five minutes.
- A browser-session and CSRF-protected `Sync now` request can queue one
  immediate pull; machine credentials cannot invoke it.
- The default durable state directory is `/var/lib/flux`.
- Snapshot, derived-history, sync-run, webhook-event, action-audit, and human
  context data are stored locally as `snapshot.json`, `history.jsonl`,
  `sync_runs.jsonl`, `events.jsonl`, `audit.jsonl`, `context.jsonl`, and
  `context_audit.jsonl`.
- A successful pull records an observation and deterministic work-item diffs;
  label/MR ordering is canonicalized to avoid noisy changes. Sync runs record
  their mode, source watermark, overlap request, outcome, and coverage. The
  GitLab adapter uses milestone-filtered `updated_after` pulls between periodic
  full scans and merges them with the previous normalized view.
- Derived history and sync-run records are retained for `FLUX_HISTORY_RETENTION`
  (default `8760h`); set it to `0` to disable pruning. Retention creates a
  checkpoint so unchanged items remain reconstructable at the boundary.
- Human context is retained separately for `FLUX_CONTEXT_RETENTION` (default
  `2160h`); set it to `0` to retain it indefinitely. Corrections append a new
  revision. Redaction scrubs retained free text and leaves secret-free audit
  metadata plus a one-way content hash.
- Overlap pulls can miss an issue leaving the milestone or merge-request-only
  activity, so full scans remain mandatory and those gaps remain explicit
  uncertainty until the next full scan.
- A failed source pull does not replace the last valid snapshot; status retains
  its duration and bounded error text.
- History begins with the first successful observation. Baseline records do not
  prove creation, and the current milestone-scoped view does not infer deletes.
- Every change carries Flux `observed_at` and the snapshot timestamp; these are
  not claims of an exact GitLab event time.
- The webhook endpoint is optional; pull reconciliation is the authoritative
  freshness mechanism.
- HTTP proxy environment variables are honored by Go's default transport.

## Pi integration

The project-local extension is `.pi/extensions/flux.ts`. It registers seventeen
bounded, read-only tools:

- `flux_today` — complete machine-readable current status.
- `flux_changes` — observed historical work-item changes for a bounded window.
- `flux_item_history` — observed before/after history for one work item.
- `flux_snapshot` — reconstructed state at an observed RFC3339 time.
- `flux_flow` — observation-based flow and throughput counts.
- `flux_context` — confirmed human-reported delay and scope context; explicitly
  labeled as an overlay rather than GitLab evidence.
- `flux_sprint_status` — compact sprint health and risks.
- `flux_report` — bounded standup, sprint-health, refinement, planning, backlog,
  or retrospective report with coverage and a human-context overlay.
- `flux_sprint_health`, `flux_refinement`, `flux_planning`, `flux_backlog`, and
  `flux_retrospective` — focused report tools with the same evidence boundary.
- `flux_triage` — items needing attention and suggested next checks.
- `flux_standup` — evidence-based standup report.
- `flux_review_queue` — open merge requests needing review.
- `flux_pipeline_failures` — open merge requests with failed pipelines.

Pi uses the authenticated Flux API when both `FLUX_API_URL` and
`FLUX_API_TOKEN` are set. Otherwise it falls back to the Flux CLI via `FLUX_CLI`
or the `flux` executable on `PATH` (`flux today --json` for current status and
`flux <report-kind> --json` for reports). Pi should receive only Flux API
credentials, never the server's GitLab service or write token. History is
bounded to observations Flux has recorded; it does not backfill GitLab's
unavailable event history. Flow metrics cap their calculation at the 1000 most
recent matching changes and mark the result when capped.

The report views combine current GitLab signals with observations made after
Flux history starts and only confirmed human-reported context. The
`human_context_overlay` is not independently verified cause evidence and never
changes GitLab-derived status or counts. Reports expose their as-of time,
window, provenance, coverage, truncation, and uncertainties. Exact
pre-bootstrap history, changes between missed pulls, cycle-time/capacity
conclusions, and AI-generated backlog decisions still require additional
history and human input.

The intended AI control model is:

```text
observe → explain → propose → human approval → apply → reconcile
```

Pi can summarize and reason over Flux data, but it cannot approve an action or
human-context record. The human-input boundary and delay/scope workflows are
documented in [`docs/human-input-workflows.md`](docs/human-input-workflows.md).

## Responsibility separation for AI-assisted Scrum

AI assists the process; it does not own Scrum decisions or team commitments.
Responsibilities are separated as follows:

| Responsibility | Owner | Flux/Pi boundary |
| --- | --- | --- |
| Authoritative issues, milestones, merge requests, pipelines, and labels | GitLab | GitLab is the persisted source of truth. |
| Reconciliation, normalization, freshness, deterministic status, access control, and audit | Flux | Flux protects the read model and applies only supported, approved actions. |
| Summaries, risk detection, questions, drafts, and ceremony preparation | Pi/AI | Pi reads Flux, cites current evidence, and remains read-only. |
| Product goal, value, priority, ordering, and acceptance decisions | Product Owner and stakeholders | AI may highlight trade-offs; humans decide. |
| Feasibility, estimates, capacity, implementation ownership, and technical commitments | Delivery team | AI may surface dependencies and missing information; the team decides. |
| Facilitation, timeboxes, impediment escalation, and decision capture | Scrum Master or facilitator | AI can prepare an agenda and record proposed follow-ups; it does not facilitate by authority. |
| Final action approval | An authenticated human approver | The browser shows the exact plan; Pi cannot approve or use the write credential. |

The same separation applies to each ceremony:

- **Standup:** Pi prepares current completed, active, blocked, review, and
  pipeline signals. Team members provide context and commitments; the
  facilitator manages follow-up.
- **Refinement:** Pi flags unclear descriptions, missing acceptance criteria,
  duplicates, and dependencies. Product and delivery participants clarify,
  split, estimate, and accept issues.
- **Sprint planning:** Pi proposes goal-aligned candidates and risks from
  GitLab evidence. The Product Owner and team choose scope and capacity; an
  approver applies any resulting GitLab changes.
- **Product backlog:** Pi finds stale, duplicate, unowned, or underspecified
  items. The Product Owner owns ordering, priority, and product decisions.
- **Retrospective:** Flux supplies delivery metrics and Pi groups observable
  patterns. The team interprets causes, discusses them safely, and chooses
  experiments and owners; AI must not assign blame or infer performance.

No AI-generated summary is a commitment, estimate, priority, or personnel
judgment until the responsible humans explicitly accept it.

## API and CLI

Read and health routes include:

- `GET /api/today`
- `GET /api/today?milestone=<name>`
- `GET /api/milestones`
- `GET /api/changes?since=<RFC3339>&until=<RFC3339>&item_id=<id>`
  (also supports `milestone`, `limit`, and `include_baseline`)
- `GET /api/items/<url-encoded-id>/history`
- `GET /api/snapshots/<RFC3339>`
- `GET /api/flow?from=<RFC3339>&to=<RFC3339>&item_id=<id>`
  (also supports `milestone`)
- `GET /api/reports` — report kinds and paths.
- `GET /api/reports/<standup|sprint-health|refinement|planning|backlog|retrospective>?from=<RFC3339>&to=<RFC3339>&milestone=<name>&limit=<n>`
  — bounded evidence-based reports; the response keeps GitLab evidence and
  `human_context_overlay` separate.
- `GET /api/context?from=<RFC3339>&to=<RFC3339>&item_id=<id>&kind=<kind>`
  (also supports `limit`)
- `GET /api/context/<id>` — retained context revisions and secret-free audit metadata.
- `GET /api/sync/status`
- `GET /healthz`
- `GET /readyz`
- `POST /webhooks/gitlab` (optional)

Browser-only pull control routes include `GET /api/sync/csrf` and
`POST /api/sync`. The POST queues reconciliation and is not available through
the read-only machine credential.

Browser-only action routes include `/api/actions/status`,
`/api/actions/labels`, `/api/actions/labels/plan`, and
`/api/actions/labels/confirm`, plus the CSRF-token endpoint. Human-context
routes include browser-only `/api/context/plan`, `/api/context/confirm`,
`/api/context/redact/plan`, and `/api/context/redact/confirm`. These write
routes require a browser session and are not machine-API routes. Corrections use
`supersedes_id` on the context plan request; redaction is limited to configured
`FLUX_CONTEXT_REDACT_SUBJECTS`, or the author of the current revision when that
list is empty.

Build and run the CLI locally:

```sh
make build
./bin/flux today --input examples/today.json --json
./bin/flux changes --since 2026-01-01T00:00:00Z --json
./bin/flux history --item tokyo3/flux#12 --json
./bin/flux snapshot --at 2026-01-01T00:00:00Z --json
./bin/flux flow --from 2026-01-01T00:00:00Z --json
./bin/flux context --kind delay_explanation --json
./bin/flux standup --json
./bin/flux sprint-health --json
./bin/flux refinement --json
./bin/flux planning --json
./bin/flux backlog --json
./bin/flux retrospective --json
```

For an offline browser/API/Pi cockpit, run the explicit loopback-only fixture
server. It reloads the fixture file on every pull, uses a synthetic local
session, disables GitLab mutations, and does not require GitLab or OAuth
settings:

```sh
./bin/flux serve \
  --fixture examples/today.json \
  --addr 127.0.0.1:8080 \
  --state-dir .flux-fixture-state
```

Open `http://127.0.0.1:8080/`; the fixture login establishes a local test
session. Edit the fixture and press `Sync now` to create derived history. Use
`flux changes --state-dir .flux-fixture-state --json` to inspect it. Set
`FLUX_API_TOKEN` separately if testing the read-only machine API from Pi.
Fixture mode must bind to a loopback address.

Run the live server after configuring the required environment variables:

```sh
set -a; . ./.env; set +a
./bin/flux serve --addr 127.0.0.1:8080
```

For the container deployment:

```sh
cp .env.example .env
# Fill in the live GitLab, OAuth, and session settings; webhooks are optional.
docker compose -f compose.yml up --build -d
```

Live mode requires the group, read-only GitLab token, session key, and OAuth
settings. The webhook secret, write token, and Flux machine API credentials
are optional. `FLUX_RECONCILE_OVERLAP` and `FLUX_FULL_SCAN_INTERVAL` control
incremental/full pull behavior; `FLUX_HISTORY_RETENTION` controls local derived
history pruning and `FLUX_CONTEXT_RETENTION` controls human-context retention.
Fixture mode requires only the fixture file and a loopback address;
GitLab credentials are ignored and it generates an ephemeral session key when
one is not supplied. TLS should be terminated by a reverse proxy in
production.

## Development checks

```sh
make check
go test -race ./...
make build
node --check internal/web/static/app.js
docker compose -f compose.yml config
```
