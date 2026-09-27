// Proposal review: list, import, review and reject.
import { api, requestKey } from './api.js';
import {
  emptyStateTemplate,
  errorLineTemplate,
  fieldTemplate,
  helpTextTemplate,
} from './layout.js';
import { html } from './vdom.js';
import { useState } from './vendor-preact.js';
import { writable, accessButtonTemplate } from './permissions.js';
import { refresh } from './sync.js';
import { openDialog } from './dialog-state.js';
import { CommandDialog, FormDialog } from './dialog.js';
import { useRequest } from './ui-hooks.js';

// The proposal list pages from its own request. The review dialog reads its
// proposal's preview itself, so it shows exactly the diff the server returned
// and a closed or replaced dialog cancels the read.
export function ProposalsDialog({ root }) {
  const [before, setBefore] = useState(0);
  const page = useRequest(
    (signal) => api(`${root}/proposals?before=${before}`, { signal }),
    [root, before],
  );
  const rows = page.data || [];
  return html`<${FormDialog} title="Planning proposals" readOnly=${true}>
    ${helpTextTemplate(
      'Agent output is an unverified suggestion. Importing creates a draft only; a human must review the exact diff before any planning changes.',
    )}
    ${accessButtonTemplate('Import proposal or migration JSON', () => importProposal(), {
      tracked: false,
    })}
    ${page.error ? errorLineTemplate(page.error.message) : null}
    ${
      !page.data && !page.error
        ? emptyStateTemplate('Loading proposals…')
        : page.data && !rows.length
          ? emptyStateTemplate('No proposals on this page.')
          : null
    }
    ${rows.map(
      (row) => html`<article key=${row.id} class="setup-row">
        <strong>${row.title}</strong>
        <p class="muted">
          ${`${row.state} · Imported by ${row.imported_by} · workspace revision ${row.revision}`}
        </p>
        <button type="button" onClick=${() => reviewProposal(root, row.id)}>${`Review ${row.title}`}</button>
      </article>`,
    )}
    ${
      rows.length === 20
        ? html`<button type="button" onClick=${() => setBefore(rows.at(-1).sequence)}
            >Older proposals</button
          >`
        : null
    }
    ${before ? html`<button type="button" onClick=${() => setBefore(0)}>Newest proposals</button>` : null}
  </${FormDialog}>`;
}
function importProposal(document) {
  openDialog('proposal.import', { document, id: requestKey() });
}
export function ProposalImportDialog({ document, id }) {
  return html`<${CommandDialog}
    title="Import proposal draft"
    saveText="Save draft only"
    command=${(data) => {
      const parsed = JSON.parse(data.get('document'));
      if (parsed.unresolved?.length)
        throw new Error('Resolve all import mappings before creating a draft.');
      return {
        kind: 'proposal.import',
        target: id,
        proposal: parsed.document || parsed,
        reason: data.get('reason').trim(),
      };
    }}
  >
    ${helpTextTemplate(
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
    ${fieldTemplate('reason', 'Import rationale', '', 'textarea', undefined, { required: true })}
  </${CommandDialog}>`;
}
function reviewProposal(root, id) {
  openDialog('proposal.review', { root, id });
}
// Whether the diff can be accepted is decided once, when the preview arrives,
// so the approval fields stay put while the acceptance itself is saving.
async function loadProposalReview(root, id, signal) {
  const preview = await api(`${root}/proposals/${encodeURIComponent(id)}`, { signal });
  const v = preview.proposal;
  return {
    preview,
    canAccept: v.state === 'draft' && !!preview.digest && !preview.problem && writable(),
  };
}
export function ProposalReviewDialog({ root, id }) {
  const result = useRequest((signal) => loadProposalReview(root, id, signal), [root, id]);
  if (!result.data)
    return html`<${FormDialog} title="Review planning proposal" readOnly=${true}>
      ${
        result.error
          ? errorLineTemplate(result.error.message)
          : emptyStateTemplate('Loading proposal…')
      }
    </${FormDialog}>`;
  const { preview, canAccept } = result.data;
  const v = preview.proposal;
  return html`<${CommandDialog}
    title="Review planning proposal"
    saveText="Accept exact diff"
    readOnly=${!canAccept}
    command=${(data) => {
      if (!data.get('consent')) throw new Error('Explicit approval is required.');
      return {
        kind: 'proposal.accept',
        target: v.id,
        revision: v.document.revision,
        name: preview.digest,
        reason: data.get('reason').trim(),
      };
    }}
  >
    <h3 class="proposal-text">${v.document.title}</h3>
    <p class="proposal-text">${v.document.rationale}</p>
    ${helpTextTemplate(`Claimed provenance (unverified): ${v.document.provenance}`, 'proposal-text')}
    <p>
      ${`Imported by ${v.imported_by} · ${v.state}${v.reviewed_by ? ` · Reviewed by ${v.reviewed_by}` : ''}`}
    </p>
    ${v.review_reason ? html`<p class="proposal-text">${v.review_reason}</p>` : null}
    ${preview.problem ? errorLineTemplate(preview.problem) : null}
    ${helpTextTemplate(
      `New imports: ${preview.created || 0} · Already imported, retained unchanged: ${Object.keys(preview.skipped || {}).length}`,
    )}
    ${
      Object.keys(preview.workspace_changes || {}).length
        ? html`<h3>Workspace changes</h3>
            <pre class="proposal-data">${JSON.stringify(preview.workspace_changes, null, 2)}</pre>`
        : null
    }
    ${(preview.changes || []).map(
      (change) => html`<section key=${change.id} class="setup-row">
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
        : null
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
        : null
    }
  </${CommandDialog}>`;
}
async function rejectProposal(id) {
  if (!(await refresh())) return;
  openDialog('proposal.reject', { id });
}
export function ProposalRejectDialog({ id }) {
  return html`<${CommandDialog}
    title="Reject planning proposal"
    saveText="Reject proposal"
    command=${(data) => ({ kind: 'proposal.reject', target: id, reason: data.get('reason').trim() })}
  >
    ${fieldTemplate('reason', 'Rejection rationale', '', 'textarea', undefined, { required: true })}
  </${CommandDialog}>`;
}
