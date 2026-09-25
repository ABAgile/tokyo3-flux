// Proposal review: list, import, review and reject.
import { $, el, button, field } from './dom.js';
import { api, requestKey } from './api.js';
import { helpText, errorLine, emptyState } from './layout.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { writable, writeButton } from './permissions.js';
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
      (fields) => {
        fields.append(
          helpText(
            'Agent output is an unverified suggestion. Importing creates a draft only; a human must review the exact diff before any planning changes.',
          ),
        );
        fields.append(writeButton('Import proposal or migration JSON', () => importProposal()));
        if (!rows.length) fields.append(emptyState('No proposals on this page.'));
        for (const row of rows) {
          const card = el('article', undefined, 'setup-row');
          card.append(
            el('strong', row.title),
            el(
              'p',
              `${row.state} · Imported by ${row.imported_by} · workspace revision ${row.revision}`,
              'muted',
            ),
            button('Review ' + row.title, () => reviewProposal(row.id)),
          );
          fields.append(card);
        }
        if (rows.length === 20)
          fields.append(button('Older proposals', () => showProposals(rows.at(-1).sequence)));
        if (before) fields.append(button('Newest proposals', () => showProposals()));
      },
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
    (fields) => {
      fields.append(
        helpText(
          'Paste a version-1 proposal or the document/report from flux import. This saves a draft, not planning changes. Source identity and agent provenance are not verified.',
        ),
      );
      const input = field(
        fields,
        'document',
        'Proposal JSON',
        document ? JSON.stringify(document, null, 2) : '',
        'textarea',
      );
      input.required = true;
      input.maxLength = 60000;
      field(fields, 'reason', 'Import rationale', '', 'textarea').required = true;
    },
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
      (fields) => {
        fields.append(
          el('h3', v.document.title, 'proposal-text'),
          el('p', v.document.rationale, 'proposal-text'),
          helpText(`Claimed provenance (unverified): ${v.document.provenance}`, 'proposal-text'),
          el(
            'p',
            `Imported by ${v.imported_by} · ${v.state}${v.reviewed_by ? ' · Reviewed by ' + v.reviewed_by : ''}`,
          ),
        );
        if (v.review_reason) fields.append(el('p', v.review_reason, 'proposal-text'));
        if (preview.problem) fields.append(errorLine(preview.problem));
        fields.append(
          helpText(
            `New imports: ${preview.created || 0} · Already imported, retained unchanged: ${Object.keys(preview.skipped || {}).length}`,
          ),
        );
        if (Object.keys(preview.workspace_changes || {}).length)
          fields.append(
            el('h3', 'Workspace changes'),
            el('pre', JSON.stringify(preview.workspace_changes, null, 2), 'proposal-data'),
          );
        for (const change of preview.changes || []) {
          const row = el('section', undefined, 'setup-row');
          row.append(el('strong', 'Native item ' + change.id));
          for (const [name, values] of Object.entries(change.fields)) {
            row.append(
              el('h4', name),
              el(
                'pre',
                'Before: ' +
                  JSON.stringify(values.before, null, 2) +
                  '\nAfter: ' +
                  JSON.stringify(values.after, null, 2),
                'proposal-data',
              ),
            );
          }
          fields.append(row);
        }
        const details = el('details');
        details.append(
          el('summary', 'Original document, evidence and skipped sources'),
          el(
            'pre',
            JSON.stringify({ document: v.document, skipped: preview.skipped }, null, 2),
            'proposal-data',
          ),
        );
        fields.append(details);
        if (v.state === 'draft') {
          fields.append(
            writeButton('Revise as new draft', () => importProposal(v.document)),
            writeButton('Reject proposal', () => rejectProposal(v.id)),
          );
        }
        if (canAccept) {
          field(fields, 'reason', 'Approval rationale', '', 'textarea').required = true;
          const consent = field(
            fields,
            'consent',
            'I reviewed and approve this exact diff',
            'yes',
            'checkbox',
          );
          consent.required = true;
          consent.parentElement.classList.add('consent');
          consent.parentElement.prepend(consent);
        }
      },
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
    (fields) => {
      field(fields, 'reason', 'Rejection rationale', '', 'textarea').required = true;
    },
    (data) => ({ kind: 'proposal.reject', target: id, reason: data.get('reason').trim() }),
  );
  $('save').textContent = 'Reject proposal';
}
