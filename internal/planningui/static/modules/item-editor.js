// The work-item editor fields, its modal dialog and the archive dialog.
import { itemPayloadFromForm } from './item-command.js';
import { labelForeground } from './format.js';
import { markdownEditorTemplate } from './markdown.js';
import { fieldTemplate, helpTextTemplate } from './layout.js';
import { html } from './vdom.js';
import { useEffect, useId, useLayoutEffect, useRef, useState, h } from './vendor-preact.js';
import { state, useStore, requireBoard } from './state.js';
import { usePermissions, writable } from './permissions.js';
import { itemProjectIDs, labelInfo, blocked } from './items.js';
import { itemLookup, selectLookups } from './lookups.js';
import { memberName } from './people.js';
import { helpPopoverTemplate, MultiSelect } from './multi-select.js';
import {
  EditorDueBadge,
  itemDateStatus,
  dueDateBadgeTemplate,
  selectDueDateNow,
} from './due-dates.js';
import { UNDO_TTL, offerUndo } from './notices.js';
import { quick } from './commands.js';
import { itemAttachmentsTemplate } from './item-attachments.js';
import { closeEditor, openDialog } from './dialog-state.js';
import { CommandDialog, useCloseGuard } from './dialog.js';
import { linkDisplayName, cardObservationIconTemplate, showLinks } from './gitlab.js';
import { itemCommentsTemplate } from './item-comments.js';
import { copyCardLink } from './url-state.js';
import { closeDetail, openSharedItem } from './actions.js';
import { useCommittedChange } from './ui-hooks.js';
import { GitLabPaste, addGitLabLink, reconcileItemLinks } from './item-links.js';

/**
 * @param {HTMLFormElement} form
 * @returns {Flux.ItemDraft}
 */
export function itemEditorDraft(form) {
  const data = new FormData(form);
  const all = (/** @type {string} */ name) => /** @type {string[]} */ (data.getAll(name));
  return {
    title: String(data.get('title') || ''),
    description: String(data.get('description') || ''),
    start_date: String(data.get('start_date') || ''),
    end_date: String(data.get('end_date') || ''),
    due_date: String(data.get('due_date') || ''),
    column_id: String(data.get('column_id') || ''),
    project_ids: all('project_id').filter(Boolean),
    assignee: String(data.get('assignee') || ''),
    sprint_ids: all('sprint_ids'),
    labels: all('labels'),
    dependencies: all('dependencies'),
    link_ids: all('link_ids'),
  };
}
// A comparable snapshot of the form's editable fields.
/** @param {HTMLFormElement | null} form */
export function draftSignature(form) {
  try {
    return JSON.stringify(itemEditorDraft(/** @type {HTMLFormElement} */ (form)));
  } catch {
    return '';
  }
}
// Whether the form differs from the snapshot taken when it opened, counting an
// unsent comment as unsaved input.
/**
 * @param {HTMLFormElement} form
 * @param {string} initial
 */
export function editorDirty(form, initial) {
  const comment = String(new FormData(form).get('comment_body') || '').trim();
  return draftSignature(form) !== initial || !!comment;
}
// Offers to save unsaved input before an outside click closes the editor.
// Declining keeps the editor open, so nothing is discarded by accident.
/**
 * @param {HTMLFormElement} form
 * @param {string} title
 */
export function confirmSaveBeforeClose(form, title) {
  if (!form.checkValidity()) {
    form.reportValidity();
    return false;
  }
  return window.confirm(`Save changes to “${title || 'this item'}” before closing?`);
}
/** @type {['start_date' | 'end_date' | 'due_date', string][]} */
const DATE_FIELDS = [
  ['start_date', 'Start date'],
  ['end_date', 'End date'],
  ['due_date', 'Due date'],
];
// The date inputs are controlled by the field, and chips summarise them.
// Committed changes are reported through `onChange`.
/**
 * @param {{
 *   item: Flux.Item,
 *   draft?: Flux.ItemDraft,
 *   readOnly: boolean,
 *   onChange?: () => void,
 * }} props
 */
