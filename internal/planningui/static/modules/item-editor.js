// The work-item editor form, its modal and the archive dialog.
import { $, syncDisabled, uid } from './dom.js';
import { itemPayloadFromForm } from './item-command.js';
import { labelForeground } from './format.js';
import { markdownEditorTemplate } from './markdown.js';
import { fieldTemplate, helpTextTemplate } from './layout.js';
import { html } from './vdom.js';
import { useEffect, useLayoutEffect, useRef, useState } from './vendor-preact.js';
import { state, useStore } from './state.js';
import { hooks } from './hooks.js';
import { writable, gitLabWritable } from './permissions.js';
import { itemProjectIDs, labelInfo, blocked } from './items.js';
import { memberName } from './people.js';
import { helpPopoverTemplate, multiSelectTemplate } from './multi-select.js';
import { EditorDueBadge, itemDateStatus, dueDateBadgeTemplate } from './due-dates.js';
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
function DatesField({ item, draft, readOnly }) {
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
    ><span>${text || '-'}</span>${editing && text ? clear(name, title) : null}</span
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
        disabled=${readOnly}
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
                ><span>${`Due · ${due}`}</span>${editing ? clear('due_date', 'Due date') : null}</span
              >`
            : null
        }
      </div>
      <div class="date-field-inputs" id=${inputsID} hidden=${!editing}>
        ${DATE_FIELDS.map(([name, title]) =>
          fieldTemplate(name, title, initial[name], 'date', undefined, {
            disabled: readOnly,
            onInput: () => setRevision((version) => version + 1),
            onChange: () => setRevision((version) => version + 1),
          }),
        )}
      </div>
    </div>
  </div>`;
}
function datesFieldTemplate(item, draft, readOnly) {
  return html`<${DatesField} item=${item} draft=${draft} readOnly=${readOnly} />`;
}
function ItemTitleField({ item, draft, readOnly, dueBadgeID }) {
  const now = useStore((current) => current.dueDateNow);
  return html`<label
    ><span class="item-title-label">Title</span><input
      name="title"
      type="text"
      autocomplete="off"
      required
      maxlength="240"
      aria-label="Title"
      aria-describedby=${dueBadgeID && itemDateStatus(item, now)?.overdue ? dueBadgeID : undefined}
      disabled=${readOnly}
      defaultValue=${draft?.title ?? item.title}
  /></label>`;
}
// The card's own planning state, stated explicitly: where it sits, whether it
// is archived or blocked, and which sprints hold it. GitLab entries are labelled
// as cached provider observations, never as authoritative planning state.
function ItemStatus({ item }) {
  const now = useStore((current) => current.dueDateNow);
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
  const due = itemDateStatus(item, now);
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
        ${blocked(item) ? html`<span class="badge warning">Blocked by dependency</span>` : null}
        ${due && !due.overdue ? dueDateBadgeTemplate(item) : null}
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
            : null
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
          : null
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
export function itemEditorTemplate(item, draft, readOnly, context, dueBadgeID) {
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
  const labelChip = (value) => {
    const label = labelInfo(value);
    return {
      className: 'label-badge',
      style: { backgroundColor: label.color, color: labelForeground(label.color) },
    };
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
      : null;
  return html`${item.id ? html`<${ItemStatus} item=${item} />` : null}
    <div class="item-editor-layout">
      <div class="item-editor-primary">
        <${ItemTitleField} item=${item} draft=${draft} readOnly=${readOnly} dueBadgeID=${dueBadgeID} />
        ${markdownEditorTemplate(
          'description',
          'Description',
          draft?.description ?? item.description,
          16000,
          readOnly,
          true,
        )}
        ${item.id ? itemAttachmentsTemplate(item, readOnly) : null}
        ${item.id ? itemCommentsTemplate(item) : null}
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
            disabled: readOnly,
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
          { disabled: readOnly },
        )}
        ${multiSelectTemplate(
          'project_id',
          'Project',
          [['', 'No project'], ...state.board.projects.map((p) => [p.id, p.name])],
          selectedProjects.length ? selectedProjects : [''],
          undefined,
          'Choose one or more projects to classify this work item. Leave No project selected to keep it unclassified.',
          { emptyValue: '', disabled: readOnly },
        )}
        ${datesFieldTemplate(item, draft, readOnly)}
        ${multiSelectTemplate(
          'sprint_ids',
          'Open sprints',
          state.board.sprints
            .filter((s) => s.state !== 'closed')
            .map((s) => [s.id, `${s.name} (${s.state})`]),
          draft?.sprint_ids ?? item.sprint_ids,
          undefined,
          'Select no open sprint to keep unfinished work in the backlog. One item may span several sprints without creating duplicate cards.',
          { disabled: readOnly },
        )}
        ${
          closed.length
            ? helpTextTemplate(`Closed sprint history (read-only): ${closed.join(', ')}`)
            : null
        }
        ${multiSelectTemplate(
          'dependencies',
          'Depends on',
          state.board.items.filter((i) => i.id !== item.id).map((i) => [i.id, i.title]),
          draft?.dependencies ?? item.dependencies,
          undefined,
          undefined,
          { disabled: readOnly },
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
                {
                  footer: paste?.template,
                  onReady: (controls) => paste?.bind(controls),
                  disabled: readOnly,
                },
              )}${linkActions}`
            : null
        }
        <hr class="item-editor-divider" />
        ${fieldTemplate(
          'column_id',
          'Move to',
          draft?.column_id ?? item.column_id,
          'text',
          state.board.columns.map((c) => [c.id, c.name]),
          { disabled: readOnly },
        )}
      </div>
    </div>`;
}
function CopyCardLinkButton({ item }) {
  const [outcome, setOutcome] = useState('');
  const timer = useRef();
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      clearTimeout(timer.current);
    },
    [],
  );
  async function copy() {
    clearTimeout(timer.current);
    const copied = await copyCardLink(item);
    if (!mounted.current) return;
    setOutcome(copied ? 'copied' : 'failed');
    timer.current = setTimeout(() => {
      if (mounted.current) setOutcome('');
    }, 2000);
  }
  const suffix =
    outcome === 'copied' ? ' is-copied' : outcome === 'failed' ? ' is-copy-failed' : '';
  const label =
    outcome === 'copied' ? '✓ Link copied' : outcome === 'failed' ? '! Not copied' : 'Copy link';
  return html`<button
    type="button"
    class=${`card-link-copy${suffix}`}
    aria-label=${`Copy a link to “${item.title}”`}
    title="Copy a shareable link to this card"
    onClick=${copy}
  >${label}</button>`;
}
export function itemEditorTitleExtrasTemplate(item, revision = item.revision) {
  return html` ${helpPopoverTemplate(`Card ID: ${item.id}\nRevision: ${revision}`, 'Work item details')} <${CopyCardLinkButton} item=${item} />`;
}
// Archive and restore sit before Cancel in either editor surface.
export function itemEditorFooterActionsTemplate(item, readOnly, context) {
  if (item.id && !item.archived && !readOnly)
    return html`<button
      type="button"
      class="danger archive-footer"
      data-item-footer="true"
      data-write="true"
      disabled=${!writable() || state.integrationFormOpen}
      onClick=${() => archiveItem(item, context)}
    >Archive item</button>`;
  if (item.id && item.archived && state.board.role !== 'viewer')
    return html`<button
      type="button"
      data-item-footer="true"
      data-write="true"
      disabled=${!writable() || state.integrationFormOpen}
      onClick=${() => void restoreSharedItem(item, context)}
    >Restore item</button>`;
  return null;
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
  const dueBadgeID = uid('item-title-overdue');
  state.editorItemID = existing ? item.id : '';
  if (existing) setSharedItem(item.id);
  openEditor(
    existing ? 'Work item' : 'Create work item',
    () => itemEditorTemplate(item, draft, readOnly, context, dueBadgeID),
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
    undefined,
    {
      titleExtra: item.id ? itemEditorTitleExtrasTemplate(item) : null,
      titleBadge: html`<${EditorDueBadge} item=${item} id=${dueBadgeID} />`,
      footerAction: itemEditorFooterActionsTemplate(item, readOnly, context),
    },
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
