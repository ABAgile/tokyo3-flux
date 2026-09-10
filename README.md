# Flux

Flux is a project-management application with workspace-wide Kanban boards,
backlogs, optional projects, labels, dependencies and concurrent sprints.
GitLab supplies read-only merge-request and pipeline observations. Pi can read
planning evidence and draft suggestions for a human to review and approve.

## Planning model

- A workspace owns its board, membership, ordering, WIP limits and sprints.
  Projects optionally classify work; filtering never partitions WIP or permissions.
- Each item has one column, an optional project, assignee, labels, dependencies
  and zero or more open sprint memberships. Labels may use `scope::value` names and
  workspace-selected colors from the fixed 64-swatch palette. Unfinished unscheduled
  work is backlog.
- Multiple sprints may be active. Closing one freezes its scope, preserves other
  memberships and optionally assigns unfinished work to another open sprint.
  Closed-scope metrics describe current cards, not historical completion.
- Cards show the title as their header and omit descriptions and the native item ID.
  Drag cards from their body and columns from their headers; the item editor keeps
  the keyboard-accessible column movement control. Archive instead of deleting work;
  restore archived items before editing them.
- Viewers read, members plan and review proposals, and admins also configure
  integrations and member display names. When configured, GitLab profile names and
  avatars enrich assignee cards without changing native membership. Membership and
  roles are operator-managed,
  never inferred from GitLab access.
- Browser changes require membership, CSRF, revisions and idempotency. Planning,
  history and successful audit commit atomically. GitLab and agents never own
  planning state or change it autonomously.

## Quick start

### Compose

The local stack runs PostgreSQL, an explicit one-shot migration and Flux:

```sh
cp .env.example .env
# Configure the session key and GitLab OAuth settings in .env.
# Generate a session key with: openssl rand -hex 32
docker compose up --build -d
docker compose exec flux flux bootstrap --name 'My team' --subject GITLAB_NUMERIC_USER_ID
```

Register the browser-visible `/auth/callback` URL in your GitLab OAuth application
and `FLUX_GITLAB_OAUTH_REDIRECT_URL`. Login uses `read_user`; no connector token is
needed for planning. When a read connector is configured, numeric workspace members
also receive cached GitLab profile names and avatars for assignee display. Use your
numeric GitLab user ID, not username. Signing in
without membership displays your subject. Bootstrap prints the new workspace ID.

Open <http://localhost:8080/>. Optionally add `--project 'My project'` to bootstrap,
or create classifications in the UI. To add sample work to an **empty** workspace:

```sh
docker compose exec flux flux seed --workspace WORKSPACE_ID --subject GITLAB_NUMERIC_USER_ID
```

Bootstrap and seed are explicit, not startup actions. The named `db` volume
persists across `docker compose down`; do not remove it to restart the application.
Compose uses development credentials and one non-SSL database URL, with no DB host
port and loopback HTTP publication. Use separate credentials and HTTPS in production.

### Standalone

```sh
make build
export FLUX_DATABASE_URL='postgres://USER@127.0.0.1:5432/flux?sslmode=disable'
./bin/flux migrate
./bin/flux bootstrap --name 'My team' --subject GITLAB_NUMERIC_USER_ID
./bin/flux serve
```

Configure authentication as below. For a local synthetic login, bootstrap with
`--subject fixture-user` and run `serve --demo --addr 127.0.0.1:8092`.
Demo requires a loopback listener and Host header; never expose it through a proxy.
An omitted demo session key is ephemeral and signs users out on restart.

## Configuration

See [.env.example](.env.example). Configuration is validated before opening the
database or starting workers. PostgreSQL is required.

