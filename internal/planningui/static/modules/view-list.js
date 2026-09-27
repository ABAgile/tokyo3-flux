// The List presentation of the board.
import { columnWIPLabel } from './format.js';
import { emptyStateTemplate } from './layout.js';
import { attach, classNames, html, nothing, keyedList, useLayoutEffect } from './preact.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { projectBadgesTemplate, labelBadgeTemplate, blocked, findItem } from './items.js';
import { memberName, participantStackTemplate } from './people.js';
import { itemDateStatus, dueDateBadgeTemplate } from './due-dates.js';
import { filteredItems } from './filters.js';
import {
  attachmentCount,
  itemFileDropZone,
  attachmentPaperclipTemplate,
} from './item-attachments.js';
import { attachDrag, dropZone } from './drag.js';
import { writable } from './permissions.js';
import { cardLinkTemplate, cardObservationIconTemplate, showLinks } from './gitlab.js';
import { syncListSelection, updateDetailPaneVisibility, selectItem } from './item-detail.js';
import { pruneBulkSelection, bulkBarTemplate } from './bulk.js';

// Rows are Preact templates like board cards. Selection (`is-selected`,
// aria-current) belongs to syncListSelection, and the detail pane's content and
// visibility to item-detail, so the templates bind neither.
const LIST_HEADINGS = ['Title', 'Project', 'People', 'Labels', 'Sprints', 'Links / Status'];
function listCellTemplate(label, className, content) {
  return html`<div class=${`list-cell ${className}`} data-label=${label}>
    <span class="list-cell-label">${label}</span>
    ${content}
  </div>`;
}
const emptyCell = html`<span class="list-cell-empty">—</span>`;
function selectFromRow(event, item) {
  if (event.defaultPrevented || event.target.closest?.('a,button,input,select,textarea,summary'))
    return;
  selectItem(item.id, event.currentTarget);
}
function selectFromKey(event, item) {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  selectItem(item.id, event.currentTarget);
}
function toggleBulk(event, item) {
  if (event.currentTarget.checked) state.bulkSelection.add(item.id);
  else state.bulkSelection.delete(item.id);
  hooks.renderContent();
}
function attachRow(node, id) {
  attachDrag(node, 'card', id);
  itemFileDropZone(node, findItem(id));
  dropZone(node, 'card', (dragged, after) => {
    const current = findItem(id);
    if (!current) return undefined;
    const peers = filteredItems().filter((value) => value.column_id === current.column_id);
    const index = peers.findIndex((value) => value.id === current.id);
    return {
      kind: 'item.move',
      target: dragged,
      destination: current.column_id,
      before: after ? peers[index + 1]?.id || '' : current.id,
    };
  });
}
function titleCellTemplate(item, overdue, bulkSelected) {
  const selectable = state.board.role !== 'viewer' && !item.archived;
  const busy = state.busy || state.loading;
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
                onChange=${(event) => toggleBulk(event, item)}
              />`
            : nothing
        }
        <button
          type="button"
          class="list-row-title"
          data-focus-key=${`item:${item.id}:list-title`}
          onClick=${(event) => selectItem(item.id, event.currentTarget.closest('.list-row'))}
        >${item.title}</button>
      </div>
      ${overdue ? dueDateBadgeTemplate(item, ' list-title-due') : nothing}
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
    ${keyedList(
      links,
      (link) => link.id,
      (link) => html`<span class="list-row-link-line"
        >${
          link.kind === 'mr'
            ? cardObservationIconTemplate(link, `item:${item.id}:list-observation:${link.id}`)
            : nothing
        }${cardLinkTemplate(link, `item:${item.id}:list-link:${link.id}`)}</span
      >`,
    )}
  </div>`;
}
function statusCellTemplate(item, due) {
  const overdue = !!due?.overdue;
  const badges = [
    blocked(item) ? html`<span class="badge warning">Blocked</span>` : nothing,
    due && !overdue ? dueDateBadgeTemplate(item) : nothing,
    item.archived ? html`<span class="badge">Archived</span>` : nothing,
  ];
  const hasBadges = blocked(item) || (due && !overdue) || item.archived;
  const links = state.board.links.filter((link) => link.items.includes(item.id));
  const total = attachmentCount(item);
  const content = [
    // The badge row stays for an overdue item, whose due badge sits by the title.
    hasBadges || overdue ? html`<div class="list-row-status-badges">${badges}</div>` : nothing,
    links.length ? linksTemplate(item, links) : nothing,
    total
      ? html`<span
          class="list-row-indicator list-row-attachments"
          aria-label=${`${total} attachment${total === 1 ? '' : 's'}`}
          >${attachmentPaperclipTemplate()}<span>${String(total)}</span></span
        >`
      : nothing,
  ];
  const empty = !(hasBadges || overdue || links.length || total);
  return listCellTemplate(
    'Links / Status',
    'list-cell-status',
    empty ? emptyCell : html`<div class="list-row-status-content">${content}</div>`,
  );
}
function listRowTemplate(item) {
  const due = itemDateStatus(item);
  const overdue = !!due?.overdue;
  const bulkSelected = state.bulkSelection.has(item.id);
  const sprintName = (id) => state.board.sprints.find((s) => s.id === id)?.name || id;
  // The list shows the same participant aggregate as a card, and keeps the
  // assignee's name in text so the column stays scannable as a table.
  return html`<article
    class=${classNames({ 'list-row': true, 'is-overdue': overdue, 'is-bulk-selected': bulkSelected })}
    data-item=${item.id}
    data-focus-key=${`item:${item.id}:list-row`}
    tabindex="0"
    aria-label=${`Open work item ${item.title}; draggable`}
    data-drag-type="card"
    draggable=${writable() && !item.archived}
    ref=${attach(attachRow, item.id)}
    onClick=${(event) => selectFromRow(event, item)}
    onKeydown=${(event) => selectFromKey(event, item)}
  >
    ${titleCellTemplate(item, overdue, bulkSelected)}
    ${listCellTemplate(
      'Project',
      'list-cell-project',
      html`<span class="list-row-project">${projectBadgesTemplate(item)}</span>`,
    )}
    ${listCellTemplate(
      'People',
      'list-cell-people',
      html`<div class="list-row-people">
        ${participantStackTemplate(item)}
        <span class="list-row-assignee-name">${memberName(item.assignee)}</span>
      </div>`,
    )}
    ${listCellTemplate(
      'Labels',
      'list-cell-labels',
      item.labels.length ? item.labels.map(labelBadgeTemplate) : emptyCell,
    )}
    ${listCellTemplate(
      'Sprints',
      'list-cell-sprints',
      item.sprint_ids.length
        ? item.sprint_ids.map(
            (id) => html`<span class="badge badge-sprint">${sprintName(id)}</span>`,
          )
        : emptyCell,
    )}
    ${statusCellTemplate(item, due)}
  </article>`;
}
function attachListSection(section, id) {
  dropZone(
    section,
    'card',
    (dragged) => ({ kind: 'item.move', target: dragged, destination: id }),
    'end',
  );
  dropZone(
    section,
    'list',
    (dragged, after) => {
      const index = state.board.columns.findIndex((value) => value.id === id);
      return {
        kind: 'column.rank',
        target: dragged,
        before: after ? state.board.columns[index + 1]?.id || '' : id,
      };
    },
    'x',
  );
}
// A section's open state belongs to the user: `open` is a static attribute, so
// Preact sets it once and never again.
function listSectionTemplate(column, items) {
  const peers = items.filter((item) => item.column_id === column.id);
  const total = state.board.items.filter(
    (item) => !item.archived && item.column_id === column.id,
  ).length;
  return html`<details
    class="list-section"
    data-column=${column.id}
    open
    aria-label=${column.name}
    ref=${attach(attachListSection, column.id)}
  >
    <summary
      class="list-section-head"
      data-drag-type="list"
      draggable=${writable()}
      aria-label=${`Drag list ${column.name}`}
      ref=${attach(attachDrag, 'list', column.id)}
    >
      <span class="list-section-title"><h3>${column.name}</h3></span>
      <span class="list-section-summary"
        >${`${peers.length} shown · ${columnWIPLabel(column, total)}`}</span
      >
    </summary>
    <div class="list-section-body">
      ${keyedList(peers, (item) => item.id, listRowTemplate)}
      ${peers.length ? nothing : emptyStateTemplate('No work here')}
    </div>
  </details>`;
}
function registerDetailPane(pane) {
  state.detailPane = pane;
}
export function ListPresentation({ items }) {
  pruneBulkSelection(items);
  useLayoutEffect(() => {
    syncListSelection();
    updateDetailPaneVisibility();
  });
  return html`<div class="list-detail-layout" data-content-view="list:board">
    <div class="planning-list" data-content-view="planning-list">
      ${bulkBarTemplate(items)}
      <div class="list-table-head">
        ${LIST_HEADINGS.map((label) => html`<span class="list-table-heading">${label}</span>`)}
      </div>
      <div class="list-sections">
        ${keyedList(
          state.board.columns,
          (column) => column.id,
          (column) => listSectionTemplate(column, items),
        )}
      </div>
    </div>
    <aside
      class="item-detail-pane"
      hidden
      aria-label="Selected work item"
      ref=${attach(registerDetailPane)}
    ></aside>
  </div>`;
}