function DatesField({ item, draft, readOnly, onChange }) {
  const inputsID = `item-dates-${useId()}`;
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState(() =>
    Object.fromEntries(
      DATE_FIELDS.map(([name]) => [name, String(draft?.[name] ?? item[name] ?? '')]),
    ),
  );
  /** @type {{ current: Record<string, HTMLInputElement | null> }} */
  const inputs = useRef({});
  const edit = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const wasEditing = useRef(false);
  useCommittedChange(values, onChange);
  const setValue = (/** @type {string} */ name, /** @type {string} */ value) =>
    setValues((current) => ({ ...current, [name]: value }));
  const clear = (/** @type {string} */ name, /** @type {string} */ title) => html`<button
    type="button"
    class="multi-select-remove"
    aria-label=${`Clear ${title.toLowerCase()}`}
    onClick=${() => {
      setValue(name, '');
      inputs.current[name]?.focus();
    }}
  >×</button>`;
  const toggle = () => setEditing((previous) => !previous);
  useLayoutEffect(() => {
    if (!wasEditing.current && editing) inputs.current.start_date?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const { start_date: start, end_date: end, due_date: due } = values;
  const part = (
    /** @type {string} */ name,
    /** @type {string} */ title,
    /** @type {string} */ text,
  ) => html`<span class="date-range-part"
    ><span>${text || '-'}</span>${editing && text ? clear(name, title) : null}</span
  >`;
  return html`<div class="multi-select-field date-field">
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
        ref=${edit}
        onClick=${toggle}
      >${editing ? 'Done' : 'Edit'}</button>
    </div>
    <div
      class="multi-select date-field-content"
      role="group"
      aria-label="Dates"
      onKeydown=${(/** @type {KeyboardEvent} */ event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (!editing) return;
        toggle();
        edit.current?.focus();
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
        ${DATE_FIELDS.map(
          ([name, title]) => html`<label key=${name}
            >${title}<input
              name=${name}
              type="date"
              autocomplete="off"
              disabled=${readOnly}
              value=${values[name]}
              ref=${(/** @type {HTMLInputElement | null} */ node) => {
                inputs.current[name] = node;
              }}
              onInput=${(/** @type {Flux.TargetEvent<HTMLInputElement>} */ event) => setValue(name, event.currentTarget.value)}
          /></label>`,
        )}
      </div>
    </div>
  </div>`;
}
/**
 * @param {{
 *   item: Flux.Item,
 *   draft?: Flux.ItemDraft,
 *   readOnly: boolean,
 *   dueBadgeID?: string,
 *   inputRef?: { current: HTMLInputElement | null },
 * }} props
 */
function ItemTitleField({ item, draft, readOnly, dueBadgeID, inputRef }) {
  const now = useStore(selectDueDateNow);
  const lookups = useStore(selectLookups);
  return html`<label
    ><span class="item-title-label">Title</span><input
      name="title"
      type="text"
      autocomplete="off"
      required
      maxlength="240"
      aria-label="Title"
      aria-describedby=${dueBadgeID && itemDateStatus(lookups, item, now)?.overdue ? dueBadgeID : undefined}
      disabled=${readOnly}
      defaultValue=${draft?.title ?? item.title}
      ref=${inputRef}
  /></label>`;
}
// The card's own planning state, stated explicitly: where it sits, whether it
// is archived or blocked, and which sprints hold it. GitLab entries are labelled
// as cached provider observations, never as authoritative planning state.
/** @param {Flux.State} current */
function selectItemLookup(current) {
  return itemLookup(current.board, current.archiveItems);
}
/** @type {Record<string, string>} */
const CATEGORY_LABELS = { todo: 'To do', doing: 'In progress', done: 'Done' };
/** @param {{ item: Flux.Item }} props */
function ItemStatus({ item }) {
  const now = useStore(selectDueDateNow);
  const lookups = useStore(selectLookups);
  const byID = useStore(selectItemLookup);
  const column = lookups.columnsById.get(item.column_id);
  const category = (column && CATEGORY_LABELS[column.category]) || 'Uncategorised';
  const columnName = column?.name || item.column_id;
  const sprintName = (/** @type {string} */ id) => lookups.sprintsById.get(id)?.name || id;
  const openSprints = (item.sprint_ids || []).map(sprintName);
  const board = requireBoard();
  const closedSprints = board.closed_scope
    .filter((scope) => scope.item_id === item.id)
    .map((scope) => sprintName(scope.sprint_id));
  const links = board.links.filter((link) => link.items.includes(item.id));
  const due = itemDateStatus(lookups, item, now);
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
        ${blocked(lookups, byID, item) ? html`<span class="badge warning">Blocked by dependency</span>` : null}
        ${due && !due.overdue ? dueDateBadgeTemplate(lookups, item, now) : null}
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
                  (link) => html`<div key=${link.id} class="item-status-link">
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
/**
 * @param {Flux.Item} item
 * @param {Flux.EditorMode} mode
 */
async function restoreSharedItem(item, mode) {
  if (!writable()) return;
  await quick({ kind: 'item.restore', target: item.id });
  if (!state.board) return;
  if (mode === 'modal') closeEditor();
  else closeDetail({ force: true, focus: false });
  await openSharedItem(item.id);
}
// The editor fields shared by the modal and the List detail pane. `mode` is
// 'modal' or 'detail'; `getDraft()` reads the enclosing form's input, and
// `onChange` hears committed widget changes for draft tracking.
/**
 * @param {{
 *   item: Flux.Item,
 *   draft?: Flux.ItemDraft,
 *   readOnly: boolean,
 *   mode: Flux.EditorMode,
 *   dueBadgeID?: string,
 *   titleRef?: { current: HTMLInputElement | null },
 *   getDraft?: () => Flux.ItemDraft | undefined,
 *   originFocusKey?: string,
 *   onChange?: () => void,
 * }} props
 */
export function ItemEditorFields({
  item,
  draft,
  readOnly,
  mode,
  dueBadgeID,
  titleRef,
  getDraft,
  originFocusKey,
  onChange,
}) {
  const board = requireBoard();
  const lookups = useStore(selectLookups);
  const { gitlab } = usePermissions();
  const selfSubject = board.members.find(
    (member) => member.subject === state.session?.subject,
  )?.subject;
  const assignMe =
    !readOnly && selfSubject
      ? (/** @type {{ select: (value: Flux.SelectValue) => boolean }} */ { select }) =>
          html`<button
            type="button"
            class="multi-select-edit"
            aria-label="Assign me"
            onClick=${() => select(selfSubject)}
          >Assign me</button>`
      : undefined;
  const selectedProjects = draft?.project_ids ?? itemProjectIDs(item);
  const closed = board.closed_scope
    .filter((s) => s.item_id === item.id)
    .map((scope) => board.sprints.find((s) => s.id === scope.sprint_id)?.name || scope.sprint_id);
  const itemLinks = item.id ? board.links.filter((link) => link.items.includes(item.id)) : [];
  const labelChip = (/** @type {string} */ value) => {
    const label = labelInfo(lookups, value);
    return {
      className: 'label-badge',
      style: { backgroundColor: label.color, color: labelForeground(label.color) },
    };
  };
  const origin = () => ({ mode, draft: getDraft?.(), originFocusKey });
  const linkActions = !readOnly
    ? html`<div class="actions">
        <button
          type="button"
          data-gitlab-write="true"
          disabled=${!gitlab}
          onClick=${() => addGitLabLink(item, origin())}
        >Add link</button>
      </div>`
    : itemLinks.length
      ? html`<div class="actions">
          <button type="button" onClick=${() => showLinks(item)}>View observations</button>
        </div>`
      : null;
  return html`${item.id ? html`<${ItemStatus} item=${item} />` : null}
    <div class="item-editor-layout">
      <div class="item-editor-primary">
        <${ItemTitleField} item=${item} draft=${draft} readOnly=${readOnly} dueBadgeID=${dueBadgeID} inputRef=${titleRef} />
        ${markdownEditorTemplate(
          'description',
          'Description',
          draft?.description ?? item.description,
          16000,
          readOnly,
          true,
        )}
        ${item.id ? itemAttachmentsTemplate(item, readOnly) : null}
        ${item.id ? itemCommentsTemplate(item, onChange) : null}
      </div>
      <div class="item-editor-controls">
        ${h(MultiSelect, {
          name: 'assignee',
          title: 'Assignee',
          entries: [
            ['', 'Unassigned'],
            ...board.members.map((m) => [m.subject, memberName(lookups, m.subject)]),
          ],
          defaultValue: [draft?.assignee ?? item.assignee],
          single: true,
          disabled: readOnly,
          headingAction: assignMe,
          onChange,
        })}
        ${h(MultiSelect, {
          name: 'labels',
          title: 'Labels',
          entries: board.labels.map((label) => [label.name, label.name]),
          defaultValue: draft?.labels ?? item.labels,
          decorate: labelChip,
          helpText:
            'Use Edit to add labels and × to remove them. Manage available labels from the Labels view.',
          disabled: readOnly,
          onChange,
        })}
        ${h(MultiSelect, {
          name: 'project_id',
          title: 'Project',
          entries: [['', 'No project'], ...board.projects.map((p) => [p.id, p.name])],
          defaultValue: selectedProjects.length ? selectedProjects : [''],
          helpText:
            'Choose one or more projects to classify this work item. Leave No project selected to keep it unclassified.',
          emptyValue: '',
          disabled: readOnly,
          onChange,
        })}
        <${DatesField} item=${item} draft=${draft} readOnly=${readOnly} onChange=${onChange} />
        ${h(MultiSelect, {
          name: 'sprint_ids',
          title: 'Open sprints',
          entries: board.sprints
            .filter((s) => s.state !== 'closed')
            .map((s) => [s.id, `${s.name} (${s.state})`]),
          defaultValue: draft?.sprint_ids ?? item.sprint_ids,
          helpText:
            'Select no open sprint to keep unfinished work in the backlog. One item may span several sprints without creating duplicate cards.',
          disabled: readOnly,
          onChange,
        })}
        ${closed.length ? helpTextTemplate(`Closed sprint history (read-only): ${closed.join(', ')}`) : null}
        ${h(MultiSelect, {
          name: 'dependencies',
          title: 'Depends on',
          entries: board.items.filter((i) => i.id !== item.id).map((i) => [i.id, i.title]),
          defaultValue: draft?.dependencies ?? item.dependencies,
          disabled: readOnly,
          onChange,
        })}
        ${
          item.id
            ? html`${h(MultiSelect, {
                name: 'link_ids',
                title: 'GitLab links',
                entries: board.links.map((link) => [link.id, linkDisplayName(link)]),
                defaultValue: draft?.link_ids ?? itemLinks.map((link) => link.id),
                helpText:
                  'Select registered merge requests to associate with this card. Paste a new MR URL below or use Add link when it is not listed.',
                footer: readOnly
                  ? null
                  : html`<${GitLabPaste}
                        item=${item}
                        readOnly=${readOnly}
                        mode=${mode}
                        getDraft=${getDraft}
                        originFocusKey=${originFocusKey}
                      />`,
                disabled: readOnly,
                onChange,
              })}${linkActions}`
            : null
        }
        <hr class="item-editor-divider" />
        ${fieldTemplate(
          'column_id',
          'Move to',
          draft?.column_id ?? item.column_id,
          'text',
          board.columns.map((c) => [c.id, c.name]),
          { disabled: readOnly },
        )}
      </div>
    </div>`;
}
/** @param {{ item: Flux.Item }} props */
function CopyCardLinkButton({ item }) {
  const [outcome, setOutcome] = useState('');
  const timer = useRef(/** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined));
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
/**
 * @param {Flux.Item} item
 * @param {number | undefined} [revision]
 */
export function itemEditorTitleExtrasTemplate(item, revision = item.revision) {
  return html` ${helpPopoverTemplate(`Card ID: ${item.id}\nRevision: ${revision}`, 'Work item details', 'info')} <${CopyCardLinkButton} item=${item} />`;
}
// Archive and restore sit before Cancel in either editor surface.
/** @param {{ item: Flux.Item, readOnly?: boolean, mode: Flux.EditorMode }} props */
export function ItemFooterActions({ item, readOnly, mode }) {
  const { role, writeDisabled } = usePermissions();
  if (item.id && !item.archived && !readOnly)
    return html`<button
      type="button"
      class="danger archive-footer"
      data-item-footer="true"
      data-write="true"
      disabled=${writeDisabled}
      onClick=${() => openDialog('item.archive', { item, mode })}
    >Archive item</button>`;
  if (item.id && item.archived && role !== 'viewer')
    return html`<button
      type="button"
      data-item-footer="true"
      data-write="true"
      disabled=${writeDisabled}
      onClick=${() => void restoreSharedItem(item, mode)}
    >Restore item</button>`;
  return null;
}
// The modal editor for a new or existing card, opened with the card snapshot
// and any draft carried over from another surface.
/** @param {Flux.DialogProps['item.edit']} props */
export function ItemEditorDialog({ item, draft, readOnly }) {
  const existing = !!item.id;
  const dueBadgeID = `item-title-overdue-${useId()}`;
  const form = useRef(/** @type {HTMLFormElement | null} */ (null));
  const desiredLinkIDs = useRef(/** @type {FormDataEntryValue[]} */ ([]));
  const getDraft = () => (form.current ? itemEditorDraft(form.current) : undefined);
  // Like the List pane, changes are measured against the form as it opened,
  // including a draft carried over from the Add link dialog.
  const initial = useRef('');
  useLayoutEffect(() => {
    initial.current = draftSignature(form.current);
  }, []);
  // Unsaved input is never lost silently: a click outside offers to save, and
  // Cancel, the close button or Escape ask before discarding.
  useCloseGuard((reason) => {
    const node = form.current;
    if (readOnly || !node || !editorDirty(node, initial.current)) return false;
    const title = String(new FormData(node).get('title') || item.title);
    if (reason === 'dismiss')
      return !window.confirm(`Discard unsaved changes to “${title || 'this item'}”?`);
    if (confirmSaveBeforeClose(node, title)) node.requestSubmit();
    return true;
  });
  return h(
    CommandDialog,
    {
      title: existing ? 'Work item' : 'Create work item',
      className: 'item-editor-form',
      formRef: form,
      readOnly,
      titleExtra: existing ? itemEditorTitleExtrasTemplate(/** @type {Flux.Item} */ (item)) : null,
      titleBadge: html`<${EditorDueBadge} item=${item} id=${dueBadgeID} />`,
      footerAction: html`<${ItemFooterActions} item=${item} readOnly=${readOnly} mode="modal" />`,
      command: (data) => {
        if (existing) desiredLinkIDs.current = data.getAll('link_ids');
        return {
          kind: existing ? 'item.update' : 'item.create',
          target: item.id || '',
          item: itemPayloadFromForm(data, item),
        };
      },
      afterSave: existing
        ? () => reconcileItemLinks(/** @type {string} */ (item.id), desiredLinkIDs.current)
        : undefined,
    },
    html`<${ItemEditorFields}
    item=${item}
    draft=${draft}
    readOnly=${readOnly}
    mode="modal"
    dueBadgeID=${dueBadgeID}
    getDraft=${getDraft}
  />`,
  );
}
/** @param {Flux.DialogProps['item.archive']} props */
export function ArchiveItemDialog({ item, mode }) {
  return h(
    CommandDialog,
    {
      title: 'Archive work item',
      saveText: 'Archive item',
      command: (data) => ({
        kind: 'item.archive',
        target: item.id,
        reason: String(data.get('reason') || ''),
      }),
      afterSave: () => {
        offerUndo(`Archived “${item.title}” · undo is available for ${UNDO_TTL / 1000} seconds`, {
          kind: 'item.restore',
          target: item.id,
          restore_sprint_ids: [...(item.sprint_ids || [])],
        });
        if (mode === 'detail') closeDetail({ force: true, focus: true });
      },
    },
    html`
      <p>${`Archive “${item.title}” and remove it from all open sprints? History is retained and the item can be restored. Unsaved editor changes will not be applied.`}</p>
      ${fieldTemplate('reason', 'Archive rationale (optional)', '', 'textarea', undefined, {
        maxLength: 4000,
      })}
    `,
  );
}
