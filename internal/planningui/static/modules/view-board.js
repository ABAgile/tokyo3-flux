// The Kanban board: project lens, columns, cards and board setup.
import { columnWIPLabel } from './format.js';
import {
  fieldTemplate,
  helpTextTemplate,
  emptyStateTemplate,
  metricListTemplate,
} from './layout.js';
import { classNames } from './dom.js';
import { html, memo } from './vdom.js';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, h } from './vendor-preact.js';

import { state, useStore, requireBoard } from './state.js';
import { usePermissions, accessButtonTemplate } from './permissions.js';
import {
  itemProjectIDs,
  projectBadgesTemplate,
  labelBadgeTemplate,
  done,
  blocked,
  findItem,
} from './items.js';
import { itemLookup, selectLookups } from './lookups.js';
import { participantStackTemplate } from './people.js';
import { itemDateStatus, dueDateBadgeTemplate, selectDueDateNow } from './due-dates.js';
import { filteredItems } from './filters.js';
import { quick } from './commands.js';
import {
  attachmentCount,
  ensureAttachments,
  useAttachmentList,
  useItemFileDrop,
  attachmentPaperclipTemplate,
  AttachmentTileLink,
  selectBoardGeneration,
} from './item-attachments.js';
import { closeEditor, openDialog } from './dialog-state.js';
import { CommandDialog, FormDialog } from './dialog.js';
import { mergeEventProps, useDraggable, useDropZone } from './drag.js';
import { cardLinkTemplate, cardObservationIconTemplate, showLinks } from './gitlab.js';
import { editItem } from './actions.js';
import { useDismiss, useFocusRestore } from './ui-hooks.js';

/**
 * @param {{
 *   board: Flux.Board | undefined,
 *   lookups: Flux.Lookups,
 *   items: ReadonlyMap<string, Flux.Item>,
 *   view: string,
 *   projectID: string,
 * }} props
 */
export function ProjectSummary({ board, lookups, items: itemsByID, view, projectID }) {
  const project = board?.projects?.find((value) => value.id === projectID);
  const visible = view === 'board' && !!project && !['all', 'none'].includes(projectID);
  const items = visible
    ? (board?.items || []).filter(
        (item) => !item.archived && itemProjectIDs(item).includes(projectID),
      )
    : [];
  const openSprints = visible
    ? (board?.sprints || []).filter(
        (sprint) =>
          sprint.state !== 'closed' && items.some((item) => item.sprint_ids.includes(sprint.id)),
      )
    : [];
  const active = openSprints.filter((sprint) => sprint.state === 'active');
  const completed = items.filter((item) => done(lookups, item)).length;
  const blockedCount = items.filter((item) => blocked(lookups, itemsByID, item)).length;
  const unscheduled = items.filter(
    (item) => !done(lookups, item) && !item.sprint_ids.length,
  ).length;
  const coverage = active.map((sprint) => {
    const count = items.filter((item) => item.sprint_ids.includes(sprint.id)).length;
    return html`<span key=${sprint.id} class="badge">${`${sprint.name} · ${count}`}</span>`;
  });
  return html`<section
    id="project-summary"
    class="panel project-summary"
    hidden=${!visible}
    aria-label=${visible ? `${project.name} project summary` : 'Project summary'}
  >
    ${
      visible
        ? html`<div class="project-summary-head">
          <div class="project-summary-title">
            <p class="eyebrow">PROJECT LENS</p>
            <h2>${`${project.name} project`}</h2>
            ${helpTextTemplate('Current work only · archived history is excluded.')}
          </div>
        </div>
        ${metricListTemplate(
          [
            [items.length, 'In scope'],
            [completed, 'Done'],
            [blockedCount, 'Blocked'],
            [unscheduled, 'Unscheduled'],
          ],
          'project-summary-metrics',
        )}
        <div class="project-sprint-coverage">
          <span class="project-sprint-coverage-label">Active sprint coverage</span>
          ${coverage}
          ${unscheduled ? html`<span class="badge">${`Backlog · ${unscheduled}`}</span>` : null}
          ${!active.length && !unscheduled ? html`<span class="muted">None</span>` : null}
        </div>`
        : null
    }
  </section>`;
}

