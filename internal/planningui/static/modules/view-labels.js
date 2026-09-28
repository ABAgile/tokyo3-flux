// The Labels page and label dialogs.
import { h } from './vendor-preact.js';
import {
  fieldTemplate,
  sectionHeadTemplate,
  helpTextTemplate,
  emptyStateTemplate,
  maintenanceListTemplate,
  maintenanceRowTemplate,
} from './layout.js';
import { html } from './vdom.js';

import { state, useStore, requireBoard } from './state.js';
import { writeIconTemplate, accessButtonTemplate } from './permissions.js';
import { labelInfo, labelBadgeTemplate } from './items.js';
import { selectLookups } from './lookups.js';
import { labelColorPickerTemplate } from './multi-select.js';
import { openDialog } from './dialog-state.js';
import { CommandDialog } from './dialog.js';

/** @param {Flux.DialogProps['label.edit']} props */
export function LabelDialog({ name = '', color = '#dcefe4' }) {
  return h(
    CommandDialog,
    {
      title: name ? 'Rename label' : 'Create label',
      command: (data) => ({
        kind: 'label.save',
        target: name,
        name: String(data.get('name') || '').trim(),
        color: String(data.get('color') || color),
      }),
    },
    html`
      ${fieldTemplate('name', 'Label name', name, 'text', undefined, {
        required: true,
        maxLength: 60,
      })}
      ${labelColorPickerTemplate(color)}
      ${helpTextTemplate(
        'Use optional scope::value names such as type::bug or priority::high. Choose from the fixed 64-swatch palette. Renaming updates every assigned card, including archived work.',
      )}
    `,
  );
}
function editLabel(label) {
  const name = typeof label === 'string' ? label : label?.name || '';
  const color =
    typeof label === 'string'
      ? labelInfo(selectLookups(state), label).color
      : label?.color || '#dcefe4';
  openDialog('label.edit', { name, color });
}
/** @param {Flux.DialogProps['label.delete']} props */
export function DeleteLabelDialog({ label, count }) {
  return h(
    CommandDialog,
    {
      title: 'Delete label',
      saveText: 'Delete label',
      command: () => ({ kind: 'label.delete', target: label.name }),
    },
    html`
      <p>${`Remove “${label.name}” from the workspace and all ${count} assigned cards, including archived work? Historical audit is retained.`}</p>
    `,
  );
}
function deleteLabel(label) {
  const count = requireBoard().items.filter((i) => i.labels.includes(label.name)).length;
  openDialog('label.delete', { label, count });
}
function labelRowTemplate(lookups, label, items) {
  const usage = items.filter((item) => item.labels.includes(label.name)).length;
  return maintenanceRowTemplate({
    key: label.name,
    tag: 'article',
    className: 'label-maintenance-row',
    content: [
      labelBadgeTemplate(lookups, label.name),
      html`<small class="muted">${`${usage} card${usage === 1 ? '' : 's'}`}</small>`,
    ],
    actions: [
      writeIconTemplate('Rename', '✎', () => editLabel(label)),
      writeIconTemplate('Delete…', '×', () => deleteLabel(label), 'danger'),
    ],
  });
}
function selectLabelPage(current) {
  return {
    labels: current.board?.labels || [],
    items: current.board?.items || [],
    lookups: selectLookups(current),
  };
}
function sameLabelPage(left, right) {
  return (
    left.labels === right.labels && left.items === right.items && left.lookups === right.lookups
  );
}
export function LabelsPage() {
  const { labels, items, lookups } = useStore(selectLabelPage, sameLabelPage);
  return html`${sectionHeadTemplate(
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
            labels.map((label) => labelRowTemplate(lookups, label, items)),
          )
        : emptyStateTemplate('No labels yet. Create reusable labels for this workspace.')
    }`;
}
