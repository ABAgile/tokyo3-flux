// The List presentation of the board.
import { columnWIPLabel } from './format.js';
import { emptyStateTemplate } from './layout.js';
import { classNames } from './dom.js';
import { html, memo } from './vdom.js';
import { useEffect, useMemo, useRef } from './vendor-preact.js';

import { setState, state, useStore } from './state.js';
import { projectBadgesTemplate, labelBadgeTemplate } from './items.js';
import { memberName, participantStackTemplate } from './people.js';
import { itemDateStatus, dueDateBadgeTemplate } from './due-dates.js';
import {
  attachmentCount,
  useAttachmentList,
  useItemFileDrop,
  attachmentPaperclipTemplate,
} from './item-attachments.js';
import { mergeEventProps, useDraggable, useDropZone } from './drag.js';
import { cardLinkTemplate, cardObservationIconTemplate, showLinks } from './gitlab.js';
import { ItemDetailPane } from './item-detail.js';
import { prunedBulkSelection, BulkBar } from './bulk.js';
import { closeDetail, selectItem, setBulkSelected } from './actions.js';
import { isEditorOpen } from './dialog-state.js';
import { useFocusRestore } from './ui-hooks.js';
import { ErrorBoundary } from './error-boundary.js';
import { useFocusRequest } from './focus-request.js';
import { cardDropZones, columnDropZones, useBlockedIDs, useRowContext } from './view-board.js';

// Rows and the complete detail form are rendered from shared state. The keyed
// detail component keeps one uncontrolled form lifetime per opened item.
const LIST_HEADINGS = ['Title', 'Project', 'People', 'Labels', 'Sprints', 'Links / Status'];
function listCellTemplate(label, className, content) {
  return html`<div class=${`list-cell ${className}`} data-label=${label}>
    <span class="list-cell-label">${label}</span>
    ${content}
  </div>`;
}
const emptyCell = html`<span class="list-cell-empty">—</span>`;
function rowFocusKey(item) {
  return `item:${item.id}:list-row`;
}
function selectFromRow(event, item) {
  if (event.defaultPrevented || event.target.closest?.('a,button,input,select,textarea,summary'))
    return;
  selectItem(item.id, rowFocusKey(item));
}
function selectFromKey(event, item) {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  selectItem(item.id, rowFocusKey(item));
}
function titleCellTemplate(item, overdue, bulkSelected, context) {
  const selectable = context.role !== 'viewer' && !item.archived;
  const busy = context.busy;
  return listCellTemplate(
    'Title',
    'list-cell-title',
    html`<div class="list-row-title-details">
      <div class="list-row-title-line">
        ${
          selectable
            ? html`<input
                id=${`bulk-select-${item.id}`}
                type="checkbox"
                class="list-row-select"
                checked=${bulkSelected}
                disabled=${busy}
                data-focus-key=${`item:${item.id}:bulk-select`}
                aria-label=${`Select ${item.title} for bulk actions`}
                onClick=${(event) => event.stopPropagation()}
                onChange=${(event) => setBulkSelected(item.id, event.currentTarget.checked)}
              />`
            : null
        }
        <button
          type="button"
          class="list-row-title"
          data-focus-key=${`item:${item.id}:list-title`}
          onClick=${() => selectItem(item.id, rowFocusKey(item))}
        >${item.title}</button>
      </div>
      ${overdue ? dueDateBadgeTemplate(context.lookups, item, context.now, ' list-title-due') : null}
    </div>`,
  );
}
function linksTemplate(item, links) {
  const count = `${links.length} GitLab link${links.length === 1 ? '' : 's'}`;
  return html`<div class="list-row-indicator list-row-links" aria-label=${count}>
    <div class="card-links-head">
      <span class="card-links-label">${`GitLab links · ${links.length}`}</span>
      <button
        type="button"
        class="card-link-details list-row-observation-link"
        data-focus-key=${`item:${item.id}:list-observations`}
        aria-label=${`View observations · ${count}`}
        title="Show linked GitLab observations"
        onClick=${() => showLinks(item)}
      >View observations</button>
    </div>
    ${links.map(
      (link) => html`<span key=${link.id} class="list-row-link-line"
        >${
          link.kind === 'mr'
            ? cardObservationIconTemplate(link, `item:${item.id}:list-observation:${link.id}`)
            : null
        }${cardLinkTemplate(link, `item:${item.id}:list-link:${link.id}`)}</span
      >`,
    )}
  </div>`;
}
function statusCellTemplate(lookups, item, due, isBlocked, links, total, now) {
  const overdue = !!due?.overdue;
  const badges = [
    isBlocked ? html`<span class="badge warning">Blocked</span>` : null,
    due && !overdue ? dueDateBadgeTemplate(lookups, item, now) : null,
    item.archived ? html`<span class="badge">Archived</span>` : null,
  ];
  const hasBadges = isBlocked || (due && !overdue) || item.archived;
  const content = [
    // The badge row stays for an overdue item, whose due badge sits by the title.
    hasBadges || overdue ? html`<div class="list-row-status-badges">${badges}</div>` : null,
    links.length ? linksTemplate(item, links) : null,
    total
      ? html`<span
          class="list-row-indicator list-row-attachments"
          aria-label=${`${total} attachment${total === 1 ? '' : 's'}`}
          >${attachmentPaperclipTemplate()}<span>${String(total)}</span></span
        >`
      : null,
  ];
  const empty = !(hasBadges || overdue || links.length || total);
  return listCellTemplate(
    'Links / Status',
    'list-cell-status',
    empty ? emptyCell : html`<div class="list-row-status-content">${content}</div>`,
  );
}
const NO_LINKS = Object.freeze([]);
/**
 * @param {{ item: Flux.Item, context: Flux.RowContext, isBlocked: boolean,
 *   selected: boolean, bulkSelected: boolean }} props
 */