// Everything a card or list row renders besides its own item: the board
// lookups its templates resolve names with, its links, the due-date clock and
// permissions. Templates read only what the context carries, so a memoized row
// skips rendering exactly when its item, flags and this context are unchanged.
/** @param {Flux.State} current */
function selectBoard(current) {
  return current.board;
}
/** @param {Flux.State} current */
function selectArchiveItems(current) {
  return current.archiveItems;
}
/** @returns {Flux.RowContext} */
export function useRowContext() {
  const links = useStore((current) => current.board?.links);
  const lookups = useStore(selectLookups);
  const now = useStore(selectDueDateNow);
  const { write, writeDisabled, busy, role } = usePermissions();
  const root = useStore((current) => current.root);
  return useMemo(() => {
    /** @type {Map<string, Flux.Link[]>} */
    const linksByItem = new Map();
    for (const link of links || [])
      for (const id of link.items) {
        if (!linksByItem.has(id)) linksByItem.set(id, []);
        linksByItem.get(id)?.push(link);
      }
    return {
      lookups,
      linksByItem,
      sprintName: (/** @type {string} */ id) => lookups.sprintsById.get(id)?.name || id,
      canWrite: write,
      writeDisabled,
      busy,
      role,
      now,
      root,
    };
  }, [links, lookups, write, writeDisabled, busy, role, now, root]);
}
/** @type {readonly never[]} */
const NO_LINKS = Object.freeze([]);
// Blocked flags depend on other cards, so they are computed per list.
/**
 * @param {readonly Flux.Item[]} items
 * @returns {Set<string>}
 */
export function useBlockedIDs(items) {
  const board = useStore(selectBoard);
  const archiveItems = useStore(selectArchiveItems);
  const lookups = useStore(selectLookups);
  return useMemo(() => {
    const byID = itemLookup(board, archiveItems);
    return new Set(items.filter((item) => blocked(lookups, byID, item)).map((item) => item.id));
  }, [items, board?.items, lookups, archiveItems]);
}
// Board cards and List rows are both drop targets for a card: before or after
// the target within its column.
/**
 * @param {string} itemID
 * @returns {Flux.DropZone[]}
 */
export function cardDropZones(itemID) {
  return [
    {
      type: 'card',
      enabled: () => !findItem(itemID, state)?.archived,
      command: (dragged, after) => {
        const current = findItem(itemID, state);
        if (!current) return undefined;
        const peers = filteredItems().filter((value) => value.column_id === current.column_id);
        const index = peers.findIndex((value) => value.id === current.id);
        return {
          kind: 'item.move',
          target: dragged,
          destination: current.column_id,
          before: after ? peers[index + 1]?.id || '' : current.id,
        };
      },
    },
  ];
}
// A column or List section accepts a card at its end and a list before or after it.
/**
 * @param {string} columnID
 * @returns {Flux.DropZone[]}
 */
export function columnDropZones(columnID) {
  return [
    {
      type: 'card',
      axis: 'end',
      command: (dragged) => ({ kind: 'item.move', target: dragged, destination: columnID }),
    },
    {
      type: 'list',
      axis: 'x',
      command: (dragged, after) => {
        const index = requireBoard().columns.findIndex((value) => value.id === columnID);
        return {
          kind: 'column.rank',
          target: dragged,
          before: after ? requireBoard().columns[index + 1]?.id || '' : columnID,
        };
      },
    },
  ];
}

/**
 * @param {MouseEvent} event
 * @param {Flux.Item} item
 */
function openCardFromClick(event, item) {
  if (
    event.defaultPrevented ||
    /** @type {Element | null} */ (event.target)?.closest?.(
      'a,button,input,select,textarea,summary',
    )
  )
    return;
  editItem(item);
}
/**
 * @param {KeyboardEvent} event
 * @param {Flux.Item} item
 */
function openCardFromKey(event, item) {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  editItem(item);
}
/**
 * @param {Flux.Item} item
 * @param {readonly Flux.Link[]} links
 */
