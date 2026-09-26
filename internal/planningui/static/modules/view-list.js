// The List presentation of the board.
import { el, button, syncAttributes } from './dom.js';
import { columnWIPLabel } from './format.js';
import { contentRoot, emptyState } from './layout.js';
import { state } from './state.js';
import {
  projectName,
  itemProjectIDs,
  projectBadges,
  labelInfo,
  labelBadge,
  blocked,
} from './items.js';
import {
  memberInfo,
  memberName,
  itemParticipants,
  participantInfo,
  participantStack,
} from './people.js';
import { patchNode, keyedNodeKey, reconcileKeyedChildren } from './reconcile.js';
import { itemDateStatus, dueDateBadge, positionListDueBadge } from './due-dates.js';
import { filteredItems } from './filters.js';
import {
  attachmentsLoaded,
  attachmentCount,
  itemFileDropZone,
  attachmentPaperclip,
} from './item-attachments.js';
import { makeDraggable, dropZone } from './drag.js';
import { cardLinkView, cardObservationIcon, showLinks } from './gitlab.js';
import {
  createDetailPane,
  syncListSelection,
  updateDetailPaneVisibility,
  selectItem,
} from './item-detail.js';
import { pruneBulkSelection, renderBulkBar, refreshBulkBar } from './bulk.js';