function ListRowView({ item, context, isBlocked, selected, bulkSelected }) {
  const { lookups, now, canWrite, sprintName } = context;
  const list = useAttachmentList(item.id);
  const drag = useDraggable('card', item.id, () => canWrite && !item.archived);
  const drop = useDropZone(`card:${item.id}`, cardDropZones(item.id));
  const files = useItemFileDrop(item.id);
  const due = itemDateStatus(lookups, item, now);
  const overdue = !!due?.overdue;
  const links = context.linksByItem.get(item.id) || NO_LINKS;
  const total = attachmentCount(item, list);
  const { draggable, ...dragEvents } = drag.props;
  // The list shows the same participant aggregate as a card, and keeps the
  // assignee's name in text so the column stays scannable as a table.
  return html`<article
    class=${classNames({
      'list-row': true,
      'is-overdue': overdue,
      'is-selected': selected,
      'is-bulk-selected': bulkSelected,
      'drag-source': drag.source,
      [drop.className]: !!drop.className,
      [files.className]: !!files.className,
    })}
    data-item=${item.id}
    data-focus-key=${rowFocusKey(item)}
    tabindex="0"
    aria-label=${`Open work item ${item.title}; draggable`}
    aria-current=${selected ? 'true' : null}
    data-drag-type="card"
    draggable=${draggable}
    onClick=${(event) => selectFromRow(event, item)}
    onKeydown=${(event) => selectFromKey(event, item)}
    ...${mergeEventProps(dragEvents, files.props, drop.props)}
  >
    ${titleCellTemplate(item, overdue, bulkSelected, context)}
    ${listCellTemplate(
      'Project',
      'list-cell-project',
      html`<span class="list-row-project">${projectBadgesTemplate(lookups, item)}</span>`,
    )}
    ${listCellTemplate(
      'People',
      'list-cell-people',
      html`<div class="list-row-people">
        ${participantStackTemplate(lookups, item)}
        <span class="list-row-assignee-name">${memberName(lookups, item.assignee)}</span>
      </div>`,
    )}
    ${listCellTemplate(
      'Labels',
      'list-cell-labels',
      item.labels.length ? item.labels.map((name) => labelBadgeTemplate(lookups, name)) : emptyCell,
    )}
    ${listCellTemplate(
      'Sprints',
      'list-cell-sprints',
      item.sprint_ids.length
        ? item.sprint_ids.map(
            (id) => html`<span key=${id} class="badge badge-sprint">${sprintName(id)}</span>`,
          )
        : emptyCell,
    )}
    ${statusCellTemplate(lookups, item, due, isBlocked, links, total, now)}
  </article>`;
}
const ListRow = memo(ListRowView);
// A section's open state belongs to the user: `open` is a static attribute, so
// Preact sets it once and never again.
function ListSection({ column, peers, total, context, blockedIDs, selectedID, bulkIDs }) {
  const drop = useDropZone(`column:${column.id}`, columnDropZones(column.id));
  const drag = useDraggable('list', column.id, () => context.canWrite);
  const { draggable, ...dragEvents } = drag.props;
  return html`<details
    class=${classNames({ 'list-section': true, [drop.className]: !!drop.className })}
    data-column=${column.id}
    open
    aria-label=${column.name}
    ...${drop.props}
  >
    <summary
      class=${classNames({ 'list-section-head': true, 'drag-source': drag.source })}
      data-drag-type="list"
      draggable=${draggable}
      aria-label=${`Drag list ${column.name}`}
      ...${dragEvents}
    >
      <span class="list-section-title"><h3>${column.name}</h3></span>
      <span class="list-section-summary"
        >${`${peers.length} shown · ${columnWIPLabel(column, total)}`}</span
      >
    </summary>
    <div class="list-section-body">
      ${peers.map(
        (item) => html`<${ListRow}
          key=${item.id}
          item=${item}
          context=${context}
          isBlocked=${blockedIDs.has(item.id)}
          selected=${item.id === selectedID}
          bulkSelected=${bulkIDs.has(item.id)}
        />`,
      )}
      ${peers.length ? null : emptyStateTemplate('No work here')}
    </div>
  </details>`;
}
function selectBoard(current) {
  return current.board;
}
function selectSelectedItem(current) {
  return current.selectedItemID;
}
function selectDetail(current) {
  return current.detail;
}
function selectBulkSelection(current) {
  return current.bulkSelection;
}
// Escape in the detail pane closes it, unless a dialog owns Escape; menus
// and fields inside the pane that own Escape stop it before it gets here.
function closeDetailOnEscape(event) {
  if (event.key !== 'Escape' || isEditorOpen()) return;
  if (closeDetail()) event.preventDefault();
  event.stopPropagation();
}
export function ListPresentation({ items }) {
  const board = useStore(selectBoard);
  const selectedID = useStore(selectSelectedItem);
  const detail = useStore(selectDetail);
  const bulkSelection = useStore(selectBulkSelection);
  const bulkIDs = useMemo(() => new Set(bulkSelection), [bulkSelection]);
  const context = useRowContext();
  const blockedIDs = useBlockedIDs(items);
  const root = useRef(null);
  const focus = useFocusRestore(root, 'list');
  useFocusRequest('list', root);
  // Selection keeps to the shown, selectable cards.
  useEffect(() => {
    const next = prunedBulkSelection(state.bulkSelection, items);
    if (next !== state.bulkSelection) setState({ bulkSelection: next });
  }, [items, bulkSelection]);
  const detailOpen = !!(detail && selectedID);
  return html`<div class=${classNames({ 'list-detail-layout': true, 'has-detail': detailOpen })} data-content-view="list:board" ref=${root} ...${focus}>
    <div class="planning-list" data-content-view="planning-list">
      <${BulkBar} items=${items} selection=${bulkSelection} role=${board.role} />
      <div class="list-table-head">
        ${LIST_HEADINGS.map((label) => html`<span key=${label} class="list-table-heading">${label}</span>`)}
      </div>
      <div class="list-sections">
        ${board.columns.map(
          (column) => html`<${ListSection}
            key=${column.id}
            column=${column}
            peers=${items.filter((item) => item.column_id === column.id)}
            total=${board.items.filter((item) => !item.archived && item.column_id === column.id).length}
            context=${context}
            blockedIDs=${blockedIDs}
            selectedID=${selectedID}
            bulkIDs=${bulkIDs}
          />`,
        )}
      </div>
    </div>
    <aside
      class="item-detail-pane"
      hidden=${!detailOpen}
      aria-label="Selected work item"
      onKeyDown=${closeDetailOnEscape}
    >${
      detailOpen
        ? html`<${ErrorBoundary} key=${detail.formKey} label="Item details"
            ><${ItemDetailPane} detail=${detail}
          /></${ErrorBoundary}>`
        : null
    }</aside>
  </div>`;
}