function cardLinksTemplate(item, links) {
  return html`<div class="card-links-section" role="group" aria-label="GitLab links">
    <div class="card-links-head">
      <span class="card-links-label">${`GitLab links · ${links.length}`}</span>
      <button
        type="button"
        class="card-link-details"
        data-focus-key=${`item:${item.id}:observations`}
        aria-label=${`View GitLab details · ${links.length}`}
        title="Show linked GitLab observations"
        onClick=${() => showLinks(item)}
      >View observations</button>
    </div>
    <div class="card-links" aria-label="GitLab links">
      ${links.map(
        (link) => html`<${Fragment} key=${link.id}
          >${
            link.kind === 'mr'
              ? cardObservationIconTemplate(link, `item:${item.id}:observation:${link.id}`)
              : null
          }${cardLinkTemplate(link, `item:${item.id}:link:${link.id}`)}</${Fragment}
        >`,
      )}
    </div>
  </div>`;
}
// The disclosure's open state belongs to the board, so it survives a card
// moving between columns; expanding it is what pays for the metadata read.
/**
 * @param {{
 *   root: string | undefined,
 *   item: Flux.Item,
 *   total: number,
 *   list: Flux.Attachment[] | undefined,
 *   open: boolean,
 *   onToggle: (id: string, open: boolean) => void,
 * }} props
 */
