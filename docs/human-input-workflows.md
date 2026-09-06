# Human-input workflows

Flux collects context that GitLab cannot authoritatively represent without
turning Flux into a second backlog or a personnel-management system. These
records are evidence for reports, not replacements for GitLab state.

## Boundaries

- Pi and machine credentials remain read-only.
- A browser session, session-bound CSRF protection, and an explicit confirmation
  are required to create, correct, or redact context.
- Context never changes a derived GitLab status, milestone, throughput count, or
  historical revision.
- A plan is labeled `proposed` and is held in memory for ten minutes. Only the
  authenticated actor who created it can confirm it, and confirmation consumes
  the plan once.
- AI may draft an entry and ask a question; a human supplies and confirms the
  fact. AI cannot confirm, correct, or redact it.
- Do not collect medical details, protected characteristics, performance
  ratings, blame, or speculative causal claims.

## First-class context types

The first implemented slice is deliberately small:

1. **Delay explanation** — a human-provided explanation for a late or blocked
   item, with a category such as dependency, review, environment, scope,
   external decision, or other.
2. **Scope change** — an accepted add/remove/defer decision, optional decision
   owner, reason, and effective date/window.

Incident, capacity/holiday, and decision/follow-up records remain future types.
Do not add individual attendance, medical, protected-characteristic, or
performance data to those future workflows.

Every confirmed entry has a stable ID, revision, kind, timestamps, reporting
window, authenticated author subject, concise statement, `confirmed` status and
confidence, optional linked Flux item keys, optional milestone, and optional
HTTP(S) source links. A content hash is retained for audit correlation. The
write validator bounds all free-text, IDs, URLs, and list sizes.

## Lifecycle and corrections

```text
plan (proposed) → confirm (confirmed) → correct (new revision)
                                      ↘ redact (redacted)
```

- The browser displays the exact normalized fields, operation, reporting window,
  and expiry before confirmation.
- Confirmation records the authenticated subject, timestamp, operation, and
  content hash in a secret-free audit log.
- A correction submits `supersedes_id` and appends the next revision under the
  same stable context ID. Earlier revisions remain available for explanation.
- A redaction is also planned and confirmed in the browser. It appends a
  redacted revision, scrubs retained free-text fields and source links from all
  retained revisions for that ID, and preserves only operation metadata plus a
  one-way original content hash in the audit log.
- Redaction is allowed for the current revision's author by default. Set
  `FLUX_CONTEXT_REDACT_SUBJECTS` to a comma-separated allow-list of OAuth
  subject IDs for an administrator-controlled redaction policy.
- Redaction and retention are the intentional exceptions to ordinary
  append-only context storage: redaction rewrites the target record so the
  removed text is not left in `context.jsonl`.

## Storage and retention

The initial single-process backend is an append-only `context.jsonl` alongside
`context_audit.jsonl`. State is derived locally; GitLab remains authoritative.
`GET /api/context/{id}` returns retained revisions and secret-free audit
metadata, not pending plans.

Human context uses `FLUX_CONTEXT_RETENTION`, independently of derived history,
with a 90-day server default (`2160h`). Set it to `0` to retain it indefinitely.
Pruning removes records and audit events older than the configured window and
reports the retained boundary and uncertainty in `coverage`. This policy is a
controlled deletion boundary for free text; it does not change GitLab data or
Flux's derived history.

## API and CLI surface

Read-only routes are available to browser sessions and valid `FLUX_API_TOKEN`
machine credentials:

- `GET /api/context?from=&to=&item_id=&kind=&limit=` — latest confirmed entry
  per context ID, with `coverage` and uncertainties. Reporting windows overlap
  the query window; `to` is exclusive.
- `GET /api/context/{id}` — retained revisions and audit metadata for one ID.

Browser-only write routes are protected by the authenticated session and a
context-specific CSRF token:

- `GET /api/context/csrf`
- `POST /api/context/plan`
- `POST /api/context/confirm`
- `POST /api/context/redact/plan`
- `POST /api/context/redact/confirm`

`POST /api/context/plan` accepts the two context kinds and optional
`supersedes_id` for corrections. Redaction plans accept `context_id`. Machine
Bearer credentials are rejected by the browser session gate, even though
machine credentials may read confirmed context.

The read-only CLI equivalent is:

```sh
flux context --kind delay_explanation --json
flux context --item tokyo3/flux#12 --json
```

The Pi `flux_context` tool uses the authenticated read API when configured and
falls back to `flux context --json`. It never sends a GitLab credential and
cannot invoke a write route.

## Reporting use

`GET /api/reports/<kind>` and the matching read-only CLI/Pi report views join
confirmed context into standup, sprint-health, planning, refinement, backlog,
or retrospective output only as an explicitly labeled **human-reported
overlay**. Keep GitLab-derived status, counts, timestamps, and Flux-observed
changes separate. A confirmed statement is not independently verified cause
evidence; reports must preserve the as-of time, window, coverage, provenance,
truncation, and uncertainties and must not infer blame or performance.

The report kinds are `standup`, `sprint-health`, `refinement`, `planning`,
`backlog`, and `retrospective`. Report windows use an inclusive `from` and
exclusive `to`; an omitted window is bounded relative to the current snapshot.
The CLI reads its locally reconciled snapshot, while the authenticated API can
fetch a selected milestone view on demand without changing the cached snapshot.