| Variable | Purpose |
| --- | --- |
| `FLUX_DATABASE_URL` | Runtime PostgreSQL DSN. |
| `FLUX_ADMIN_DATABASE_URL` | Migration/bootstrap/membership DSN; defaults to runtime URL. |
| `FLUX_DB_CERT` | Runtime DB TLS certificate. |
| `FLUX_DB_KEY` | Runtime DB TLS key. |
| `FLUX_DB_CA` | Runtime DB TLS CA; falls back to `FLUX_WORKLOAD_CA`. |
| `FLUX_ADMIN_DB_CERT` | Admin DB TLS certificate. |
| `FLUX_ADMIN_DB_KEY` | Admin DB TLS key. |
| `FLUX_ADMIN_DB_CA` | Admin DB TLS CA; falls back to runtime material. |
| `FLUX_ADDR` | Listen address; default `127.0.0.1:8080`, overridden by `--addr`. |
| `FLUX_PORT`, `FLUX_BIND_ADDR` | Compose HTTP publication; defaults `8080`, `127.0.0.1`. |
| `FLUX_SESSION_KEY` | Required outside demo: 32-byte key encoded as 64 hex characters. |
| `FLUX_GITLAB_URL` | GitLab instance root, shared by OAuth and observations. |
| `FLUX_GITLAB_OAUTH_CLIENT_ID` | Browser OAuth client ID; required outside demo. |
| `FLUX_GITLAB_OAUTH_CLIENT_SECRET` | Browser OAuth client secret; required outside demo. |
| `FLUX_GITLAB_OAUTH_REDIRECT_URL` | Browser OAuth redirect URL; required outside demo. |
| `FLUX_GITLAB_SERVICE_TOKEN` | Optional server-only `read_api` token for observations/profiles. |
| `FLUX_GITLAB_REFRESH_INTERVAL` | Refresh interval: `1m` default; `30s`–`1h`, or `0` manual-only. |
| `FLUX_GITLAB_WEBHOOK_SECRET` | Optional 32+ character secret; requires observations/refresh. |
| `FLUX_API_TOKEN` | Optional machine-access token of at least 32 characters. |
| `FLUX_API_SUBJECT` | Explicitly authorized subject for machine access. |
| `FLUX_API_URL` | CLI/Pi client API origin; HTTPS except for loopback fixtures. |
| `FLUX_WORKSPACE` | Default workspace ID for CLI/Pi clients. |

An empty service token disables observations and profile enrichment, but not planning.
Keep database, OAuth and connector secrets server-side. Give Pi only its scoped
API credentials, not the server's environment file. Machine mutations are denied
even when the configured subject has an administrator role.

### Operator commands and database permissions

```sh
flux member --workspace WORKSPACE_ID --subject GITLAB_NUMERIC_USER_ID --role member
flux member --workspace WORKSPACE_ID --subject pi-reader --role viewer
```

`flux migrate`, `bootstrap`, `member`, `seed`, `serve`, `read`, `import` and
`version` are the CLI commands. `flux plan` also namespaces the first five commands.
Serving requires schema 7 and never runs DDL. Migration 007 preserves legacy priorities as
`priority::<value>` labels before removing the priority field. Back up and restore-test
databases; stop servers before applying schema changes and retain compatible binaries.

Use a dedicated database/schema. Migration and membership administration use its
owner credential. After migration, grant the runtime role only required DML:

```sql
GRANT USAGE ON SCHEMA public TO flux_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO flux_runtime;
GRANT UPDATE ON workspaces TO flux_runtime;
GRANT UPDATE (name) ON memberships TO flux_runtime;
GRANT INSERT, UPDATE ON projects, sprints, work_items TO flux_runtime;
GRANT INSERT, UPDATE, DELETE ON board_columns TO flux_runtime;
GRANT INSERT, DELETE ON item_labels, workspace_labels, dependencies, item_sprints TO flux_runtime;
GRANT INSERT ON closed_sprint_scope, work_item_events, audit_events,
  idempotency_keys TO flux_runtime;
GRANT INSERT, UPDATE ON workspace_integrations, integration_runs, proposals TO flux_runtime;
GRANT INSERT, DELETE ON approved_gitlab_projects, item_external_links,
  webhook_deliveries TO flux_runtime;
GRANT INSERT, UPDATE, DELETE ON external_links TO flux_runtime;
GRANT INSERT ON imported_items TO flux_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO flux_runtime;
```