function CardAttachments({ root, item, total, list, open, onToggle }) {
  const ref = useRef(/** @type {HTMLDetailsElement | null} */ (null));
  const generation = useStore(selectBoardGeneration);
  const count = `${total} attachment${total === 1 ? '' : 's'}`;
  useDismiss(ref, open, () => onToggle(item.id, false), { closeOnEscape: false });
  useEffect(() => {
    if (open && !Array.isArray(list)) void ensureAttachments(item.id);
  }, [open, list, generation, item.id]);
  return html`<details
    class="card-attachments"
    data-state-key=${`item:${item.id}:attachments`}
    aria-label=${count}
    open=${open}
    ref=${ref}
    onToggle=${(/** @type {Flux.TargetEvent<HTMLDetailsElement>} */ event) => {
      if (event.currentTarget.open !== open) onToggle(item.id, event.currentTarget.open);
    }}
  >
    <summary class="card-attachments-head">
      ${attachmentPaperclipTemplate()}
      <span class="card-attachments-label">Attachments</span>
      <span class="card-attachments-count">${total}</span>
      <span class="card-attachments-toggle" aria-hidden="true"></span>
    </summary>
    <div class="card-attachment-list">
      ${
        Array.isArray(list)
          ? list.map(
              (attachment) => html`<${AttachmentTileLink}
                key=${attachment.id}
                item=${item}
                attachment=${attachment}
                base=${root}
                extraClass=" card-attachment-option"
              />`,
            )
          : emptyStateTemplate('Loading attachments…')
      }
    </div>
  </details>`;
}
/** @param {Flux.CardProps} props */
function CardView({ item, context, isBlocked, attachmentsOpen, onAttachmentsToggle }) {
  const { lookups, now, canWrite, writeDisabled, sprintName } = context;
  const list = useAttachmentList(item.id);
  const drag = useDraggable('card', item.id, () => canWrite && !item.archived);
  const drop = useDropZone(`card:${item.id}`, cardDropZones(item.id));
  const files = useItemFileDrop(item.id);
  const overdue = !!itemDateStatus(lookups, item, now)?.overdue;
  const links = context.linksByItem.get(item.id) || NO_LINKS;
  const total = attachmentCount(item, list);
  const { draggable, ...dragEvents } = drag.props;
  return html`<article
    class=${classNames({
      card: true,
      'is-overdue': overdue,
      'drag-source': drag.source,
      [drop.className]: !!drop.className,
      [files.className]: !!files.className,
    })}
    data-item=${item.id}
    data-focus-key=${`item:${item.id}:card`}
    data-drag-type="card"
    draggable=${draggable}
    tabindex="0"
    aria-label=${`Open work item ${item.title}; draggable`}
    onClick=${(/** @type {MouseEvent} */ event) => openCardFromClick(event, item)}
    onKeydown=${(/** @type {KeyboardEvent} */ event) => openCardFromKey(event, item)}
    ...${mergeEventProps(dragEvents, files.props, drop.props)}
  >
    <div class=${classNames({ 'card-top': true, 'card-top-overdue': overdue })}>
      <button
        type="button"
        class="card-title"
        data-focus-key=${`item:${item.id}:title`}
        onClick=${() => editItem(item)}
      >${item.title}</button>
      ${overdue ? dueDateBadgeTemplate(lookups, item, now, ' card-title-due') : null}
    </div>
    <div class="card-meta">
      <div class="card-projects">${projectBadgesTemplate(lookups, item)}</div>
      ${participantStackTemplate(lookups, item)}
    </div>
    <div class="tags" data-card-section="sprints">
      ${item.sprint_ids.map(
        (id) =>
          html`<span key=${id} class="badge badge-sprint" data-sprint-id=${id}>${sprintName(id)}</span>`,
      )}
    </div>
    <div class="tags" data-card-section="labels">
      ${item.labels.map((name) => labelBadgeTemplate(lookups, name))}
      ${isBlocked ? html`<span class="badge warning">Blocked by dependency</span>` : null}
      ${overdue ? null : dueDateBadgeTemplate(lookups, item, now)}
      ${item.archived ? html`<span class="badge">Archived</span>` : null}
    </div>
    ${
      item.archived
        ? html`<div class="card-controls">
            <button
              type="button"
              disabled=${writeDisabled}
              onClick=${() => quick({ kind: 'item.restore', target: item.id })}
            >Restore item</button>
          </div>`
        : null
    }
    ${links.length ? cardLinksTemplate(item, links) : null}
    ${
      total
        ? html`<${CardAttachments}
            root=${context.root}
            item=${item}
            total=${total}
            list=${list}
            open=${attachmentsOpen}
            onToggle=${onAttachmentsToggle}
          />`
        : null
    }
  </article>`;
}
export const Card = memo(CardView);
// Open card-attachment disclosures, by item id, for one list of cards.
/** @returns {[Set<string>, (id: string, open: boolean) => void]} */
export function useExpandedAttachments() {
  const [expanded, setExpanded] = useState(() => /** @type {Set<string>} */ (new Set()));
  const toggle = useCallback((/** @type {string} */ id, /** @type {boolean} */ open) => {
    setExpanded((current) => {
      if (current.has(id) === open) return current;
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  return [expanded, toggle];
}
/**
 * @param {{
 *   column: Flux.Column,
 *   peers: Flux.Item[],
 *   total: number,
 *   context: Flux.RowContext,
 *   blockedIDs: Set<string>,
 *   expanded: Set<string>,
 *   onAttachmentsToggle: (id: string, open: boolean) => void,
 * }} props
 */
function Column({ column, peers, total, context, blockedIDs, expanded, onAttachmentsToggle }) {
  const drop = useDropZone(`column:${column.id}`, columnDropZones(column.id));
  const drag = useDraggable('list', column.id, () => context.canWrite);
  const { draggable, ...dragEvents } = drag.props;
  return html`<section
    class=${classNames({ column: true, [drop.className]: !!drop.className })}
    data-column=${column.id}
    aria-label=${column.name}
    ...${drop.props}
  >
    <div
      class=${classNames({ 'column-head': true, 'drag-source': drag.source })}
      data-drag-type="list"
      draggable=${draggable}
      aria-label=${`Drag list ${column.name}`}
      ...${dragEvents}
    >
      <h3>${column.name}</h3>
      <small>${`${peers.length} shown · ${columnWIPLabel(column, total)}`}</small>
    </div>
    ${peers.map((item) =>
      h(Card, {
        key: item.id,
        item,
        context,
        isBlocked: blockedIDs.has(item.id),
        attachmentsOpen: expanded.has(item.id),
        onAttachmentsToggle,
      }),
    )}
    ${peers.length ? null : emptyStateTemplate('No work here')}
  </section>`;
}
/** @param {{ items: readonly Flux.Item[] }} props */
export function BoardContent({ items }) {
  const board = /** @type {Flux.Board} */ (useStore(selectBoard));
  const context = useRowContext();
  const blockedIDs = useBlockedIDs(items);
  const [expanded, toggle] = useExpandedAttachments();
  const root = useRef(/** @type {HTMLDivElement | null} */ (null));
  const focus = useFocusRestore(root, 'board');
  return html`<div class="board" data-content-view="board" ref=${root} ...${focus}>
    ${board.columns.map(
      (column) => html`<${Column}
        key=${column.id}
        column=${column}
        peers=${items.filter((item) => item.column_id === column.id)}
        total=${board.items.filter((item) => !item.archived && item.column_id === column.id).length}
        context=${context}
        blockedIDs=${blockedIDs}
        expanded=${expanded}
        onAttachmentsToggle=${toggle}
      />`,
    )}
  </div>`;
}

// ── Board setup dialogs ─────────────────────────────────────────────────────

/** @param {Flux.DialogProps['column.edit']} props */
export function ColumnDialog({ column }) {
  const existing = !!column;
  /** @type {Partial<Flux.Column>} */
  const value = column || { name: '', category: 'todo', wip: 0 };
  return h(
    CommandDialog,
    {
      title: existing ? 'Edit board column' : 'Add board column',
      command: (data) => ({
        kind: 'column.save',
        target: value.id || '',
        column: {
          ...value,
          name: String(data.get('name') || '').trim(),
          category: String(data.get('category') || ''),
          wip: Number(data.get('wip')),
        },
      }),
    },
    html`
      ${fieldTemplate('name', 'Column name', value.name, 'text', undefined, {
        required: true,
        maxLength: 80,
      })}
      ${fieldTemplate('category', 'Lifecycle category', value.category, 'text', [
        ['todo', 'To do'],
        ['doing', 'In progress'],
        ['done', 'Done'],
      ])}
      ${fieldTemplate(
        'wip',
        'WIP limit · 0 means unlimited',
        String(value.wip),
        'number',
        undefined,
        {
          min: 0,
          max: 1000,
          required: true,
        },
      )}
      ${helpTextTemplate(
        'WIP counts all non-archived cards in this column, across sprints and backlog. A limit cannot be lowered below current occupancy.',
      )}
    `,
  );
}
/** @param {Flux.DialogProps['column.remove']} props */
export function RemoveColumnDialog({ column, destinations }) {
  return h(
    CommandDialog,
    {
      title: 'Remove column & move cards',
      command: (data) => ({
        kind: 'column.delete',
        target: column.id,
        destination: String(data.get('destination') || ''),
      }),
    },
    html`
      <p>${`All cards in ${column.name}, including archived ones, must move to another column.`}</p>
      ${fieldTemplate('destination', 'Destination column', '', 'text', destinations)}
    `,
  );
}
/**
 * @param {Flux.Column[]} columns
 * @param {Flux.Column} column
 * @param {number} index
 */
async function moveColumnLeft(columns, column, index) {
  await quick({ kind: 'column.rank', target: column.id, before: columns[index - 1].id });
  closeEditor();
}
// A snapshot of the columns when the dialog opened; each action opens its own
// dialog, and a reorder closes setup.
/** @param {Flux.DialogProps['board.setup']} props */
export function BoardSetupDialog({ columns }) {
  const action = (/** @type {string} */ text, /** @type {() => unknown} */ fn) =>
    accessButtonTemplate(text, fn, { tracked: false });
  return h(
    FormDialog,
    { title: 'Board setup', readOnly: true },
    html`
    ${helpTextTemplate(
      'Configure columns, lifecycle categories, ordering, and WIP policy. All changes are revision checked.',
    )}
    ${columns.map(
      (c, index) => html`<div key=${c.id} class="setup-row">
        <strong>${c.name}</strong>
        <small class="muted">${`${c.category} · WIP ${c.wip || 'unlimited'}`}</small>
        <div class="actions">
          ${action('Edit', () => openDialog('column.edit', { column: c }))}
          ${index > 0 ? action('Move left', () => moveColumnLeft(columns, c, index)) : null}
          ${
            columns.length > 1
              ? action('Remove…', () =>
                  openDialog('column.remove', {
                    column: c,
                    destinations: columns
                      .filter((v) => v.id !== c.id)
                      .map((v) => /** @type {[string, string]} */ ([v.id, v.name])),
                  }),
                )
              : null
          }
        </div>
      </div>`,
    )}
    ${accessButtonTemplate('＋ Add column', () => openDialog('column.edit', {}), {
      className: 'primary',
      tracked: false,
    })}
  `,
  );
}
export function setupBoard() {
  if (!state.board) return;
  openDialog('board.setup', { columns: state.board.columns });
}
