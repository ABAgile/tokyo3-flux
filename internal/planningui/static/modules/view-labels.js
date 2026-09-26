// The Labels page and label dialogs.
import { $ } from './dom.js';
import {
  renderPage,
  fieldTemplate,
  sectionHeadTemplate,
  helpTextTemplate,
  emptyStateTemplate,
  maintenanceListTemplate,
  maintenanceRowTemplate,
} from './layout.js';
import { html, keyedList } from './preact.js';
import { state } from './state.js';
import { writeIconTemplate, accessButtonTemplate } from './permissions.js';
import { labelInfo, labelBadgeTemplate } from './items.js';
import { labelColorPickerTemplate } from './multi-select.js';
import { openEditor, setEditorSaveText } from './dialog.js';

function editLabel(label) {
  $('editor').close();
  const originalName = typeof label === 'string' ? label : label?.name || '';
  const originalColor =
    typeof label === 'string' ? labelInfo(label).color : label?.color || '#dcefe4';
  openEditor(
    originalName ? 'Rename label' : 'Create label',
    () => html`${fieldTemplate('name', 'Label name', originalName, 'text', undefined, {
      required: true,
      maxLength: 60,
    })}
      ${labelColorPickerTemplate(originalColor)}
      ${helpTextTemplate(
        'Use optional scope::value names such as type::bug or priority::high. Choose from the fixed 64-swatch palette. Renaming updates every assigned card, including archived work.',
      )}`,
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
  const count = state.board.items.filter((i) => i.labels.includes(label.name)).length;
  openEditor(
    'Delete label',
    () =>
      html`<p>${`Remove “${label.name}” from the workspace and all ${count} assigned cards, including archived work? Historical audit is retained.`}</p>`,
    () => ({ kind: 'label.delete', target: label.name }),
  );
  setEditorSaveText('Delete label');
}
function labelRowTemplate(label) {
  const usage = state.board.items.filter((item) => item.labels.includes(label.name)).length;
  return maintenanceRowTemplate({
    tag: 'article',
    className: 'label-maintenance-row',
    content: [
      labelBadgeTemplate(label.name),
      html`<small class="muted">${`${usage} card${usage === 1 ? '' : 's'}`}</small>`,
    ],
    actions: [
      writeIconTemplate('Rename', '✎', () => editLabel(label)),
      writeIconTemplate('Delete…', '×', () => deleteLabel(label), 'danger'),
    ],
  });
}
export function renderLabels(content) {
  const labels = state.board.labels;
  $('count').textContent = labels.length
    ? `${labels.length} label${labels.length === 1 ? '' : 's'}`
    : '';
  renderPage(
    content,
    'labels',
    html`${sectionHeadTemplate(
      'Workspace labels',
      accessButtonTemplate('＋ New label', () => editLabel(), { className: 'primary' }),
    )}
    ${helpTextTemplate(
      'Create, rename and remove the reusable labels used to classify work in this workspace.',
    )}
    ${
      labels.length
        ? maintenanceListTemplate(
            'label-maintenance-list',
            keyedList(labels, (label) => label.name, labelRowTemplate),
          )
        : emptyStateTemplate('No labels yet. Create reusable labels for this workspace.')
    }`,
  );
}
