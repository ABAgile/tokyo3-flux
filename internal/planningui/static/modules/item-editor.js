// The work-item editor form, its modal and the archive dialog.
import { $, el, button, field, uid } from './dom.js';
import { itemPayloadFromForm } from './item-command.js';
import { labelForeground } from './format.js';
import { markdownEditor } from './markdown.js';
import { helpText } from './layout.js';
import { html } from './lit.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { writable, gitLabWritable, writeButton } from './permissions.js';
import { itemProjectIDs, labelInfo, blocked } from './items.js';
import { memberName } from './people.js';
import { helpPopover, multiSelect } from './multi-select.js';
import {
  itemDateStatus,
  dueDateBadge,
  editorDueBadgeHost,
  appendEditorDueBadge,
} from './due-dates.js';
import { singleFilterValue } from './filters.js';
import { UNDO_TTL, offerUndo, quick } from './commands.js';
import { renderItemAttachments } from './item-attachments.js';
import { closeEditor, openEditor } from './dialog.js';
import { linkDisplayName, cardObservationIcon, showLinks } from './gitlab.js';
import { renderItemComments } from './item-comments.js';
import { setSharedItem, copyCardLink, openSharedItem } from './url-state.js';
import { inlineGitLabPaste, addGitLabLink, reconcileItemLinks } from './item-links.js';

