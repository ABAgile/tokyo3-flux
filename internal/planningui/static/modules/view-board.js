// The Kanban board: project lens, columns, cards and board setup.
import { $, el, button, syncAttributes, field } from './dom.js';
import { columnWIPLabel } from './format.js';
import { contentRoot, helpText, emptyState, metricList } from './layout.js';
import { state } from './state.js';
import { writeButton } from './permissions.js';
import {
  projectName,
  itemProjectIDs,
  projectBadges,
  labelInfo,
  labelBadge,
  done,
  blocked,
  findItem,
} from './items.js';
import { memberInfo, itemParticipants, participantInfo, participantStack } from './people.js';
import { patchNode, keyedNodeKey, reconcileKeyedChildren } from './reconcile.js';
import { itemDateStatus, dueDateBadge, positionCardDueBadge } from './due-dates.js';
import { singleFilterValue, filteredItems } from './filters.js';
import { quick } from './commands.js';
import {
  attachmentsLoaded,
  attachmentCount,
  ensureAttachments,
  itemFileDropZone,
  attachmentPaperclip,
  attachmentTileLink,
} from './item-attachments.js';
import { openEditor } from './dialog.js';
import { makeDraggable, dropZone } from './drag.js';
import {
  cardLinkView,
  cardObservationIcon,
  patchObservationIcon,
  patchObservationLink,
  showLinks,
} from './gitlab.js';
import { editItem } from './item-editor.js';

