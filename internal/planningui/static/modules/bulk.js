// Bulk selection and bulk actions in the List presentation.
import { labelForeground } from './format.js';
import { emptyStateTemplate, fieldTemplate, helpTextTemplate } from './layout.js';
import { html } from './vdom.js';
import { setState, state, useStore } from './state.js';
import { accessButtonTemplate } from './permissions.js';
import { notice, UNDO_TTL, offerUndo } from './notices.js';
import { findItem } from './items.js';
import { memberName } from './people.js';
import { selectLookups } from './lookups.js';
import { runSequence } from './commands.js';
import { closeEditor, openDialog } from './dialog-state.js';
import { FormDialog } from './dialog.js';
import { clearBulk, selectAllBulk } from './actions.js';

function bulkTargets() {
  return [...state.bulkSelection]
    .map((id) => findItem(id, state))
    .filter((item) => item && !item.archived);
}
function bulkItemUpdate(item, patch) {
  return {
    kind: 'item.update',
    target: item.id,
    item: { ...item, project_id: undefined, attachments: undefined, ...patch },
  };
}
async function runBulk(label, plan, undoFor) {
  const targets = bulkTargets();
  if (!targets.length) {
    notice('Select at least one work item first.', true);
    return;
  }
  const commands = targets.map(plan).filter(Boolean);
  const undo = undoFor?.(targets);
  setState({ bulkSelection: new Set() });
  const ok = await runSequence(label, commands);
  if (ok && commands.length && undo)
    offerUndo(`${undo.text} · undo is available for ${UNDO_TTL / 1000} seconds`, undo.commands);
}
// A bulk dialog plans one command per selected item from its form; the plan
// is validated before the dialog closes and the sequence runs.
function BulkDialog({ title, saveText, plan, label, undoFor, hideSave = false, children }) {
  return html`<${FormDialog}
    title=${title}
    saveText=${saveText}
    hideSave=${hideSave}
    onSubmit=${async (data) => {
      if (state.busy) return;
      const apply = plan(data);
      closeEditor();
      await runBulk(label, apply, undoFor);
    }}
  >${children}</${FormDialog}>`;
}
function count(n) {
  return `${n} selected work item${n === 1 ? '' : 's'}`;
}
/** @param {Flux.DialogProps['bulk.assign']} props */
export function BulkAssignDialog({ selected, members }) {
  const lookups = useStore(selectLookups);
  return html`<${BulkDialog}
    title="Assign selected work"
    saveText="Assign items"
    label="Assign"
    plan=${(data) => {
      const assignee = String(data.get('assignee') || '');
      return (item) =>
        item.assignee === assignee ? undefined : bulkItemUpdate(item, { assignee });
    }}
  >
    ${helpTextTemplate(`Set one assignee on ${count(selected)}. Existing assignees are replaced.`)}
    ${fieldTemplate('assignee', 'Assignee', '', 'text', [
      ['', 'Unassigned'],
      ...members.map((member) => [member.subject, memberName(lookups, member.subject)]),
    ])}
  </${BulkDialog}>`;
}
/** @param {Flux.DialogProps['bulk.sprint']} props */
export function BulkSprintDialog({ selected, sprints }) {
  return html`<${BulkDialog}
    title="Add selected work to a sprint"
    saveText="Add to sprint"
    label="Add to sprint"
    hideSave=${!sprints.length}
    plan=${(data) => {
      const sprint = String(data.get('sprint') || '');
      if (!sprints.some((value) => value.id === sprint)) throw new Error('Choose an open sprint.');
      return (item) =>
        item.sprint_ids.includes(sprint)
          ? undefined
          : bulkItemUpdate(item, { sprint_ids: [...item.sprint_ids, sprint] });
    }}
  >
    ${
      sprints.length
        ? html`${helpTextTemplate(
            `Add ${count(selected)} to one open sprint. Existing sprint memberships are kept.`,
          )}
          ${fieldTemplate(
            'sprint',
            'Open sprint',
            sprints[0].id,
            'text',
            sprints.map((sprint) => [sprint.id, `${sprint.name} (${sprint.state})`]),
          )}`
        : emptyStateTemplate('No open sprint is available. Plan a sprint first.')
    }
  </${BulkDialog}>`;
}
/** @param {Flux.DialogProps['bulk.label']} props */
export function BulkLabelDialog({ selected, labels }) {
  return html`<${BulkDialog}
    title="Add a label to selected work"
    saveText="Add label"
    label="Add label"
    hideSave=${!labels.length}
    plan=${(data) => {
      const label = String(data.get('label') || '');
      if (!labels.some((value) => value.name === label))
        throw new Error('Choose a workspace label.');
      return (item) =>
        item.labels.includes(label)
          ? undefined
          : bulkItemUpdate(item, { labels: [...item.labels, label] });
    }}
  >
    ${
      labels.length
        ? html`${helpTextTemplate(
            `Add one workspace label to ${count(selected)}. Existing labels are kept.`,
          )}
          <label
            >Label<select name="label">
              ${labels.map((label, index) => {
                const colors = {
                  'background-color': label.color,
                  color: labelForeground(label.color),
                };
                return html`<option key=${label.name} value=${label.name} selected=${index === 0} style=${colors}
                  >${label.name}</option
                >`;
              })}
            </select></label
          >`
        : emptyStateTemplate('No workspace label exists yet. Create one in the Labels view.')
    }
  </${BulkDialog}>`;
}
/** @param {Flux.DialogProps['bulk.archive']} props */
export function BulkArchiveDialog({ selected }) {
  return html`<${BulkDialog}
    title="Archive selected work"
    saveText="Archive items"
    label="Archive"
    plan=${(data) => {
      const reason = String(data.get('reason') || '');
      return (item) => ({ kind: 'item.archive', target: item.id, reason });
    }}
    undoFor=${(targets) => ({
      text: `Archived ${targets.length} work item${targets.length === 1 ? '' : 's'}`,
      commands: targets.map((item) => ({
        kind: 'item.restore',
        target: item.id,
        restore_sprint_ids: [...(item.sprint_ids || [])],
      })),
    })}
  >
    <p>${`Archive ${count(selected)} and remove them from all open sprints? History is retained and each item can be restored.`}</p>
    ${fieldTemplate('reason', 'Archive rationale (optional)', '', 'textarea', undefined, {
      maxLength: 4000,
    })}
  </${BulkDialog}>`;
}
function bulkAssign() {
  openDialog('bulk.assign', { selected: bulkTargets().length, members: state.board.members });
}
function bulkSprint() {
  openDialog('bulk.sprint', {
    selected: bulkTargets().length,
    sprints: state.board.sprints.filter((sprint) => sprint.state !== 'closed'),
  });
}
function bulkLabel() {
  openDialog('bulk.label', { selected: bulkTargets().length, labels: state.board.labels });
}
function bulkArchive() {
  openDialog('bulk.archive', { selected: bulkTargets().length });
}
function bulkSelectableIDs(items) {
  return items.filter((item) => !item.archived).map((item) => item.id);
}
// The selection keeps only shown, selectable cards.
export function prunedBulkSelection(selection, items) {
  const selectable = new Set(bulkSelectableIDs(items));
  const next = new Set([...selection].filter((id) => selectable.has(id)));
  return next.size === selection.size ? selection : next;
}
export function BulkBar({ items, selection, role }) {
  const ids = bulkSelectableIDs(items);
  const show = selection.size > 0 && role !== 'viewer';
  const action = (text, fn, className) =>
    accessButtonTemplate(text, fn, { className, tracked: false });
  const selectAll = () => selectAllBulk(ids);
  const clear = clearBulk;
  return html`<div
    class="bulk-bar"
    data-bulk-bar="true"
    hidden=${!show}
    role="group"
    aria-label="Bulk actions"
  >
    ${
      show
        ? html`<span class="bulk-count"
              >${`${selection.size} of ${ids.length} shown selected`}</span
            >
            <div class="actions bulk-actions">
              ${action('Assign…', bulkAssign)}${action('Add to sprint…', bulkSprint)}
              ${action('Add label…', bulkLabel)}${action('Archive…', bulkArchive, 'danger')}
              ${
                selection.size < ids.length
                  ? html`<button type="button" onClick=${selectAll}
                      >${`Select all ${ids.length} shown`}</button
                    >`
                  : null
              }
              <button type="button" onClick=${clear}>Clear selection</button>
            </div>`
        : null
    }
  </div>`;
}
