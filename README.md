# Flux

Flux is becoming a standalone, agent-assisted project-management and Kanban
system. Flux will own the team's work items, boards, sprint state, and planning
workflow in its own datastore.

GitLab is not the system of record for Flux planning. GitLab is an external
engineering integration used to observe the merge-request and pipeline status
of Flux work items.

## Product direction

The target model is:

```text
Flux datastore
  ├── work items and descriptions
  ├── boards, columns, and card ordering
  ├── backlog and sprint membership
  ├── sprint goals, scope, and status
  ├── assignments, labels, dependencies, and decisions
  └── Flux-owned change history and audit events

GitLab integration
  ├── linked merge-request status
  ├── linked pipeline status
  └── external URLs and engineering metadata
```

Flux work items are native Flux records. A work item does not require a
GitLab issue or GitLab milestone. A merge request or pipeline may be linked to
one or more Flux work items, and its observed status is supplementary
engineering information.

The target Flux planning model does **not** use any of the following as its
scope or authority:

- GitLab groups
- GitLab milestones
- GitLab issues
- GitLab issue boards

The GitLab connector may retain the minimum project and external-reference
coordinates needed to locate a linked merge request or pipeline. Those
coordinates do not define Flux projects, boards, sprints, backlog scope, or
status.

## Authority boundaries

Flux owns and writes:

- Work-item content and lifecycle state
- Board columns, WIP policy, and card ordering
- Sprint creation, goals, dates, membership, and scope
- Assignments, Flux labels, dependencies, and planning decisions
- Flux-native history and audit records

GitLab supplies read-only integration signals:

- Merge-request state and review metadata
- Pipeline state for linked merge requests
- Links to the relevant GitLab engineering objects

A GitLab pipeline failure or merge-request change must not silently overwrite a
Flux column or sprint state. Any automation policy that reacts to an external
signal must be explicit, auditable, and owned by Flux.

Pi and machine credentials remain read-only by default. Browser writes to Flux
planning state will require authenticated sessions, CSRF protection,
permission checks, optimistic-concurrency checks, and audit events. AI may
summarize, identify missing information, or prepare a proposal; an authorized
human accepts planning changes.

## Target Kanban and sprint workflow

Flux is intended to support both continuous Kanban flow and time-boxed sprints:

- Work items may exist in the backlog without a sprint.
- Boards define configurable columns and ordering.
- Moving a card changes Flux state, not GitLab issue state.
- Sprints have their own goal, dates, membership, scope decisions, and
  carry-over behavior.
- Planning uses Flux work items and Flux-owned priorities; it does not select
  a GitLab milestone.
- MR and pipeline signals appear on linked cards as engineering status.
- Ceremony views read Flux planning state and external GitLab observations
  without treating GitLab as the planning authority.

The first database-backed planning slice should cover work-item CRUD, board
columns and ordering, sprint membership, external MR/pipeline links, and
transactional audit history before adding broader automation.

## Datastore direction

The planning datastore will be separate from GitLab and separate from the
transitional snapshot files. It should provide transactions, foreign keys,
concurrent updates, ordering, filtering, migrations, and durable audit data.

PostgreSQL is the intended production backend. SQLite may be supported for
local development or single-user fixtures. The storage boundary should be
implemented behind repositories so the domain does not depend on a particular
backend.

The future model should distinguish at least:

```text
work_item_events       Flux planning-state changes
external_observations  GitLab MR/pipeline observations
integration_runs       optional connector health and pull metadata
audit_events           who changed what, when, and with what outcome
```

These are different concerns. GitLab observations must not become the source
of truth for Flux sprint state.

## Migration from the current implementation

The checked-in application is a transitional GitLab-derived cockpit. It still
contains the earlier snapshot, milestone, issue, and periodic GitLab polling
model so the existing application can build and run while the new planning
core is designed.

That transitional model is not the target architecture. In particular, the
following are scheduled to be replaced or retired:

- GitLab milestone selection as the sprint model
- GitLab issues as Flux work items
- GitLab issue-board semantics
- GitLab-driven status derivation
- GitLab label mutation as the planning write path
- The current JSON snapshot as the authoritative sprint state

Migration should be explicit:

1. Define the Flux-owned domain and database schema.
2. Import useful existing work items as Flux records, without treating GitLab
   milestones or issues as their permanent identity.
3. Create explicit links for merge requests and pipelines.
4. Run the new board and sprint views in comparison with the transitional
   cockpit.
5. Cut over planning writes to Flux and make GitLab synchronization read-only.
6. Remove the transitional milestone, issue, board, and polling dependencies.

The removed human-context and ceremony-report implementation is not being
carried forward as a JSONL contract. Any future human-supplied context must be
designed against the Flux-owned datastore and its permission, audit, retention,
and reporting requirements.

## Current transitional application

The current application provides a small authenticated GitLab status cockpit
and read-only Pi views. It is useful for migration and integration testing, but
it is not yet a standalone project-management system.

Current transitional behavior includes:

- A cached GitLab-derived snapshot
- Active GitLab milestone and issue aggregation
- Merge-request and pipeline joins
- Optional browser-approved GitLab label action
- A responsive cockpit and read-only machine API
- A fixture mode for offline development

Do not build new planning features by extending the transitional snapshot
model. New sprint and Kanban behavior belongs in the Flux-owned domain and
separate datastore.

## Pi integration

The project-local extension is `.pi/extensions/flux.ts`. Its current
transitional tools are bounded and read-only:

- `flux_today` — current GitLab-derived status
- `flux_sprint_status` — current status and attention signals
- `flux_triage` — items needing attention
- `flux_standup` — current-status summary
- `flux_review_queue` — merge requests needing review
- `flux_pipeline_failures` — merge requests with failed pipelines

The future Pi interface should read Flux-owned boards, work items, and sprints,
then show linked GitLab MR/pipeline observations. Pi should not receive GitLab
service or write credentials and should not directly change Flux planning state.

## Current API and CLI

The following routes and commands belong to the transitional implementation
and will be replaced as the Flux-owned planning API is introduced:

- `GET /api/today`
- `GET /api/milestones`
- `GET /api/sync/status`
- `GET /healthz`
- `GET /readyz`
- `POST /webhooks/gitlab` (optional)
- `POST /api/sync` (browser-only pull control)
- `flux today --input examples/today.json --json`

The target API will be organized around Flux workspaces, boards, work items,
and sprints rather than GitLab groups, milestones, issues, or issue boards.

## Local development

Build the current transitional application:

```sh
make build
./bin/flux today --input examples/today.json --json
```

Run the offline cockpit:

```sh
./bin/flux serve \
  --fixture examples/today.json \
  --addr 127.0.0.1:8080 \
  --state-dir .flux-fixture-state
```

Open `http://127.0.0.1:8080/`. Fixture mode uses a local session, does not
require GitLab or OAuth settings, and must bind to a loopback address.

Live transitional mode requires the current GitLab and OAuth configuration.
Those settings are temporary integration requirements and are not the target
Flux planning contract.

## Development checks

```sh
make check
go test -race ./...
make build
node --check internal/web/static/app.js
docker compose -f compose.yml config
```
