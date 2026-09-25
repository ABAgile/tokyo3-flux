// The Labels page and label dialogs.
import { $, el, field } from './dom.js';
import {
  pageStack,
  sectionHead,
  helpText,
  emptyState,
  maintenanceList,
  maintenanceRow,
} from './layout.js';
import { state } from './state.js';
import { writeIconButton, writeButton } from './permissions.js';
import { labelInfo, labelBadge } from './items.js';
import { labelColorPicker } from './multi-select.js';
import { openEditor } from './dialog.js';

function editLabel(label) {
  $('editor').close();
  const originalName = typeof label === 'string' ? label : label?.name || '';
  const originalColor =
    typeof label === 'string' ? labelInfo(label).color : label?.color || '#dcefe4';
  openEditor(
    originalName ? 'Rename label' : 'Create label',
    (fields) => {
      const input = field(fields, 'name', 'Label name', originalName);
      input.required = true;
      input.maxLength = 60;
      labelColorPicker(fields, originalColor);
      fields.append(
        helpText(
          'Use optional scope::value names such as type::bug or priority::high. Choose from the fixed 64-swatch palette. Renaming updates every assigned card, including archived work.',
        ),
      );
    },
    (data) => ({
      kind: 'label.save',
      target: originalName,
      name: data.get('name').trim(),
      color: data.get('color') || originalColor,
    }),
  );
}
function deleteLabel(label) {
  $('editor').close();
  openEditor(
    'Delete label',
    (fields) => {
      fields.append(
        el(
          'p',
          `Remove “${label.name}” from the workspace and all ${state.board.items.filter((i) => i.labels.includes(label.name)).length} assigned cards, including archived work? Historical audit is retained.`,
        ),
      );
    },
    () => ({ kind: 'label.delete', target: label.name }),
  );
  $('save').textContent = 'Delete label';
}
export function renderLabels(content) {
  $('count').textContent = state.board.labels.length
    ? `${state.board.labels.length} label${state.board.labels.length === 1 ? '' : 's'}`
    : '';
  const page = pageStack('labels');
  const newLabel = writeButton('＋ New label', () => editLabel(), 'primary');
  newLabel.dataset.write = 'true';
  page.append(
    sectionHead('Workspace labels', newLabel),
    helpText(
      'Create, rename and remove the reusable labels used to classify work in this workspace.',
    ),
  );
  content.append(page);
  if (!state.board.labels.length) {
    page.append(emptyState('No labels yet. Create reusable labels for this workspace.'));
    return;
  }
  const list = maintenanceList('label-maintenance-list');
  state.board.labels.forEach((label) => {
    const usage = state.board.items.filter((item) => item.labels.includes(label.name)).length;
    list.append(
      maintenanceRow({
        tag: 'article',
        className: 'label-maintenance-row',
        content: [
          labelBadge(label.name),
          el('small', `${usage} card${usage === 1 ? '' : 's'}`, 'muted'),
        ],
        actions: [
          writeIconButton('Rename', '✎', () => editLabel(label)),
          writeIconButton('Delete…', '×', () => deleteLabel(label), 'danger'),
        ],
      }),
    );
  });
  page.append(list);
}