// A row's content fingerprint: an unchanged row is kept as it is on refresh.
function cardRenderSignature(item, links) {
  const linkIdentity = links.map((link) => ({
    id: link.id,
    project: link.project,
    kind: link.kind,
    number: link.number,
    items: link.items,
  }));
  const due = itemDateStatus(item);
  const itemView = {
    id: item.id,
    title: item.title,
    column_id: item.column_id,
    project_id: item.project_id,
    project_ids: itemProjectIDs(item),
    assignee: item.assignee,
    labels: item.labels,
    sprint_ids: item.sprint_ids,
    archived: item.archived,
    due_date: item.due_date,
    overdue: due?.overdue || false,
    attachments: attachmentsLoaded(item) ? item.attachments : null,
    attachment_count: attachmentCount(item),
  };
  return JSON.stringify({
    item: itemView,
    links: linkIdentity,
    projects: itemProjectIDs(item).map(projectName),
    assignee: memberInfo(item.assignee),
    participants: itemParticipants(item).map((participant) => [
      participant.subject,
      participant.roles,
      participantInfo(participant).name,
      participantInfo(participant).avatarURL,
    ]),
    sprints: item.sprint_ids.map((id) => state.board.sprints.find((s) => s.id === id)?.name || id),
    labels: item.labels.map(labelInfo),
    blocked: blocked(item),
  });
}
function listCell(label, className) {
  const cell = el('div', undefined, `list-cell ${className || ''}`.trim());
  cell.dataset.label = label;
  cell.append(el('span', label, 'list-cell-label'));
  return cell;
}
function listTableHeader() {
  const header = el('div', undefined, 'list-table-head');
  ['Title', 'Project', 'People', 'Labels', 'Sprints', 'Links / Status'].forEach((label) =>
    header.append(el('span', label, 'list-table-heading')),
  );
  return header;
}
function listRow(item) {
  const row = el('article', undefined, 'list-row');
  row.dataset.item = item.id;
  row.dataset.focusKey = `item:${item.id}:list-row`;
  row.tabIndex = 0;
  row.setAttribute('aria-label', `Open work item ${item.title}`);
  const due = itemDateStatus(item);
  row.classList.toggle('is-overdue', !!due?.overdue);
  row.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.target.closest?.('a,button,input,select,textarea,summary'))
      return;
    selectItem(item.id, row);
  });
  row.addEventListener('keydown', (event) => {
    if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    selectItem(item.id, row);
  });
  makeDraggable(row, 'card', item.id, item.title);
  itemFileDropZone(row, item);
  row.setAttribute('aria-label', `Open work item ${item.title}; draggable`);
  dropZone(row, 'card', (id, after) => {
    const current = state.board.items.find((value) => value.id === item.id) || item;
    const currentPeers = filteredItems().filter((value) => value.column_id === current.column_id);
    const index = currentPeers.findIndex((value) => value.id === current.id);
    return {
      kind: 'item.move',
      target: id,
      destination: current.column_id,
      before: after ? currentPeers[index + 1]?.id || '' : current.id,
    };
  });
  const title = listCell('Title', 'list-cell-title');
  const titleDetails = el('div', undefined, 'list-row-title-details');
  const titleLine = el('div', undefined, 'list-row-title-line');
  const bulkSelected = state.bulkSelection.has(item.id);
  if (state.board.role !== 'viewer' && !item.archived) {
    const toggle = el('input');
    toggle.id = `bulk-select-${item.id}`;
    toggle.type = 'checkbox';
    toggle.className = 'list-row-select';
    toggle.checked = bulkSelected;
    toggle.disabled = state.busy || state.loading;
    toggle.dataset.focusKey = `item:${item.id}:bulk-select`;
    toggle.setAttribute('aria-label', `Select ${item.title} for bulk actions`);
    toggle.addEventListener('click', (event) => event.stopPropagation());
    toggle.addEventListener('change', () => {
      if (toggle.checked) state.bulkSelection.add(item.id);
      else state.bulkSelection.delete(item.id);
      row.classList.toggle('is-bulk-selected', toggle.checked);
      refreshBulkBar();
    });
    titleLine.append(toggle);
  }
  const titleButton = button(item.title, () => selectItem(item.id, row), 'list-row-title');
  titleButton.dataset.focusKey = `item:${item.id}:list-title`;
  titleLine.append(titleButton);
  titleDetails.append(titleLine);
  if (due?.overdue) titleDetails.append(dueDateBadge(item));
  title.append(titleDetails);
  const project = listCell('Project', 'list-cell-project');
  const projectValue = el('span', undefined, 'list-row-project');
  projectValue.append(...projectBadges(item));
  project.append(projectValue);
  const status = listCell('Links / Status', 'list-cell-status');
  const statusContent = el('div', undefined, 'list-row-status-content');
  const statusBadges = el('div', undefined, 'list-row-status-badges');
  if (blocked(item)) statusBadges.append(el('span', 'Blocked', 'badge warning'));
  if (due && !due.overdue) {
    const dueBadge = dueDateBadge(item);
    if (dueBadge) statusBadges.append(dueBadge);
  }
  if (item.archived) statusBadges.append(el('span', 'Archived', 'badge'));
  if (statusBadges.childElementCount || due?.overdue) statusContent.append(statusBadges);
  const links = state.board.links.filter((link) => link.items.includes(item.id));
  if (links.length) {
    const linkIndicator = el('div', undefined, 'list-row-indicator list-row-links');
    linkIndicator.setAttribute(
      'aria-label',
      `${links.length} GitLab link${links.length === 1 ? '' : 's'}`,
    );
    const linkHead = el('div', undefined, 'card-links-head');
    const linkLabel = el('span', `GitLab links · ${links.length}`, 'card-links-label');
    const observationLink = button(
      'View observations',
      () => showLinks(item),
      'card-link-details list-row-observation-link',
    );
    observationLink.dataset.focusKey = `item:${item.id}:list-observations`;
    observationLink.setAttribute(
      'aria-label',
      `View observations · ${links.length} GitLab link${links.length === 1 ? '' : 's'}`,
    );
    observationLink.title = 'Show linked GitLab observations';
    linkHead.append(linkLabel, observationLink);
    linkIndicator.append(linkHead);
    links.forEach((link) => {
      const line = el('span', undefined, 'list-row-link-line');
      if (link.kind === 'mr')
        line.append(cardObservationIcon(link, `item:${item.id}:list-observation:${link.id}`));
      line.append(cardLinkView(link, `item:${item.id}:list-link:${link.id}`));
      linkIndicator.append(line);
    });
    statusContent.append(linkIndicator);
  }
  const attachmentTotal = attachmentCount(item);
  if (attachmentTotal) {
    const attachmentIndicator = el('span', undefined, 'list-row-indicator list-row-attachments');
    attachmentIndicator.setAttribute(
      'aria-label',
      `${attachmentTotal} attachment${attachmentTotal === 1 ? '' : 's'}`,
    );
    attachmentIndicator.append(attachmentPaperclip(), el('span', String(attachmentTotal)));
    statusContent.append(attachmentIndicator);
  }
  if (statusContent.childElementCount) status.append(statusContent);
  else status.append(el('span', '—', 'list-cell-empty'));
  // The list shows the same participant aggregate as a card, and keeps the
  // assignee's name in text so the column stays scannable as a table.
  const people = listCell('People', 'list-cell-people');
  const peopleContent = el('div', undefined, 'list-row-people');
  peopleContent.append(
    participantStack(item),
    el('span', memberName(item.assignee), 'list-row-assignee-name'),
  );
  people.append(peopleContent);
  const labels = listCell('Labels', 'list-cell-labels');
  item.labels.forEach((label) => labels.append(labelBadge(label)));
  if (labels.childElementCount === 1) labels.append(el('span', '—', 'list-cell-empty'));
  const sprints = listCell('Sprints', 'list-cell-sprints');
  item.sprint_ids.forEach((id) =>
    sprints.append(
      el('span', state.board.sprints.find((s) => s.id === id)?.name || id, 'badge badge-sprint'),
    ),
  );
  if (sprints.childElementCount === 1) sprints.append(el('span', '—', 'list-cell-empty'));
  row.append(title, project, people, labels, sprints, status);
  if (due?.overdue) positionListDueBadge(row.querySelector('.badge-due'), true);
  row.classList.toggle('is-selected', state.selectedItemID === item.id);
  row.classList.toggle('is-bulk-selected', bulkSelected);
  row.dataset.renderSignature = `${cardRenderSignature(item, links)}|selected:${state.selectedItemID === item.id}|bulk:${bulkSelected}`;
  return row;
}
function listSection(column, items) {
  const section = el('details', undefined, 'list-section');
  section.dataset.column = column.id;
  section.open = true;
  section.setAttribute('aria-label', column.name);
  const peers = items.filter((item) => item.column_id === column.id);
  const total = state.board.items.filter(
    (item) => !item.archived && item.column_id === column.id,
  ).length;
  const head = el('summary', undefined, 'list-section-head');
  head.dataset.renderSignature = JSON.stringify({
    id: column.id,
    name: column.name,
    category: column.category,
    wip: column.wip,
    shown: peers.length,
    total,
  });
  const title = el('span', undefined, 'list-section-title');
  title.append(el('h3', column.name));
  const summary = el(
    'span',
    `${peers.length} shown · ${columnWIPLabel(column, total)}`,
    'list-section-summary',
  );
  head.append(title, summary);
  makeDraggable(head, 'list', column.id, column.name);
  dropZone(
    section,
    'card',
    (id) => ({ kind: 'item.move', target: id, destination: column.id }),
    'end',
  );
  dropZone(
    section,
    'list',
    (id, after) => ({
      kind: 'column.rank',
      target: id,
      before: after
        ? state.board.columns[state.board.columns.findIndex((value) => value.id === column.id) + 1]
            ?.id || ''
        : column.id,
    }),
    'x',
  );
  const body = el('div', undefined, 'list-section-body');
  body.append(...peers.map((item) => listRow(item)));
  if (!peers.length) body.append(emptyState('No work here'));
  section.append(head, body);
  section.dataset.renderSignature = JSON.stringify({
    id: column.id,
    name: column.name,
    category: column.category,
    wip: column.wip,
  });
  return section;
}
function patchListSection(target, next) {
  const expanded = target.open;
  syncAttributes(target, next);
  const currentHead = target.querySelector(':scope > .list-section-head');
  const nextHead = next.querySelector(':scope > .list-section-head');
  if (currentHead && nextHead) patchNode(currentHead, nextHead);
  const currentBody = target.querySelector(':scope > .list-section-body');
  const nextBody = next.querySelector(':scope > .list-section-body');
  if (currentBody && nextBody) {
    syncAttributes(currentBody, nextBody);
    reconcileKeyedChildren(currentBody, [...nextBody.children], keyedNodeKey, (current, fresh) =>
      fresh.dataset.item ? patchNode(current, fresh) : patchNode(current, fresh),
    );
  }
  target.open = expanded;
  return target;
}
export function renderListPresentationContent(content, items) {
  const current = content.firstElementChild;
  let layout, sections;
  if (!current || current.dataset.contentView !== 'list:board') {
    layout = contentRoot('div', 'list-detail-layout', 'list:board');
    const list = el('div', undefined, 'planning-list');
    list.dataset.contentView = 'planning-list';
    sections = el('div', undefined, 'list-sections');
    const bar = el('div', undefined, 'bulk-bar');
    bar.dataset.bulkBar = 'true';
    bar.hidden = true;
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Bulk actions');
    list.append(bar, listTableHeader(), sections);
    const pane = createDetailPane();
    layout.append(list, pane);
    content.replaceChildren(layout);
  } else {
    layout = current;
    sections = layout.querySelector(':scope > .planning-list > .list-sections');
  }
  pruneBulkSelection(items);
  const nextSections = state.board.columns.map((column) => listSection(column, items));
  reconcileKeyedChildren(
    sections,
    nextSections,
    (node) => `column:${node.dataset.column}`,
    patchListSection,
  );
  renderBulkBar(layout.querySelector('[data-bulk-bar]'), items);
  syncListSelection();
  updateDetailPaneVisibility();
}
