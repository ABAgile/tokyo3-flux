// Proposal review: list, import, review and reject.
import { $ } from './dom.js';
import { api, requestKey } from './api.js';
import {
  emptyStateTemplate,
  errorLineTemplate,
  fieldTemplate,
  helpTextTemplate,
} from './layout.js';
import { html, nothing } from './preact.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { writable, accessButtonTemplate } from './permissions.js';
import { notice } from './notices.js';
import { openEditor } from './dialog.js';

export async function showProposals(before = 0) {
  if (!state.board || state.busy || state.loading) return;
  const currentRoot = state.root;
  try {
    const rows = await api(currentRoot + '/proposals?before=' + before);
    if (state.root !== currentRoot || state.busy) return;
    $('editor').close();
    openEditor(
      'Planning proposals',
      () => html`${helpTextTemplate(
        'Agent output is an unverified suggestion. Importing creates a draft only; a human must review the exact diff before any planning changes.',
      )}
        ${accessButtonTemplate('Import proposal or migration JSON', () => importProposal(), {
          tracked: false,
        })}
        ${rows.length ? nothing : emptyStateTemplate('No proposals on this page.')}
        ${rows.map(
          (row) => html`<article class="setup-row">
            <strong>${row.title}</strong>
            <p class="muted">
              ${`${row.state} · Imported by ${row.imported_by} · workspace revision ${row.revision}`}
            </p>
            <button type="button" onClick=${() => reviewProposal(row.id)}>${`Review ${row.title}`}</button>
          </article>`,
        )}
        ${
          rows.length === 20
            ? html`<button type="button" onClick=${() => showProposals(rows.at(-1).sequence)}
                >Older proposals</button
              >`
            : nothing
        }
        ${
          before
            ? html`<button type="button" onClick=${() => showProposals()}>Newest proposals</button>`
            : nothing
        }`,
      () => ({}),
      true,
    );
  } catch (e) {
    notice(e.message, true);
  }
}
function importProposal(document) {
  $('editor').close();
  const id = requestKey();
  openEditor(
    'Import proposal draft',
    () => html`${helpTextTemplate(
      'Paste a version-1 proposal or the document/report from flux import. This saves a draft, not planning changes. Source identity and agent provenance are not verified.',
    )}
      ${fieldTemplate(
        'document',
        'Proposal JSON',
        document ? JSON.stringify(document, null, 2) : '',
        'textarea',
        undefined,
        { required: true, maxLength: 60000 },
      )}
      ${fieldTemplate('reason', 'Import rationale', '', 'textarea', undefined, { required: true })}`,
    (data) => {
      const parsed = JSON.parse(data.get('document'));
      if (parsed.unresolved?.length)
        throw new Error('Resolve all import mappings before creating a draft.');
      return {
        kind: 'proposal.import',
        target: id,
        proposal: parsed.document || parsed,
        reason: data.get('reason').trim(),
      };
    },
  );
  $('save').textContent = 'Save draft only';
}
async function reviewProposal(id) {
  const currentRoot = state.root;
  try {
    const preview = await api(currentRoot + '/proposals/' + encodeURIComponent(id));
    if (state.root !== currentRoot || state.busy) return;
    const v = preview.proposal;
    const canAccept = v.state === 'draft' && !!preview.digest && !preview.problem && writable();
    $('editor').close();
    openEditor(
      'Review planning proposal',
      () => html`<h3 class="proposal-text">${v.document.title}</h3>
        <p class="proposal-text">${v.document.rationale}</p>
        ${helpTextTemplate(`Claimed provenance (unverified): ${v.document.provenance}`, 'proposal-text')}
        <p>
          ${`Imported by ${v.imported_by} · ${v.state}${v.reviewed_by ? ` · Reviewed by ${v.reviewed_by}` : ''}`}
        </p>
        ${v.review_reason ? html`<p class="proposal-text">${v.review_reason}</p>` : nothing}
        ${preview.problem ? errorLineTemplate(preview.problem) : nothing}
        ${helpTextTemplate(
          `New imports: ${preview.created || 0} · Already imported, retained unchanged: ${Object.keys(preview.skipped || {}).length}`,
        )}
        ${
          Object.keys(preview.workspace_changes || {}).length
            ? html`<h3>Workspace changes</h3>
                <pre class="proposal-data">${JSON.stringify(preview.workspace_changes, null, 2)}</pre>`
            : nothing
        }
        ${(preview.changes || []).map(
          (change) => html`<section class="setup-row">
            <strong>${`Native item ${change.id}`}</strong>
            ${Object.entries(change.fields).map(
              ([name, values]) => html`<h4>${name}</h4>
                <pre class="proposal-data">${`Before: ${JSON.stringify(values.before, null, 2)}\nAfter: ${JSON.stringify(values.after, null, 2)}`}</pre>`,
            )}
          </section>`,
        )}
        <details>
          <summary>Original document, evidence and skipped sources</summary>
          <pre class="proposal-data">${JSON.stringify({ document: v.document, skipped: preview.skipped }, null, 2)}</pre>
        </details>
        ${
          v.state === 'draft'
            ? html`${accessButtonTemplate('Revise as new draft', () => importProposal(v.document), {
                tracked: false,
              })}${accessButtonTemplate('Reject proposal', () => rejectProposal(v.id), {
                tracked: false,
              })}`
            : nothing
        }
        ${
          canAccept
            ? html`${fieldTemplate('reason', 'Approval rationale', '', 'textarea', undefined, {
                required: true,
              })}
              ${fieldTemplate(
                'consent',
                'I reviewed and approve this exact diff',
                'yes',
                'checkbox',
                undefined,
                {
                  required: true,
                  className: 'consent',
                  controlFirst: true,
                },
              )}`
            : nothing
        }`,
      (data) => {
        if (!data.get('consent')) throw new Error('Explicit approval is required.');
        return {
          kind: 'proposal.accept',
          target: v.id,
          revision: v.document.revision,
          name: preview.digest,
          reason: data.get('reason').trim(),
        };
      },
      !canAccept,
    );
    $('save').textContent = 'Accept exact diff';
  } catch (e) {
    notice(e.message, true);
  }
}
async function rejectProposal(id) {
  if (!(await hooks.refresh())) return;
  $('editor').close();
  openEditor(
    'Reject planning proposal',
    () =>
      fieldTemplate('reason', 'Rejection rationale', '', 'textarea', undefined, { required: true }),
    (data) => ({ kind: 'proposal.reject', target: id, reason: data.get('reason').trim() }),
  );
  $('save').textContent = 'Reject proposal';
}
