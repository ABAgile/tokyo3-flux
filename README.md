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
- A label action dialog that follows a dry-run-then-confirm workflow.

Alternate milestone views are fetched on demand and never change the shared
cached snapshot. They do not expose mutation controls.

### Authentication and security boundaries

- Human browser access uses GitLab OAuth Authorization Code + PKCE and sealed
  Flux sessions.
- `/api/today` and related read views may use a scoped `FLUX_API_TOKEN` Bearer
  credential, limited to `GET` and `HEAD`.
- `FLUX_API_TOKEN` authenticates Pi to Flux; it is not a GitLab credential.
- Pi tools and machine API access are read-only.
- Browser action routes require a human session and CSRF protection; machine
  Bearer credentials are rejected there.
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

- Background reconciliation defaults to every five minutes.
- Validated GitLab webhook events can trigger an earlier refresh.
- The default durable state directory is `/var/lib/flux`.
- Snapshot, webhook-event, and action-audit data are stored locally as small
  atomic/append-only files.
- A failed refresh does not replace the last valid snapshot.
- HTTP proxy environment variables are honored by Go's default transport.

## Pi integration

The project-local extension is `.pi/extensions/flux.ts`. It registers six
bounded, read-only tools:

- `flux_today` — complete machine-readable current status.
- `flux_sprint_status` — compact sprint health and risks.
- `flux_triage` — items needing attention and suggested next checks.
- `flux_standup` — factual current-status standup.
- `flux_review_queue` — open merge requests needing review.
- `flux_pipeline_failures` — open merge requests with failed pipelines.

Pi uses the authenticated Flux API when both `FLUX_API_URL` and
`FLUX_API_TOKEN` are set. Otherwise it falls back to `flux today --json` via
`FLUX_CLI` or the `flux` executable on `PATH`. Pi should receive only Flux API
credentials, never the server's GitLab service or write token.

The current standup and agent views describe current GitLab signals. Historical
"since yesterday", retrospective metrics, capacity planning, and AI-generated
backlog decisions require additional history and human input and are outside
the current implementation.

The intended AI control model is:

```text
observe → explain → propose → human approval → apply → reconcile
```

Pi can summarize and reason over Flux data, but it cannot approve an action.
Future ceremony support should add history, team-entered context, and explicit
proposals before adding any new mutation types.

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
- `GET /healthz`
- `GET /readyz`
- `POST /webhooks/gitlab`

Browser-only action routes include `/api/actions/status`,
`/api/actions/labels`, `/api/actions/labels/plan`, and
`/api/actions/labels/confirm`, plus the CSRF-token endpoint. The action routes
require a browser session and are not machine-API routes.

Build and run the CLI locally:

```sh
make build
./bin/flux today --input examples/today.json --json
```

Run the server locally after configuring the required environment variables:

```sh
set -a; . ./.env; set +a
./bin/flux serve --addr 127.0.0.1:8080
```

For the container deployment:

```sh
cp .env.example .env
# Fill in the GitLab, OAuth, session, and webhook settings.
docker compose -f compose.yml up --build -d
```

The server requires the group, read-only GitLab token, webhook secret, session
key, and OAuth settings. The write token and Flux machine API credentials are
optional. TLS should be terminated by a reverse proxy in production.

## Development checks

```sh
make check
go test -race ./...
make build
node --check internal/web/static/app.js
docker compose -f compose.yml config
```