export function itemEditorDraft(form = $('editor-form')) {
  const data = new FormData(form);
  return {
    title: String(data.get('title') || ''),
    description: String(data.get('description') || ''),
    start_date: String(data.get('start_date') || ''),
    end_date: String(data.get('end_date') || ''),
    due_date: String(data.get('due_date') || ''),
    column_id: String(data.get('column_id') || ''),
    project_ids: data.getAll('project_id').filter(Boolean),
    assignee: String(data.get('assignee') || ''),
    sprint_ids: data.getAll('sprint_ids'),
    labels: data.getAll('labels'),
    dependencies: data.getAll('dependencies'),
    link_ids: data.getAll('link_ids'),
  };
}
function itemDatesField(parent, item, draft) {
  const group = el('div', undefined, 'multi-select-field date-field');
  const heading = el('span', undefined, 'multi-select-heading');
  heading.append(el('span', 'Dates', 'multi-select-label'));
  const values = el('div', undefined, 'multi-select-values date-field-values');
  const root = el('div', undefined, 'multi-select date-field-content');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Dates');
  const inputs = el('div', undefined, 'date-field-inputs');
  inputs.id = uid('item-dates');
  inputs.hidden = true;
  let editing = false;
  const fields = [
    ['start_date', 'Start date'],
    ['end_date', 'End date'],
    ['due_date', 'Due date'],
  ].map(([name, title]) => {
    const input = field(inputs, name, title, String(draft?.[name] ?? item[name] ?? ''), 'date');
    input.addEventListener('input', renderValues);
    input.addEventListener('change', renderValues);
    return { input, title };
  });
  function clearButton({ input, title }) {
    const clear = button(
      '\u00d7',
      () => {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      },
      'multi-select-remove',
    );
    clear.setAttribute('aria-label', `Clear ${title.toLowerCase()}`);
    return clear;
  }
  function renderValues() {
    values.replaceChildren();
    const [start, end, due] = fields;
    const range = el('span', undefined, 'multi-select-chip date-range-chip');
    range.setAttribute('role', 'group');
    range.setAttribute(
      'aria-label',
      `Start date ${start.input.value || 'not set'}; End date ${end.input.value || 'not set'}`,
    );
    [
      [start, '-'],
      [end, '-'],
    ].forEach(([date, empty], index) => {
      const part = el('span', undefined, 'date-range-part');
      part.append(el('span', date.input.value || empty));
      if (editing && date.input.value) part.append(clearButton(date));
      range.append(part);
      if (!index) range.append(el('span', '\u00b7', 'date-range-separator'));
    });
    values.append(range);
    if (due.input.value) {
      const chip = el('span', undefined, 'multi-select-chip date-due-chip');
      chip.setAttribute('role', 'group');
      chip.setAttribute('aria-label', `Due date ${due.input.value}`);
      chip.append(el('span', `Due \u00b7 ${due.input.value}`));
      if (editing) chip.append(clearButton(due));
      values.append(chip);
    }
  }
  const edit = button('Edit', toggle, 'multi-select-edit');
  edit.dataset.multiEdit = 'true';
  edit.setAttribute('aria-label', 'Edit Dates');
  edit.setAttribute('aria-expanded', 'false');
  edit.setAttribute('aria-controls', inputs.id);
  function toggle() {
    editing = !editing;
    inputs.hidden = !editing;
    edit.textContent = editing ? 'Done' : 'Edit';
    edit.setAttribute('aria-label', editing ? 'Done editing dates' : 'Edit Dates');
    edit.setAttribute('aria-expanded', String(editing));
    renderValues();
    if (editing) fields[0].input.focus();
  }
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (editing) {
      toggle();
      edit.focus();
    }
  });
  const header = el('div', undefined, 'multi-select-header');
  header.append(heading, edit);
  root.append(values, inputs);
  group.append(header, root);
  parent.append(group);
  renderValues();
}
// The card's own planning state, stated explicitly: where it sits, whether it
// is archived or blocked, and which sprints hold it. GitLab entries are labelled
// as cached provider observations, never as authoritative planning state.
export function refreshItemStatusSummary(form, item) {
  const current = form.querySelector('.item-status');
  if (!current) return;
  const next = itemStatusSummary(item);
  next.open = current.open;
  current.replaceWith(next);
}
export function refreshEditorDueBadge(form, item) {
  const host = editorDueBadgeHost(form);
  if (!host) return;
  const input = form.querySelector('[name="title"]'),
    previous = host.querySelector('.badge-due[data-due-date-badge]');
  if (input?.getAttribute('aria-describedby') === previous?.id)
    input.removeAttribute('aria-describedby');
  previous?.remove();
  if (itemDateStatus(item)?.overdue) {
    const badge = dueDateBadge(item);
    if (badge) {
      badge.id = uid('item-title-overdue');
      input?.setAttribute('aria-describedby', badge.id);
      appendEditorDueBadge(form, badge);
    }
  }
}
function itemStatusSummary(item) {
  const section = el('details', undefined, 'item-status');
  section.dataset.stateKey = `item:${item.id}:status`;
  section.setAttribute('aria-label', 'Current card status');
  const column = state.board.columns.find((value) => value.id === item.column_id);
  const category =
    { todo: 'To do', doing: 'In progress', done: 'Done' }[column?.category] || 'Uncategorised';
  const openSprints = (item.sprint_ids || []).map(
    (id) => state.board.sprints.find((sprint) => sprint.id === id)?.name || id,
  );
  const closedSprints = state.board.closed_scope
    .filter((scope) => scope.item_id === item.id)
    .map(
      (scope) =>
        state.board.sprints.find((sprint) => sprint.id === scope.sprint_id)?.name ||
        scope.sprint_id,
    );
  const links = state.board.links.filter((link) => link.items.includes(item.id));
  // The summary is the whole status in one line; everything that would push the
  // editor down \u2014 sprint history and cached provider observations \u2014 waits behind
  // the disclosure.
  const head = el('summary', undefined, 'item-status-head');
  const badges = el('div', undefined, 'tags item-status-badges');
  // Two orthogonal facts, never merged: where the card sits in the workflow
  // (its column's workspace-defined lifecycle category) and whether the card is
  // still on the board. A Done card is not archived, and an archived card keeps
  // the column it was archived from.
  const workflow = el('span', `${column?.name || item.column_id} \u00b7 ${category}`, 'badge');
  workflow.title = `Board column \u201c${column?.name || item.column_id}\u201d, lifecycle category ${category}`;
  badges.append(workflow);
  // "Live" is the board's own vocabulary for the working set. "In scope" is
  // deliberately avoided here: sprint and project metrics already use it for
  // sprint scope, and this badge sits beside the sprint badge on the same line.
  const presence = el(
    'span',
    item.archived ? 'Archived' : 'Live',
    item.archived ? 'badge warning' : 'badge',
  );
  presence.title = item.archived
    ? 'Archived: removed from the board and from open sprints; history is retained and it can be restored.'
    : 'Live: on the board and not archived. Completion is the column category, and sprint scope is the sprint badge.';
  badges.append(presence);
  if (blocked(item)) badges.append(el('span', 'Blocked by dependency', 'badge warning'));
  const due = itemDateStatus(item);
  if (due && !due.overdue) {
    const dueBadge = dueDateBadge(item);
    if (dueBadge) badges.append(dueBadge);
  }
  badges.append(
    el(
      'span',
      openSprints.length
        ? `${openSprints.length} open sprint${openSprints.length === 1 ? '' : 's'}`
        : 'Backlog',
      'badge',
    ),
  );
  if (links.length)
    badges.append(
      el('span', `${links.length} GitLab link${links.length === 1 ? '' : 's'}`, 'badge'),
    );
  const toggle = el('span', undefined, 'item-status-toggle');
  toggle.setAttribute('aria-hidden', 'true');
  head.append(badges, toggle);
  const body = el('div', undefined, 'item-status-body');
  body.append(
    helpText(
      `Sprints: ${openSprints.length ? openSprints.join(', ') : 'Backlog \u00b7 no open sprint'}${closedSprints.length ? ` \u00b7 Closed sprint history: ${closedSprints.join(', ')}` : ''}`,
    ),
  );
  body.append(
    helpText(
      `Progress is the column\u2019s lifecycle category (To do, In progress, Done), chosen per column in Board setup. ${item.archived ? 'Archived is separate from progress: this card is off the board and out of open sprints, and keeps the column it was archived from.' : 'Done means the card sits in a Done column; it stays on the board until it is archived.'}`,
    ),
  );
  if (links.length) {
    const observations = el('div', undefined, 'item-status-links');
    links.forEach((link) => {
      const row = el('div', undefined, 'item-status-link');
      row.append(
        cardObservationIcon(link, `status:${item.id}:${link.id}`),
        el('span', linkDisplayName(link)),
      );
      observations.append(row);
    });
    body.append(
      helpText('Cached GitLab observations \u00b7 provider data, not Flux planning state'),
      observations,
    );
  }
  section.append(head, body);
  return section;
}
// Restoring from a shared view keeps the same card URL: the link a reader was
// given must keep resolving after the card returns to the board.
async function restoreSharedItem(item, context) {
  if (!writable()) return;
  await quick({ kind: 'item.restore', target: item.id });
  if (!state.board) return;
  if (context?.mode === 'modal') closeEditor();
  else hooks.closeDetail({ force: true, focus: false });
  await openSharedItem(item.id);
}
export function buildItemEditor(fields, item, draft, readOnly, context, titleHost) {
  if (item.id && titleHost) {
    // A text action reads better than another glyph beside the card title: it
    // follows the details popover in the heading and states its own outcome.
    const share = button('Copy link', () => void copyCardLink(item, share), 'card-link-copy');
    share.setAttribute('aria-label', `Copy a link to \u201c${item.title}\u201d`);
    share.title = 'Copy a shareable link to this card';
    titleHost.append(
      ' ',
      helpPopover(`Card ID: ${item.id}\nRevision: ${item.revision}`, 'Work item details'),
      ' ',
      share,
    );
  }
  if (item.id) fields.append(itemStatusSummary(item));
  const layout = el('div', undefined, 'item-editor-layout');
  const primary = el('div', undefined, 'item-editor-primary');
  const controls = el('div', undefined, 'item-editor-controls');
  layout.append(primary, controls);
  fields.append(layout);
  const title = field(primary, 'title', 'Title', draft?.title ?? item.title);
  title.required = true;
  title.maxLength = 240;
  title.setAttribute('aria-label', 'Title');
  const titleLabel = el('span', 'Title', 'item-title-label');
  title.parentElement.firstChild.replaceWith(titleLabel);
  if (context?.form && itemDateStatus(item)?.overdue) {
    const overdueBadge = dueDateBadge(item);
    if (overdueBadge) {
      overdueBadge.id = uid('item-title-overdue');
      title.setAttribute('aria-describedby', overdueBadge.id);
      appendEditorDueBadge(context.form, overdueBadge);
    }
  }
  markdownEditor(
    primary,
    'description',
    'Description',
    draft?.description ?? item.description,
    16000,
    readOnly,
    true,
  );
  const selfSubject = state.board.members.find(
    (member) => member.subject === state.session?.subject,
  )?.subject;
  let assigneePicker;
  const assignMe =
    !readOnly && selfSubject
      ? () =>
          html`<button
            type="button"
            class="multi-select-edit"
            aria-label="Assign me"
            @click=${() => assigneePicker.select(selfSubject)}
          >Assign me</button>`
      : undefined;
  assigneePicker = multiSelect(
    controls,
    'assignee',
    'Assignee',
    [['', 'Unassigned'], ...state.board.members.map((m) => [m.subject, memberName(m.subject)])],
    [draft?.assignee ?? item.assignee],
    undefined,
    undefined,
    { single: true, headingAction: assignMe },
  );
  multiSelect(
    controls,
    'labels',
    'Labels',
    state.board.labels.map((label) => [label.name, label.name]),
    draft?.labels ?? item.labels,
    (chip, value) => {
      const label = labelInfo(value);
      chip.style.backgroundColor = label.color;
      chip.style.color = labelForeground(label.color);
      chip.classList.add('label-badge');
    },
    'Use Edit to add labels and × to remove them. Manage available labels from the Labels view.',
  );
  const selectedProjects = draft?.project_ids ?? itemProjectIDs(item);
  multiSelect(
    controls,
    'project_id',
    'Project',
    [['', 'No project'], ...state.board.projects.map((p) => [p.id, p.name])],
    selectedProjects.length ? selectedProjects : [''],
    undefined,
    'Choose one or more projects to classify this work item. Leave No project selected to keep it unclassified.',
    { emptyValue: '' },
  );
  itemDatesField(controls, item, draft);
  multiSelect(
    controls,
    'sprint_ids',
    'Open sprints',
    state.board.sprints
      .filter((s) => s.state !== 'closed')
      .map((s) => [s.id, `${s.name} (${s.state})`]),
    draft?.sprint_ids ?? item.sprint_ids,
    undefined,
    'Select no open sprint to keep unfinished work in the backlog. One item may span several sprints without creating duplicate cards.',
  );
  const closed = state.board.closed_scope
    .filter((s) => s.item_id === item.id)
    .map(
      (scope) => state.board.sprints.find((s) => s.id === scope.sprint_id)?.name || scope.sprint_id,
    );
  if (closed.length)
    controls.append(helpText('Closed sprint history (read-only): ' + closed.join(', ')));
  multiSelect(
    controls,
    'dependencies',
    'Depends on',
    state.board.items.filter((i) => i.id !== item.id).map((i) => [i.id, i.title]),
    draft?.dependencies ?? item.dependencies,
  );
  if (item.id) {
    const itemLinks = state.board.links.filter((link) => link.items.includes(item.id));
    const linkPicker = multiSelect(
      controls,
      'link_ids',
      'GitLab links',
      state.board.links.map((link) => [link.id, linkDisplayName(link)]),
      draft?.link_ids ?? itemLinks.map((link) => link.id),
      undefined,
      'Select registered merge requests to associate with this card. Paste a new MR URL below or use Add link when it is not listed.',
    );
    if (!readOnly) inlineGitLabPaste(linkPicker.group, item, readOnly, context);
    const linkActions = el('div', undefined, 'actions');
    if (!readOnly) {
      const add = writeButton('Add link', () => addGitLabLink(item, context));
      add.dataset.gitlabWrite = 'true';
      add.disabled = !gitLabWritable();
      linkActions.append(add);
    } else if (itemLinks.length)
      linkActions.append(
        button('View observations', () => {
          if (context.mode === 'modal') $('editor').close();
          showLinks(item);
        }),
      );
    if (linkActions.childElementCount) controls.append(linkActions);
  }
  controls.append(el('hr', undefined, 'item-editor-divider'));
  field(
    controls,
    'column_id',
    'Move to',
    draft?.column_id ?? item.column_id,
    'text',
    state.board.columns.map((c) => [c.id, c.name]),
  );
  if (item.id && !item.archived && !readOnly) {
    const archive = writeButton('Archive item', () => archiveItem(item, context), 'danger');
    archive.dataset.itemFooter = 'true';
    archive.dataset.write = 'true';
    archive.classList.add('archive-footer');
    const footer = context.footer || context.form.querySelector('.dialog-foot');
    const cancel = footer?.querySelector('#cancel,.detail-cancel');
    if (footer) footer.insertBefore(archive, cancel || footer.lastElementChild);
  }
  if (item.id && item.archived && state.board.role !== 'viewer') {
    const restore = writeButton('Restore item', () => void restoreSharedItem(item, context));
    restore.dataset.itemFooter = 'true';
    restore.dataset.write = 'true';
    const footer = context.footer || context.form.querySelector('.dialog-foot');
    const cancel = footer?.querySelector('#cancel,.detail-cancel');
    if (footer) footer.insertBefore(restore, cancel || footer.lastElementChild);
  }
  if (item.id) {
    renderItemAttachments(primary, item, readOnly);
    renderItemComments(primary, item);
  }
}
export function reopenItemEditor(item, draft, mode, origin) {
  if (mode === 'detail') hooks.openItemDetail(item, draft, origin);
  else editItemModal(item, draft);
}
export function editItemModal(item, draft) {
  const existing = !!item;
  const readOnly = state.board.role === 'viewer' || item?.archived;
  let desiredLinkIDs;
  const project = singleFilterValue('project');
  const projectIDs = ['all', 'none'].includes(project) ? [] : [project];
  item ||= {
    title: '',
    description: '',
    start_date: '',
    end_date: '',
    due_date: '',
    column_id: state.board.columns[0].id,
    project_id: projectIDs[0] || '',
    project_ids: projectIDs,
    sprint_ids: [],
    assignee: '',
    labels: [],
    dependencies: [],
  };
  const context = { mode: 'modal', form: $('editor-form') };
  state.editorItemID = existing ? item.id : '';
  if (existing) setSharedItem(item.id);
  openEditor(
    existing ? 'Work item' : 'Create work item',
    (fields) => {
      context.form = $('editor-form');
      buildItemEditor(fields, item, draft, readOnly, context, $('editor-title'));
    },
    (data) => {
      if (existing) desiredLinkIDs = data.getAll('link_ids');
      return {
        kind: existing ? 'item.update' : 'item.create',
        target: item.id || '',
        item: itemPayloadFromForm(data, item),
      };
    },
    readOnly,
    existing ? () => reconcileItemLinks(item.id, desiredLinkIDs || []) : undefined,
  );
}
export function editItem(item, draft) {
  if (item && state.view === 'board' && state.presentation === 'list')
    return hooks.selectItem(item.id);
  return editItemModal(item, draft);
}
function archiveItem(item, context) {
  if (context?.mode === 'modal') closeEditor();
  openEditor(
    'Archive work item',
    (fields) => {
      fields.append(
        el(
          'p',
          `Archive “${item.title}” and remove it from all open sprints? History is retained and the item can be restored. Unsaved editor changes will not be applied.`,
        ),
      );
      field(fields, 'reason', 'Archive rationale (optional)', '', 'textarea').maxLength = 4000;
    },
    (data) => ({ kind: 'item.archive', target: item.id, reason: data.get('reason') }),
    false,
    () => {
      offerUndo(`Archived “${item.title}” · undo is available for ${UNDO_TTL / 1000} seconds`, {
        kind: 'item.restore',
        target: item.id,
        restore_sprint_ids: [...(item.sprint_ids || [])],
      });
      if (context?.mode === 'detail') hooks.closeDetail({ force: true, focus: true });
    },
  );
  $('save').textContent = 'Archive item';
}