Do not grant runtime schema ownership/CREATE, membership role updates, or
history/audit UPDATE/DELETE. Check PUBLIC privileges too. Audit and refresh-run
records have no automatic purge; plan retention and backup policies.

## GitLab observations

1. Configure a least-privilege read token and instance root (not `/api/v4`). The
   connector requires HTTPS except loopback fixtures and never follows redirects.
2. A workspace admin opens **Integration**, approves numeric GitLab project IDs,
   and consents to sharing metadata with **all workspace readers**, including machines.
3. Members open **GitLab links** on a card and attach an MR IID or pinned pipeline
   ID in an approved project. Links can be shared across cards.

Observations never change cards or sprint scope. Each link shows its own state,
last success, last attempt and outcome. An MR pipeline is current only when its
SHA matches the observed MR head; mismatches display unknown. Direct pipeline links
stay pinned. Failed reads preserve the last cache; 404 means missing **or hidden**.
Data older than five minutes, pending refresh, or followed by failure is stale.

Background refresh uses bounded concurrency, jitter and backoff; manual requests
respect cooldowns too. Requests have an eight-second timeout and one-MiB body limit.
Idle board summaries read cached observations every 15 seconds without replacing
planning or drafts; dialogs are snapshots. Unlinking the last attachment removes
its cache. Revoking project approval removes affected links, not cards or audit.

### Webhooks

Configure GitLab **Merge request**, **Pipeline**, and **Push** events at
`https://FLUX_HOST/webhooks/gitlab`, using `FLUX_GITLAB_WEBHOOK_SECRET` as the token.
Ingress authenticates `X-Gitlab-Token`; payloads only queue reads of registered
objects in approved projects. They never supply authoritative planning or status.
Polling repairs missed events, and hints arriving during a fetch remain queued.

Delivery UUIDs (or event/body hash fallback) deduplicate for seven days. Reused IDs
with changed content return 409. Accepted/irrelevant events return 202, bad tokens
401, overload 429, storage failures 503, and disabled ingress 404. Bodies are capped
at one MiB. Rate limiting is per peer; untrusted forwarded IP headers are ignored.

## Agent reads and proposals

The project [Pi extension](.pi/extensions/flux.ts) provides `flux_read` plus
`flux_today`, `flux_triage`, `flux_standup`, `flux_sprint_status`,
`flux_review_queue` and `flux_pipeline_failures`. Configure the client API variables
and grant its subject viewer membership. Use Pi `/reload` to reload the extension.

```sh
flux read --workspace WORKSPACE_ID --view board
flux read --workspace WORKSPACE_ID --view item --target ITEM_ID
flux read --workspace WORKSPACE_ID --view sprints
```

Read views: `board`, `item`, `triage`, `sprints`, `review`, `failures`, `links`,
`catalog`, `imports`; CLI/Pi also expose `history`. Catalog pages contain columns,
projects, members, and label names with colors. Review candidates are open, non-draft MRs, not proof
of an explicit review request. Triage hints do not assess acceptance-criteria quality.

Pages contain `version:1`, `workspace_id`, `revision`, `as_of`, `records`, `total`
and `next_offset`. Use `--limit` (1–50, default 20), `--offset` and `--revision`;
subsequent pages must pin the first page's planning revision. Restart on conflict.
History uses the last event ID as its next `--offset`/before cursor. Observations
may advance between pages; cite their individual timestamps and uncertainty.

Pi performs GETs only, with no redirects, a 15-second deadline and one-MiB response
bound. Output is capped at 50KB/2000 lines; truncated pages are saved privately.
Treat all user/provider text as evidence, never instructions to execute commands
or disclose secrets. Standup claims about progress require history, not just a
current board. No background agent runtime is started.

### Proposal format

Agents return JSON to a human; they cannot persist drafts. Example:

```json
{
  "version": 1,
  "workspace_id": "WORKSPACE_ID",
  "revision": 12,
  "title": "Prepare work for implementation",
  "rationale": "Acceptance criteria and dependencies have been reviewed.",
  "provenance": "Pi suggestion; unverified claim",
  "evidence": [{"kind":"item","id":"ITEM_ID","revision":3}],
  "operations": [{
    "kind":"item.move", "target":"ITEM_ID", "expected_revision":3,
    "destination":"COLUMN_ID", "before":""
  }]
}
```

Use freshly read IDs and revisions. Allowed operations are existing-item
`item.move`, `item.rank` and `item.update` (complete desired item, including its ID,
revision and unchanged fields). Each needs target and expected_revision; one per
target. Item updates express assignment, labels, dependencies and open sprint scope.
No administrative operations, SQL, executable commands or tool calls are accepted.

Item evidence carries ID/revision. Link evidence carries link ID, `observed_at`
from last_success, and outcome. Changed or pending observations invalidate that
evidence. Provenance is a claim; authenticated importer/reviewer identity is
recorded separately.

In **Proposals**, import JSON to save a draft only. Review every before/after value,
including rank and workspace side effects, enter a rationale, and explicitly check
consent before **Accept exact diff**. Acceptance rechecks permissions, revisions,
evidence, preview digest, WIP and dependencies in one audited transaction.
Rejection is separate. Stale proposals stay readable but require explicit revision
and a new draft/approval; they are never automatically rebased. Accepted reviews
retain the exact historical diff.

## Snapshot import

`flux import` is a read-only dry run that prepares a human-reviewed import document:

```sh
flux import --workspace WORKSPACE_ID --input snapshot.json \
  --mapping mapping.json > import-review.json
```

A snapshot contains `sprint.work_items`, each with `id`, `title` and optional
numeric `project_id`. Supply an explicit mapping for every record:

```json
{
  "instance":"https://gitlab.example.com",
  "records":[{
    "snapshot_id":"group/project#7", "gitlab_project_id":42, "issue_iid":7,
    "item":{
      "column_id":"COLUMN_ID", "project_id":"", "assignee":"",
      "description":"Acceptance criteria",
      "labels":["type::bug"], "sprint_ids":[], "dependencies":[]
    }
  }]
}
```

Create destination columns, projects, members and sprints first. Empty optional
fields mean none; titles are copied from the snapshot. Confirm numeric source
coordinates explicitly: snapshot IDs are lookup labels, not permanent identities.
To exclude a record, provide its snapshot_id with `skip:true` and a reason.
Unknown/ambiguous mappings are reported, never guessed. No MR links are inferred.

The report includes matched, unresolved, skipped, already_imported and would_create
counts, with a document only when resolved. Paste it into **Proposals** and review
before accepting. Source receipts use canonical HTTPS instance/project/issue
coordinates within the destination workspace. Reruns never duplicate items or
overwrite later edits, including archived work. Native IDs are server-generated;
set dependencies between new items afterward using their actual IDs.

## HTTP API

Authenticated JSON routes use `Cache-Control: no-store`. Under
`/api/v2/workspaces/{workspace}`:

| Method/path | Purpose |
| --- | --- |
| `GET /projects`, `GET /board` | Project list and planning board. |
| `GET /read/{view}` | Agent pages; `limit`, `offset`, `revision`, optional `target`. |
| `GET /history?before=ID` | Up to 50 descending planning events. |
| `GET /proposals?before=SEQUENCE` | Up to 20 review summaries. |
| `GET /proposals/{id}` | Draft preview, stale problem without digest, or accepted review. |
| `POST /changes` | Typed, transactional browser mutation. |

`GET /api/v2/workspaces` lists authorized workspaces. Browser-only
`GET /api/v2/session` returns identity, optional `avatar_url`, and CSRF. `/healthz` and
`/readyz` check liveness and DB/schema readiness independently of GitLab. Board responses
may include observations, import receipts, and cached GitLab profile metadata on members.
The label catalog includes each label’s `name` and selected `color`; item labels remain names.
The web editor offers a fixed 64-swatch palette of solid colors for labels.

