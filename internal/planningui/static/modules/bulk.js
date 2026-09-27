// Bulk selection and bulk actions in the List presentation.
import { labelForeground } from './format.js';
import { emptyStateTemplate, fieldTemplate, helpTextTemplate } from './layout.js';
import { html } from './vdom.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { accessButtonTemplate } from './permissions.js';
import { notice } from './notices.js';
import { findItem } from './items.js';
import { memberName } from './people.js';
import { UNDO_TTL, offerUndo, runSequence } from './commands.js';
import { openFormDialog } from './dialog.js';

function bulkTargets() {
  return [...state.bulkSelection].map(findItem).filter((item) => item && !item.archived);
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
  state.bulkSelection.clear();
  const ok = await runSequence(label, commands);
  if (ok && commands.length && undo)
    offerUndo(`${undo.text} · undo is available for ${UNDO_TTL / 1000} seconds`, undo.commands);
}
function openBulkDialog(title, saveText, build, plan, label, undoFor, hideSave = false) {
  openFormDialog(
    title,
    saveText,
    build,
    async (data, { close, setError }) => {
      if (state.busy) return;
      let apply;
      try {
        apply = plan(data);
      } catch (error) {
        setError(error.message);
        return;
      }
      close();
      await runBulk(label, apply, undoFor);
    },
    { hideSave },
  );
}
function bulkAssign() {
  const count = bulkTargets().length;
  openBulkDialog(
    'Assign selected work',
    'Assign items',
    () => html`${helpTextTemplate(
      `Set one assignee on ${count} selected work item${count === 1 ? '' : 's'}. Existing assignees are replaced.`,
    )}
      ${fieldTemplate('assignee', 'Assignee', '', 'text', [
        ['', 'Unassigned'],
        ...state.board.members.map((member) => [member.subject, memberName(member.subject)]),
      ])}`,
    (data) => {
      const assignee = String(data.get('assignee') || '');
      return (item) =>
        item.assignee === assignee ? undefined : bulkItemUpdate(item, { assignee });
    },
    'Assign',
  );
}
function bulkSprint() {
  const open = state.board.sprints.filter((sprint) => sprint.state !== 'closed');
  const count = bulkTargets().length;
  openBulkDialog(
    'Add selected work to a sprint',
    'Add to sprint',
    () => {
      if (!open.length)
        return emptyStateTemplate('No open sprint is available. Plan a sprint first.');
      return html`${helpTextTemplate(
        `Add ${count} selected work item${count === 1 ? '' : 's'} to one open sprint. Existing sprint memberships are kept.`,
      )}
      ${fieldTemplate(
        'sprint',
        'Open sprint',
        open[0].id,
        'text',
        open.map((sprint) => [sprint.id, `${sprint.name} (${sprint.state})`]),
      )}`;
    },
    (data) => {
      const sprint = String(data.get('sprint') || '');
      if (!open.some((value) => value.id === sprint)) throw new Error('Choose an open sprint.');
      return (item) =>
        item.sprint_ids.includes(sprint)
          ? undefined
          : bulkItemUpdate(item, { sprint_ids: [...item.sprint_ids, sprint] });
    },
    'Add to sprint',
    undefined,
    !open.length,
  );
}
function bulkLabel() {
  const count = bulkTargets().length;
  openBulkDialog(
    'Add a label to selected work',
    'Add label',
    () => {
      if (!state.board.labels.length)
        return emptyStateTemplate('No workspace label exists yet. Create one in the Labels view.');
      return html`${helpTextTemplate(
        `Add one workspace label to ${count} selected work item${count === 1 ? '' : 's'}. Existing labels are kept.`,
      )}
      <label
        >Label<select name="label">
          ${state.board.labels.map((label, index) => {
            const colors = {
              'background-color': label.color,
              color: labelForeground(label.color),
            };
            return html`<option value=${label.name} selected=${index === 0} style=${colors}
              >${label.name}</option
            >`;
          })}
        </select></label
      >`;
    },
    (data) => {
      const label = String(data.get('label') || '');
      if (!state.board.labels.some((value) => value.name === label))
        throw new Error('Choose a workspace label.');
      return (item) =>
        item.labels.includes(label)
          ? undefined
          : bulkItemUpdate(item, { labels: [...item.labels, label] });
    },
    'Add label',
    undefined,
    !state.board.labels.length,
  );
}
function bulkArchive() {
  const count = bulkTargets().length;
  openBulkDialog(
    'Archive selected work',
    'Archive items',
    () => html`<p>${`Archive ${count} selected work item${count === 1 ? '' : 's'} and remove them from all open sprints? History is retained and each item can be restored.`}</p>
      ${fieldTemplate('reason', 'Archive rationale (optional)', '', 'textarea', undefined, {
        maxLength: 4000,
      })}`,
    (data) => {
      const reason = String(data.get('reason') || '');
      return (item) => ({ kind: 'item.archive', target: item.id, reason });
    },
    'Archive',
    (targets) => ({
      text: `Archived ${targets.length} work item${targets.length === 1 ? '' : 's'}`,
      commands: targets.map((item) => ({
        kind: 'item.restore',
        target: item.id,
        restore_sprint_ids: [...(item.sprint_ids || [])],
      })),
    }),
  );
}
function bulkSelectableIDs(items) {
  return items.filter((item) => !item.archived).map((item) => item.id);
}
export function pruneBulkSelection(items) {
  const selectable = new Set(bulkSelectableIDs(items));
  state.bulkSelection.forEach((id) => {
    if (!selectable.has(id)) state.bulkSelection.delete(id);
  });
}
export function bulkBarTemplate(items) {
  const ids = bulkSelectableIDs(items);
  const show = state.bulkSelection.size > 0 && state.board.role !== 'viewer';
  const action = (text, fn, className) =>
    accessButtonTemplate(text, fn, { className, tracked: false });
  const selectAll = () => {
    for (const id of ids) state.bulkSelection.add(id);
    hooks.renderContent();
  };
  const clear = () => {
    state.bulkSelection.clear();
    hooks.renderContent();
  };
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
              >${`${state.bulkSelection.size} of ${ids.length} shown selected`}</span
            >
            <div class="actions bulk-actions">
              ${action('Assign…', bulkAssign)}${action('Add to sprint…', bulkSprint)}
              ${action('Add label…', bulkLabel)}${action('Archive…', bulkArchive, 'danger')}
              ${
                state.bulkSelection.size < ids.length
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
