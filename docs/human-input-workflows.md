# Human-input workflows

Flux should collect context that GitLab cannot authoritatively represent without
turning Flux into a second backlog or a personnel-management system. These
records are evidence for reports, not replacements for GitLab state.

## Boundaries

- Pi and machine credentials remain read-only.
- A browser session, CSRF protection, and an explicit confirmation are required
  to create or edit context.
- Context never changes a derived GitLab status, milestone, throughput count, or
  historical revision.
- AI may draft a proposed entry and ask a question; a human supplies and
  confirms the fact.
- Do not collect medical details, protected characteristics, performance
  ratings, blame, or speculative causal claims.

## First-class context types

1. **Incident** — an operational or delivery incident, its affected window,
   linked work items, impact, and current mitigation.
2. **Delay explanation** — a human-provided explanation for a late or blocked
   item, with an optional category such as dependency, review, environment,
   scope, or external decision.
3. **Scope change** — an accepted add/remove/defer decision, the responsible
   decision-maker, reason, and effective observation window.
4. **Capacity/holiday** — team availability or a non-working period. Store only
   the minimum aggregate capacity signal needed for planning; avoid individual
   attendance records.
5. **Decision/follow-up** — a decision, owner, due date, and link to the
   ceremony or source discussion.

Every entry should include a stable ID, kind, created/updated timestamps,
reporting window, author subject, concise statement, confidence (`confirmed`,
`reported`, or `proposed`), linked Flux item/entity keys, optional source links,
and an audit trail. `proposed` entries must not appear as confirmed facts.

## Lifecycle

```text
draft → submitted → confirmed → superseded/closed
                 ↘ rejected
```

- Pi can produce a draft from observed evidence and a human's answer.
- The browser displays the exact fields and affected report window before
  submission.
- Confirmation is one-time and records the authenticated subject, timestamp,
  and a content hash.
- Corrections append a new revision; do not overwrite the evidence needed to
  explain an earlier report.
- Retention should follow the history policy, with a shorter default for free
  text and an explicit deletion/redaction path for administrators.

## Proposed read/write surface

The first implementation can use an append-only context log alongside the
history log, then move to SQLite with the same model:

- `GET /api/context?from=&to=&item_id=&kind=` — browser and machine read view.
- Browser-only `POST /api/context/plan` — validate and display a proposed entry.
- Browser-only `POST /api/context/confirm` — CSRF- and approval-gated append.
- `GET /api/context/{id}` — revisions and audit metadata.

Machine/API and Pi responses should include `coverage`, `provenance`, and
`uncertainties`, and distinguish human-reported context from Flux-observed
changes. Context should be joined into standup, planning, and retrospective
reports only as an explicitly labeled overlay.

## Recommended first slice

Start with **delay explanations and scope changes**. They answer the most
useful retrospective questions while keeping the data model small. Validate
field minimization, correction/redaction, and report wording with the team
before adding incidents or capacity signals. Do not add capacity forecasting
or individual-level analytics until the team has explicitly agreed on policy.