export function renderProjectSummary() {
  const summary = $('project-summary');
  const projectID = singleFilterValue('project');
  const project = state.board.projects.find((value) => value.id === projectID);
  if (state.view !== 'board' || !project || ['all', 'none'].includes(projectID)) {
    summary.hidden = true;
    summary.replaceChildren();
    return;
  }
  const items = state.board.items.filter(
    (item) => !item.archived && itemProjectIDs(item).includes(projectID),
  );
  const openSprints = state.board.sprints.filter(
    (sprint) =>
      sprint.state !== 'closed' && items.some((item) => item.sprint_ids.includes(sprint.id)),
  );
  const active = openSprints.filter((sprint) => sprint.state === 'active');
  const completed = items.filter(done).length;
  const blockedCount = items.filter(blocked).length;
  const unscheduled = items.filter((item) => !done(item) && !item.sprint_ids.length).length;
  const head = el('div', undefined, 'project-summary-head');
  const intro = el('div', undefined, 'project-summary-title');
  intro.append(
    el('p', 'PROJECT LENS', 'eyebrow'),
    el('h2', `${project.name} project`),
    helpText('Current work only · archived history is excluded.'),
  );
  head.append(intro);
  const metrics = metricList(
    [
      [items.length, 'In scope'],
      [completed, 'Done'],
      [blockedCount, 'Blocked'],
      [unscheduled, 'Unscheduled'],
    ],
    'project-summary-metrics',
  );
  const coverage = el('div', undefined, 'project-sprint-coverage');
  coverage.append(el('span', 'Active sprint coverage', 'project-sprint-coverage-label'));
  active.forEach((sprint) => {
    const count = items.filter((item) => item.sprint_ids.includes(sprint.id)).length;
    coverage.append(el('span', `${sprint.name} · ${count}`, 'badge'));
  });
  if (unscheduled) coverage.append(el('span', `Backlog · ${unscheduled}`, 'badge'));
  if (!active.length && !unscheduled) coverage.append(el('span', 'None', 'muted'));
  summary.hidden = false;
  summary.setAttribute('aria-label', `${project.name} project summary`);
  summary.replaceChildren(head, metrics, coverage);
}
export function cardRenderSignature(item, links) {
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
function card(item, peers) {
  const c = el('article', undefined, 'card');
  const top = el('div', undefined, 'card-top');
  const title = button(item.title, () => editItem(item), 'card-title');
  title.dataset.focusKey = `item:${item.id}:title`;
  top.append(title);
  c.dataset.item = item.id;
  const due = itemDateStatus(item);
  c.classList.toggle('is-overdue', !!due?.overdue);
  makeDraggable(c, 'card', item.id, item.title);
  c.tabIndex = 0;
  c.setAttribute('aria-label', `Open work item ${item.title}; draggable`);
  itemFileDropZone(c, item);
  c.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.target.closest?.('a,button,input,select,textarea,summary'))
      return;
    editItem(item);
  });
  c.addEventListener('keydown', (event) => {
    if (event.target !== c || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    editItem(item);
  });
  dropZone(c, 'card', (id, after) => {
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
  const meta = el('div', undefined, 'card-meta');
  const projects = el('div', undefined, 'card-projects');
  projects.append(...projectBadges(item));
  meta.append(projects, participantStack(item));
  c.append(top, meta);
  const sprintTags = el('div', undefined, 'tags');
  sprintTags.dataset.cardSection = 'sprints';
  item.sprint_ids.forEach((id) => {
    const tag = el(
      'span',
      state.board.sprints.find((s) => s.id === id)?.name || id,
      'badge badge-sprint',
    );
    tag.dataset.sprintId = id;
    sprintTags.append(tag);
  });
  c.append(sprintTags);
  const tags = el('div', undefined, 'tags');
  tags.dataset.cardSection = 'labels';
  item.labels.forEach((l) => tags.append(labelBadge(l)));
  if (blocked(item)) tags.append(el('span', 'Blocked by dependency', 'badge warning'));
  const dueBadge = dueDateBadge(item);
  if (dueBadge) tags.append(dueBadge);
  if (item.archived) tags.append(el('span', 'Archived', 'badge'));
  c.append(tags);
  if (due?.overdue && dueBadge) positionCardDueBadge(dueBadge, true);
  if (item.archived) {
    const controls = el('div', undefined, 'card-controls');
    controls.append(
      writeButton('Restore item', () => quick({ kind: 'item.restore', target: item.id })),
    );
    c.append(controls);
  }
  const links = state.board.links.filter((l) => l.items.includes(item.id));
  if (links.length) {
    const linkSection = el('div', undefined, 'card-links-section');
    linkSection.setAttribute('role', 'group');
    linkSection.setAttribute('aria-label', 'GitLab links');
    const linkHead = el('div', undefined, 'card-links-head');
    const linkLabel = el('span', `GitLab links · ${links.length}`, 'card-links-label');
    linkLabel.dataset.renderSignature = `links:${links.length}`;
    const details = button('View observations', () => showLinks(item), 'card-link-details');
    details.dataset.renderSignature = 'observations-action';
    details.dataset.focusKey = `item:${item.id}:observations`;
    details.setAttribute('aria-label', `View GitLab details · ${links.length}`);
    details.title = 'Show linked GitLab observations';
    linkHead.append(linkLabel, details);
    const linkList = el('div', undefined, 'card-links');
    linkList.setAttribute('aria-label', 'GitLab links');
    links.forEach((link) => {
      if (link.kind === 'mr')
        linkList.append(cardObservationIcon(link, `item:${item.id}:observation:${link.id}`));
      linkList.append(cardLinkView(link, `item:${item.id}:link:${link.id}`));
    });
    linkSection.append(linkHead, linkList);
    c.append(linkSection);
  }
  const total = attachmentCount(item);
  if (total) {
    const attachmentList = el('details', undefined, 'card-attachments');
    attachmentList.dataset.stateKey = `item:${item.id}:attachments`;
    const count = `${total} attachment${total === 1 ? '' : 's'}`;
    attachmentList.setAttribute('aria-label', count);
    const attachmentHead = el('summary', undefined, 'card-attachments-head');
    const attachmentToggle = el('span', undefined, 'card-attachments-toggle');
    attachmentToggle.setAttribute('aria-hidden', 'true');
    attachmentHead.append(
      attachmentPaperclip(),
      el('span', 'Attachments', 'card-attachments-label'),
      el('span', String(total), 'card-attachments-count'),
      attachmentToggle,
    );
    const attachmentOptions = el('div', undefined, 'card-attachment-list');
    // Expanding the summary is what pays for the metadata read.
    if (attachmentsLoaded(item))
      item.attachments.forEach((attachment) => {
        const link = attachmentTileLink(item, attachment);
        link.classList.add('card-attachment-option');
        attachmentOptions.append(link);
      });
    else attachmentOptions.append(emptyState('Loading attachments…'));
    // Patching keeps this node across board refreshes, so read the current item
    // rather than the one this card was first built from.
    attachmentList.addEventListener('toggle', () => {
      if (attachmentList.open) void ensureAttachments(findItem(item.id) || item);
    });
    attachmentList.append(attachmentHead, attachmentOptions);
    c.append(attachmentList);
  }
  c.dataset.renderSignature = cardRenderSignature(item, links);
  return c;
}
function renderColumn(col, items) {
  const section = el('section', undefined, 'column');
  section.dataset.column = col.id;
  section.setAttribute('aria-label', col.name);
  const peers = items.filter((item) => item.column_id === col.id);
  const total = state.board.items.filter(
    (item) => !item.archived && item.column_id === col.id,
  ).length;
  const head = el('div', undefined, 'column-head');
  head.dataset.renderSignature = JSON.stringify({
    id: col.id,
    name: col.name,
    category: col.category,
    wip: col.wip,
    shown: peers.length,
    total,
  });
  head.append(
    el('h3', col.name),
    el('small', `${peers.length} shown · ${columnWIPLabel(col, total)}`),
  );
  makeDraggable(head, 'list', col.id, col.name);
  dropZone(
    section,
    'card',
    (id) => ({ kind: 'item.move', target: id, destination: col.id }),
    'end',
  );
  dropZone(
    section,
    'list',
    (id, after) => ({
      kind: 'column.rank',
      target: id,
      before: after
        ? state.board.columns[state.board.columns.findIndex((value) => value.id === col.id) + 1]
            ?.id || ''
        : col.id,
    }),
    'x',
  );
  section.append(head);
  appendCards(section, peers);
  if (!peers.length) {
    section.append(emptyState('No work here'));
  }
  section.dataset.renderSignature = JSON.stringify({
    id: col.id,
    name: col.name,
    category: col.category,
    wip: col.wip,
  });
  return section;
}
function cardChildKey(node) {
  if (node.classList.contains('card-top')) return 'top';
  if (node.classList.contains('card-meta')) return 'meta';
  if (node.classList.contains('tags')) return `tags:${node.dataset.cardSection || ''}`;
  if (node.classList.contains('card-links-section') || node.classList.contains('card-links'))
    return 'links';
  if (node.classList.contains('card-attachments')) return 'attachments';
  if (node.classList.contains('card-controls')) return 'controls';
  return node.className || node.tagName;
}
function cardLinkChildKey(node) {
  if (node.dataset.observation === 'status-icon') return `status:${node.dataset.linkId}`;
  if (node.dataset.observation === 'link') return `link:${node.dataset.linkId}`;
  return 'details';
}
function patchCardLinksHead(target, next) {
  syncAttributes(target, next);
  reconcileKeyedChildren(
    target,
    [...next.children],
    (node) => (node.classList.contains('card-links-label') ? 'label' : 'details'),
    patchNode,
  );
  return target;
}
function patchCardLinksSection(target, next) {
  syncAttributes(target, next);
  const currentHead = target.querySelector('.card-links-head');
  const nextHead = next.querySelector('.card-links-head');
  if (currentHead && nextHead) patchCardLinksHead(currentHead, nextHead);
  const currentLinks = target.querySelector('.card-links');
  const nextLinks = next.querySelector('.card-links');
  if (currentLinks && nextLinks) patchCardLinks(currentLinks, nextLinks);
  return target;
}
function patchCardLinks(target, next) {
  syncAttributes(target, next);
  reconcileKeyedChildren(target, [...next.children], cardLinkChildKey, (current, fresh) => {
    const link = state.board.links.find((value) => value.id === fresh.dataset.linkId);
    if (link && fresh.dataset.observation === 'status-icon')
      return patchObservationIcon(current, link);
    if (link && fresh.dataset.observation === 'link') return patchObservationLink(current, link);
    return patchNode(current, fresh);
  });
  return target;
}
function patchCardAttachments(target, next) {
  // A rebuilt card starts collapsed; keep the dropdown the user opened.
  const open = target.open;
  syncAttributes(target, next);
  target.open = open;
  const currentHead = target.firstElementChild;
  const nextHead = next.firstElementChild;
  if (currentHead && nextHead) patchNode(currentHead, nextHead);
  const currentList = target.querySelector('.card-attachment-list');
  const nextList = next.querySelector('.card-attachment-list');
  if (currentList && nextList) {
    syncAttributes(currentList, nextList);
    reconcileKeyedChildren(
      currentList,
      [...nextList.children],
      (node) => `attachment:${node.dataset.attachmentId || node.textContent}`,
      patchNode,
    );
  }
  return target;
}
function patchCardTags(target, next) {
  syncAttributes(target, next);
  reconcileKeyedChildren(
    target,
    [...next.children],
    (node) =>
      node.dataset.sprintId
        ? `sprint:${node.dataset.sprintId}`
        : node.dataset.label
          ? `label:${node.dataset.label}`
          : `state:${node.textContent}`,
    patchNode,
  );
  return target;
}
export function patchCard(target, next) {
  if (target === next) return target;
  if (target.dataset.renderSignature === next.dataset.renderSignature) {
    const currentLinks = target.querySelector('.card-links-section');
    const nextLinks = next.querySelector('.card-links-section');
    if (currentLinks && nextLinks) patchCardLinksSection(currentLinks, nextLinks);
    return target;
  }
  syncAttributes(target, next);
  reconcileKeyedChildren(target, [...next.children], cardChildKey, (current, fresh) => {
    if (fresh.classList.contains('card-links-section'))
      return patchCardLinksSection(current, fresh);
    if (fresh.classList.contains('card-links')) return patchCardLinks(current, fresh);
    if (fresh.classList.contains('card-attachments')) return patchCardAttachments(current, fresh);
    if (fresh.classList.contains('tags')) return patchCardTags(current, fresh);
    return patchNode(current, fresh);
  });
  return target;
}
function patchColumn(target, next, cardPool) {
  syncAttributes(target, next);
  reconcileKeyedChildren(
    target,
    [...next.children],
    keyedNodeKey,
    (current, fresh) =>
      fresh.dataset.item ? patchCard(current, fresh) : patchNode(current, fresh),
    (key) => (key.startsWith('item:') ? cardPool.get(key.slice('item:'.length)) : undefined),
  );
}
export function renderBoardContent(content, items) {
  const next = contentRoot('div', 'board', 'board');
  state.board.columns.forEach((column) => next.append(renderColumn(column, items)));
  const current = content.firstElementChild;
  if (!current || current.dataset.contentView !== 'board') {
    content.replaceChildren(next);
    return;
  }
  const cardPool = new Map(
    [...current.querySelectorAll('.card')].map((node) => [node.dataset.item, node]),
  );
  reconcileKeyedChildren(
    current,
    [...next.children],
    (node) => `column:${node.dataset.column}`,
    (target, fresh) => patchColumn(target, fresh, cardPool),
  );
}
export function appendCards(parent, items) {
  items.forEach((i) => parent.append(card(i, items)));
}
function editColumn(column) {
  $('editor').close();
  const existing = !!column;
  column ||= { name: '', category: 'todo', wip: 0 };
  openEditor(
    existing ? 'Edit board column' : 'Add board column',
    (fields) => {
      const name = field(fields, 'name', 'Column name', column.name);
      name.required = true;
      name.maxLength = 80;
      field(fields, 'category', 'Lifecycle category', column.category, 'text', [
        ['todo', 'To do'],
        ['doing', 'In progress'],
        ['done', 'Done'],
      ]);
      const wip = field(
        fields,
        'wip',
        'WIP limit · 0 means unlimited',
        String(column.wip),
        'number',
      );
      wip.min = 0;
      wip.max = 1000;
      wip.required = true;
      fields.append(
        helpText(
          'WIP counts all non-archived cards in this column, across sprints and backlog. A limit cannot be lowered below current occupancy.',
        ),
      );
    },
    (data) => ({
      kind: 'column.save',
      target: column.id || '',
      column: {
        ...column,
        name: data.get('name').trim(),
        category: data.get('category'),
        wip: Number(data.get('wip')),
      },
    }),
  );
}
export function setupBoard() {
  openEditor(
    'Board setup',
    (fields) => {
      fields.append(
        helpText(
          'Configure columns, lifecycle categories, ordering, and WIP policy. All changes are revision checked.',
        ),
      );
      state.board.columns.forEach((c, index) => {
        const row = el('div', undefined, 'setup-row');
        row.append(
          el('strong', c.name),
          el('small', `${c.category} · WIP ${c.wip || 'unlimited'}`, 'muted'),
        );
        const actions = el('div', undefined, 'actions');
        actions.append(writeButton('Edit', () => editColumn(c)));
        if (index > 0)
          actions.append(
            writeButton('Move left', async () => {
              await quick({
                kind: 'column.rank',
                target: c.id,
                before: state.board.columns[index - 1].id,
              });
              $('editor').close();
            }),
          );
        if (state.board.columns.length > 1)
          actions.append(
            writeButton('Remove…', () => {
              $('editor').close();
              openEditor(
                'Remove column & move cards',
                (f) => {
                  f.append(
                    el(
                      'p',
                      `All cards in ${c.name}, including archived ones, must move to another column.`,
                    ),
                  );
                  field(
                    f,
                    'destination',
                    'Destination column',
                    '',
                    'text',
                    state.board.columns.filter((v) => v.id !== c.id).map((v) => [v.id, v.name]),
                  );
                },
                (data) => ({
                  kind: 'column.delete',
                  target: c.id,
                  destination: data.get('destination'),
                }),
              );
            }),
          );
        row.append(actions);
        fields.append(row);
      });
      fields.append(writeButton('＋ Add column', () => editColumn(), 'primary'));
    },
    () => ({}),
    true,
  );
}
