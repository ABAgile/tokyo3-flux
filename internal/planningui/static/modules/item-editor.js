// The work-item editor form, its modal and the archive dialog.
import { $, uid } from './dom.js';
import { itemPayloadFromForm } from './item-command.js';
import { labelForeground } from './format.js';
import { markdownEditorTemplate } from './markdown.js';
import { fieldTemplate, helpTextTemplate } from './layout.js';
import {
  html,
  mount,
  nodeOf,
  nothing,
  syncDisabled,
  useLayoutEffect,
  useRef,
  useState,
} from './preact.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { writable, gitLabWritable } from './permissions.js';
import { itemProjectIDs, labelInfo, blocked } from './items.js';
import { memberName } from './people.js';
import { helpPopover, multiSelectTemplate } from './multi-select.js';
import {
  itemDateStatus,
  dueDateBadge,
  dueDateBadgeTemplate,
  editorDueBadgeHost,
  appendEditorDueBadge,
} from './due-dates.js';
import { singleFilterValue } from './filters.js';
import { UNDO_TTL, offerUndo, quick } from './commands.js';
import { itemAttachmentsTemplate } from './item-attachments.js';
import { closeEditor, openEditor, setEditorSaveText } from './dialog.js';
import { linkDisplayName, cardObservationIconTemplate, showLinks } from './gitlab.js';
import { itemCommentsTemplate } from './item-comments.js';
import { setSharedItem, copyCardLink, openSharedItem } from './url-state.js';
import { gitLabPaste, addGitLabLink, reconcileItemLinks } from './item-links.js';

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
const DATE_FIELDS = [
  ['start_date', 'Start date'],
  ['end_date', 'End date'],
  ['due_date', 'Due date'],
];
// The date inputs carry the form values, and chips summarise them.
function DatesField({ item, draft }) {
  const [inputsID] = useState(() => uid('item-dates'));
  const [editing, setEditing] = useState(false);
  // Date controls stay uncontrolled; this revision refreshes their summary chips.
  const [, setRevision] = useState(0);
  const group = useRef();
  const wasEditing = useRef(false);
  const initial = Object.fromEntries(
    DATE_FIELDS.map(([name]) => [name, String(draft?.[name] ?? item[name] ?? '')]),
  );
  const input = (name) => group.current?.querySelector(`[name="${name}"]`);
  const value = (name) => input(name)?.value ?? initial[name];
  const clear = (name, title) => html`<button
    type="button"
    class="multi-select-remove"
    aria-label=${`Clear ${title.toLowerCase()}`}
    onClick=${() => {
      const target = input(name);
      target.value = '';
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.focus();
    }}
  >×</button>`;
  const toggle = () => setEditing((previous) => !previous);
  useLayoutEffect(() => {
    if (!wasEditing.current && editing) input('start_date')?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const [start, end, due] = DATE_FIELDS.map(([name]) => value(name));
  const part = (name, title, text) => html`<span class="date-range-part"
    ><span>${text || '-'}</span>${editing && text ? clear(name, title) : nothing}</span
  >`;
  return html`<div class="multi-select-field date-field" ref=${group}>
    <div class="multi-select-header">
      <span class="multi-select-heading"><span class="multi-select-label">Dates</span></span>
      <button
        type="button"
        class="multi-select-edit"
        data-multi-edit="true"
        aria-label=${editing ? 'Done editing dates' : 'Edit Dates'}
        aria-expanded=${String(editing)}
        aria-controls=${inputsID}
        onClick=${toggle}
      >${editing ? 'Done' : 'Edit'}</button>
    </div>
    <div
      class="multi-select date-field-content"
      role="group"
      aria-label="Dates"
      onKeydown=${(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (!editing) return;
        toggle();
        group.current.querySelector('[data-multi-edit]').focus();
      }}
    >
      <div class="multi-select-values date-field-values">
        <span
          class="multi-select-chip date-range-chip"
          role="group"
          aria-label=${`Start date ${start || 'not set'}; End date ${end || 'not set'}`}
          >${part('start_date', 'Start date', start)}<span class="date-range-separator">·</span
          >${part('end_date', 'End date', end)}</span
        >
        ${
          due
            ? html`<span class="multi-select-chip date-due-chip" role="group" aria-label=${`Due date ${due}`}
                ><span>${`Due · ${due}`}</span>${editing ? clear('due_date', 'Due date') : nothing}</span
              >`
            : nothing
        }
      </div>
      <div class="date-field-inputs" id=${inputsID} hidden=${!editing}>
        ${DATE_FIELDS.map(([name, title]) =>
          fieldTemplate(name, title, initial[name], 'date', undefined, {
            onInput: () => setRevision((version) => version + 1),
            onChange: () => setRevision((version) => version + 1),
          }),
        )}
      </div>
    </div>
  </div>`;
}
function datesFieldTemplate(item, draft) {
  return html`<${DatesField} item=${item} draft=${draft} />`;
}
// The card's own planning state, stated explicitly: where it sits, whether it
// is archived or blocked, and which sprints hold it. GitLab entries are labelled
// as cached provider observations, never as authoritative planning state.
export function refreshEditorDueBadge(form, item) {
  const host = editorDueBadgeHost(form);
  if (!host) return;
  const input = form.querySelector('[name="title"]'),
    previous = host.querySelector('.badge-due[data-due-date-badge]');
  if (input?.getAttribute('aria-describedby') === previous?.id)
    input.removeAttribute('aria-describedby');
  previous?.remove();
  showEditorOverdueBadge(form, item);
}
// The overdue badge sits in the centered editor-title-badge host and names
// itself in the title input's aria-describedby.
function showEditorOverdueBadge(form, item) {
  if (!itemDateStatus(item)?.overdue) return;
  const badge = dueDateBadge(item);
  if (!badge) return;
  badge.id = uid('item-title-overdue');
  form.querySelector('[name="title"]')?.setAttribute('aria-describedby', badge.id);
  appendEditorDueBadge(form, badge);
}
function itemStatusTemplate(item) {
  const column = state.board.columns.find((value) => value.id === item.column_id);
  const category =
    { todo: 'To do', doing: 'In progress', done: 'Done' }[column?.category] || 'Uncategorised';
  const columnName = column?.name || item.column_id;
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
  const due = itemDateStatus(item);
  // The summary is the whole status in one line; everything that would push the
  // editor down — sprint history and cached provider observations — waits behind
  // the disclosure, whose open state belongs to the user.
  //
  // Two orthogonal facts, never merged: where the card sits in the workflow
  // (its column's workspace-defined lifecycle category) and whether the card is
  // still on the board. A Done card is not archived, and an archived card keeps
  // the column it was archived from. "Live" is the board's own vocabulary for
  // the working set; "In scope" is left to sprint and project metrics.
  //
  // Observation icons are VNodes. This editor is a snapshot; any polling
  // patch outside Board/List targets this rendered-once status surface.
  return html`<details
    class="item-status"
    data-state-key=${`item:${item.id}:status`}
    aria-label="Current card status"
  >
    <summary class="item-status-head">
      <div class="tags item-status-badges">
        <span
          class="badge"
          title=${`Board column \u201c${columnName}\u201d, lifecycle category ${category}`}
        >${`${columnName} \u00b7 ${category}`}</span>
        <span
          class=${item.archived ? 'badge warning' : 'badge'}
          title=${
            item.archived
              ? 'Archived: removed from the board and from open sprints; history is retained and it can be restored.'
              : 'Live: on the board and not archived. Completion is the column category, and sprint scope is the sprint badge.'
          }
        >${item.archived ? 'Archived' : 'Live'}</span>
        ${blocked(item) ? html`<span class="badge warning">Blocked by dependency</span>` : nothing}
        ${due && !due.overdue ? dueDateBadgeTemplate(item) : nothing}
        <span class="badge"
          >${
            openSprints.length
              ? `${openSprints.length} open sprint${openSprints.length === 1 ? '' : 's'}`
              : 'Backlog'
          }</span
        >
        ${
          links.length
            ? html`<span class="badge"
                >${`${links.length} GitLab link${links.length === 1 ? '' : 's'}`}</span
              >`
            : nothing
        }
      </div>
      <span class="item-status-toggle" aria-hidden="true"></span>
    </summary>
    <div class="item-status-body">
      ${helpTextTemplate(
        `Sprints: ${openSprints.length ? openSprints.join(', ') : 'Backlog \u00b7 no open sprint'}${closedSprints.length ? ` \u00b7 Closed sprint history: ${closedSprints.join(', ')}` : ''}`,
      )}
      ${helpTextTemplate(
        `Progress is the column\u2019s lifecycle category (To do, In progress, Done), chosen per column in Board setup. ${item.archived ? 'Archived is separate from progress: this card is off the board and out of open sprints, and keeps the column it was archived from.' : 'Done means the card sits in a Done column; it stays on the board until it is archived.'}`,
      )}
      ${
        links.length
          ? html`${helpTextTemplate(
              'Cached GitLab observations \u00b7 provider data, not Flux planning state',
            )}
              <div class="item-status-links">
                ${links.map(
                  (link) => html`<div class="item-status-link">
                    ${cardObservationIconTemplate(link, `status:${item.id}:${link.id}`)}
                    <span>${linkDisplayName(link)}</span>
                  </div>`,
                )}
              </div>`
          : nothing
      }
    </div>
  </details>`;
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
function itemEditorTemplate(item, draft, readOnly, context) {
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
            onClick=${() => assigneePicker.select(selfSubject)}
          >Assign me</button>`
      : undefined;
  const selectedProjects = draft?.project_ids ?? itemProjectIDs(item);
  const closed = state.board.closed_scope
    .filter((s) => s.item_id === item.id)
    .map(
      (scope) => state.board.sprints.find((s) => s.id === scope.sprint_id)?.name || scope.sprint_id,
    );
  const itemLinks = item.id ? state.board.links.filter((link) => link.items.includes(item.id)) : [];
  const paste = item.id && !readOnly ? gitLabPaste(item, readOnly, context) : undefined;
  const labelChip = (chip, value) => {
    const label = labelInfo(value);
    chip.style.backgroundColor = label.color;
    chip.style.color = labelForeground(label.color);
    chip.classList.add('label-badge');
  };
  const linkActions = !readOnly
    ? html`<div class="actions">
        <button
          type="button"
          data-gitlab-write="true"
          ref=${syncDisabled(!gitLabWritable())}
          onClick=${() => addGitLabLink(item, context)}
        >Add link</button>
      </div>`
    : itemLinks.length
      ? html`<div class="actions">
          <button
            type="button"
            onClick=${() => {
              if (context.mode === 'modal') $('editor').close();
              showLinks(item);
            }}
          >View observations</button>
        </div>`
      : nothing;
  return html`${item.id ? itemStatusTemplate(item) : nothing}
    <div class="item-editor-layout">
      <div class="item-editor-primary">
        <label
          ><span class="item-title-label">Title</span><input
            name="title"
            type="text"
            autocomplete="off"
            required
            maxlength="240"
            aria-label="Title"
            defaultValue=${draft?.title ?? item.title}
        /></label>
        ${markdownEditorTemplate(
          'description',
          'Description',
          draft?.description ?? item.description,
          16000,
          readOnly,
          true,
        )}
        ${item.id ? itemAttachmentsTemplate(item, readOnly) : nothing}
        ${item.id ? itemCommentsTemplate(item) : nothing}
      </div>
      <div class="item-editor-controls">
        ${multiSelectTemplate(
          'assignee',
          'Assignee',
          [
            ['', 'Unassigned'],
            ...state.board.members.map((m) => [m.subject, memberName(m.subject)]),
          ],
          [draft?.assignee ?? item.assignee],
          undefined,
          undefined,
          {
            single: true,
            headingAction: assignMe,
            onReady: (controls) => {
              assigneePicker = controls;
            },
          },
        )}
        ${multiSelectTemplate(
          'labels',
          'Labels',
          state.board.labels.map((label) => [label.name, label.name]),
          draft?.labels ?? item.labels,
          labelChip,
          'Use Edit to add labels and × to remove them. Manage available labels from the Labels view.',
        )}
        ${multiSelectTemplate(
          'project_id',
          'Project',
          [['', 'No project'], ...state.board.projects.map((p) => [p.id, p.name])],
          selectedProjects.length ? selectedProjects : [''],
          undefined,
          'Choose one or more projects to classify this work item. Leave No project selected to keep it unclassified.',
          { emptyValue: '' },
        )}
        ${datesFieldTemplate(item, draft)}
        ${multiSelectTemplate(
          'sprint_ids',
          'Open sprints',
          state.board.sprints
            .filter((s) => s.state !== 'closed')
            .map((s) => [s.id, `${s.name} (${s.state})`]),
          draft?.sprint_ids ?? item.sprint_ids,
          undefined,
          'Select no open sprint to keep unfinished work in the backlog. One item may span several sprints without creating duplicate cards.',
        )}
        ${
          closed.length
            ? helpTextTemplate(`Closed sprint history (read-only): ${closed.join(', ')}`)
            : nothing
        }
        ${multiSelectTemplate(
          'dependencies',
          'Depends on',
          state.board.items.filter((i) => i.id !== item.id).map((i) => [i.id, i.title]),
          draft?.dependencies ?? item.dependencies,
        )}
        ${
          item.id
            ? html`${multiSelectTemplate(
                'link_ids',
                'GitLab links',
                state.board.links.map((link) => [link.id, linkDisplayName(link)]),
                draft?.link_ids ?? itemLinks.map((link) => link.id),
                undefined,
                'Select registered merge requests to associate with this card. Paste a new MR URL below or use Add link when it is not listed.',
                { footer: paste?.template, onReady: (controls) => paste?.bind(controls) },
              )}${linkActions}`
            : nothing
        }
        <hr class="item-editor-divider" />
        ${fieldTemplate(
          'column_id',
          'Move to',
          draft?.column_id ?? item.column_id,
          'text',
          state.board.columns.map((c) => [c.id, c.name]),
        )}
      </div>
    </div>`;
}
// The card title gets a details popover and a "Copy link" action. Both sit in
// the editor-title-extra host, separate from the Preact-owned title text; the
// copy action's text belongs to markCopyOutcome.
function decorateItemTitle(titleHost, item) {
  const share = nodeOf(html`<button
    type="button"
    class="card-link-copy"
    aria-label=${`Copy a link to \u201c${item.title}\u201d`}
    title="Copy a shareable link to this card"
    onClick=${(event) => void copyCardLink(item, event.currentTarget)}
  >Copy link</button>`);
  titleHost.append(
    ' ',
    helpPopover(`Card ID: ${item.id}\nRevision: ${item.revision}`, 'Work item details'),
    ' ',
    share,
  );
}
// Archive and restore sit in the footer, before Cancel; they carry
// data-item-footer so the next editor removes them.
function addItemFooterAction(item, readOnly, context) {
  const archive = item.id && !item.archived && !readOnly;
  const restore = item.id && item.archived && state.board.role !== 'viewer';
  if (!archive && !restore) return;
  const action = nodeOf(
    archive
      ? html`<button
          type="button"
          class="danger archive-footer"
          data-item-footer="true"
          data-write="true"
          disabled=${!writable() || state.integrationFormOpen}
          onClick=${() => archiveItem(item, context)}
        >Archive item</button>`
      : html`<button
          type="button"
          data-item-footer="true"
          data-write="true"
          disabled=${!writable() || state.integrationFormOpen}
          onClick=${() => void restoreSharedItem(item, context)}
        >Restore item</button>`,
  );
  const footer =
    context.footer ||
    context.form.querySelector('#editor-footer-actions') ||
    context.form.querySelector('.dialog-foot');
  const cancel = footer?.querySelector('#cancel,.detail-cancel');
  if (footer) footer.insertBefore(action, cancel || footer.lastElementChild);
}
// Renders the editor into `fields` and returns a function that re-renders it
// for a newer revision of the item (after a save in the detail pane). Widgets
// keep their state across that re-render; plain fields show the saved values.
export function buildItemEditor(fields, item, draft, readOnly, context, titleHost) {
  if (item.id && titleHost) decorateItemTitle(titleHost, item);
  const update = mount(fields, itemEditorTemplate(item, draft, readOnly, context));
  if (context?.form) showEditorOverdueBadge(context.form, item);
  addItemFooterAction(item, readOnly, context);
  return (latest) => update(itemEditorTemplate(latest, undefined, readOnly, context));
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
      buildItemEditor(fields, item, draft, readOnly, context, $('editor-title-extra'));
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
    () => html`<p>${`Archive “${item.title}” and remove it from all open sprints? History is retained and the item can be restored. Unsaved editor changes will not be applied.`}</p>
      ${fieldTemplate('reason', 'Archive rationale (optional)', '', 'textarea', undefined, {
        maxLength: 4000,
      })}`,
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
  setEditorSaveText('Archive item');
}