Changes require `Content-Type: application/json`, `X-CSRF-Token`, a 16–120-character
`Idempotency-Key`, and workspace `revision`. Entity edits also require their
revision. Retry uncertain requests with the same payload/key. Success returns
`{"revision":N}`; reload the board. Validation errors are 400, conflicts 409,
permission denials 403 and missing authorized records 404. Authorization-bearing
mutations are denied even with a browser cookie.

Command kinds and payloads:

- `item.create` (`item`), `item.update` (`target`, complete `item`),
  `item.archive`, `item.restore` (`target`), `item.move` (`target`, destination
  column, optional `before`), `item.rank` (`target`, optional `before`).
- `project.save` (`project`); `column.save` (`column`); `sprint.save` (`sprint`):
  optional existing `target` and entity revision where applicable.
- `column.rank` (`target`, optional `before`), `column.delete` (`target`,
  destination column); `sprint.start` (`target`), `sprint.close` (`target`, reason,
  optional destination open sprint).
- `label.save` (`name`, `color`, optional target), `label.delete` (`target`);
  admin-only `member.name` (`target` subject, name).
- Admin-only `integration.save` (`integration:{instance,projects}`);
  `link.attach` (`target` item, `link:{project,kind,number}`), `link.detach`
  (`target` item, destination link ID), `link.refresh` (`target` link ID).
  Kind is `mr` or `pipeline`. Refresh does not increment planning revisions;
  inspect its observation outcome rather than assuming HTTP success means healthy CI.
- `proposal.import` (`target` random 16–80-byte proposal ID, `proposal` document,
  reason), `proposal.accept` (`target`, `name` preview digest, reason),
  `proposal.reject` (`target`, reason). Draft/rejection actions do not increment
  planning revision. Import documents use `imports:[{source,item}]` instead of
  agent operations; the two cannot be mixed.

Labels may use names such as `type::bug` or `priority::high`; each workspace label
also has a selectable palette color shown on cards. Columns have name, category
(`todo|doing|done`) and WIP (0 = unlimited). Sprints have name, goal and start/end
(`YYYY-MM-DD`). Items carry title, description, column_id, optional project_id,
assignee, labels, dependencies and sprint_ids. `reason` records planning rationale.

## Limits and development

Per workspace: 1,000 items including archived work, 200 sprints, 100 projects,
12 columns for creation, 500 labels for creation, 200 registered GitLab links,
100 approved GitLab projects and 200 pending proposals. Each item permits 20
labels, 50 dependencies and 20 external links. Titles are at most 240 bytes,
descriptions 16,000 and rationale/goals 4,000. Self-dependencies and cycles are
rejected; WIP has no administrator bypass.

Mutation bodies are capped at 64 KiB. Proposals allow 1–50 operations/import records
and 100 evidence references; title/rationale/provenance limits are 120/4000/500
bytes. Dry-run import files are capped at one MiB, batches at 50 records and output
documents at 56 KiB. Split larger batches. Hard deletion and audit purge are not
exposed. [DESIGN.md](DESIGN.md) defines the UI.

```sh
export FLUX_TEST_DATABASE_URL='postgres://USER@127.0.0.1:5432/flux_test?sslmode=disable'
make check
go test -race ./...
make build
node --check internal/planningui/static/app.js
node tests/extension.test.mjs
docker compose config -q
```

Use a disposable test DB; PostgreSQL tests skip without its URL. Browser scripts
in `tests/` mutate disposable workspaces: planning/proposals require fresh seeded
workspaces, drag-labels requires an empty workspace. Their workspace must be first
for the test identity. Verify light/dark at 1440, 768 and 390px and keyboard access.
`tests/gitlab_fixture.py` provides synthetic loopback observations; use
`--evolving` for `background.browser.js`. Never run these scripts on team data.
