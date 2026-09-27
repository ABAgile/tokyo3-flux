// The Kanban board: project lens, columns, cards and board setup.
import { $ } from './dom.js';
import { columnWIPLabel } from './format.js';
import {
  fieldTemplate,
  helpTextTemplate,
  emptyStateTemplate,
  metricListTemplate,
} from './layout.js';
import { attach, classNames } from './dom.js';
import { html, keyedList } from './vdom.js';
import { useLayoutEffect, useRef } from './vendor-preact.js';

import { state } from './state.js';
import { writable, accessButtonTemplate } from './permissions.js';
import {
  itemProjectIDs,
  projectBadgesTemplate,
  labelBadgeTemplate,
  done,
  blocked,
  findItem,
} from './items.js';
import { participantStackTemplate } from './people.js';
import { itemDateStatus, dueDateBadgeTemplate } from './due-dates.js';
import { singleFilterValue, filteredItems } from './filters.js';
import { quick } from './commands.js';
import {
  attachmentsLoaded,
  attachmentCount,
  ensureAttachments,
  itemFileDropZone,
  attachmentPaperclipTemplate,
  attachmentTileLinkTemplate,
} from './item-attachments.js';
import { openEditor } from './dialog.js';
import { attachDrag, dropZone } from './drag.js';
import { cardLinkTemplate, cardObservationIconTemplate, showLinks } from './gitlab.js';
import { editItem } from './item-editor.js';

export function ProjectSummary({ board, view, projectID }) {
  const project = board?.projects?.find((value) => value.id === projectID);
  const visible = view === 'board' && !!project && !['all', 'none'].includes(projectID);
  const items = visible
    ? (board.items || []).filter(
        (item) => !item.archived && itemProjectIDs(item).includes(projectID),
      )
    : [];
  const openSprints = visible
    ? (board.sprints || []).filter(
        (sprint) =>
          sprint.state !== 'closed' && items.some((item) => item.sprint_ids.includes(sprint.id)),
      )
    : [];
  const active = openSprints.filter((sprint) => sprint.state === 'active');
  const completed = items.filter(done).length;
  const blockedCount = items.filter(blocked).length;
  const unscheduled = items.filter((item) => !done(item) && !item.sprint_ids.length).length;
  const coverage = active.map((sprint) => {
    const count = items.filter((item) => item.sprint_ids.includes(sprint.id)).length;
    return html`<span class="badge">${`${sprint.name} · ${count}`}</span>`;
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
// Cards and columns are Preact templates: every render describes the whole board
// and Preact updates only what changed, so focus, hover, open <details> and
// scroll survive refreshes without per-section patch code. Drag, drop and file
// drops are imperative and wired once per element through attach().
function openCardFromClick(event, item) {
  if (event.defaultPrevented || event.target.closest?.('a,button,input,select,textarea,summary'))
    return;
  editItem(item);
}
function openCardFromKey(event, item) {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  editItem(item);
}
function attachCard(node, id) {
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
      ${keyedList(
        links,
        (link) => link.id,
        (link) =>
          html`${
            link.kind === 'mr'
              ? cardObservationIconTemplate(link, `item:${item.id}:observation:${link.id}`)
              : null
          }${cardLinkTemplate(link, `item:${item.id}:link:${link.id}`)}`,
      )}
    </div>
  </div>`;
}
function restoreAttachmentDisclosure(node, id, expanded) {
  if (expanded.has(id)) node.open = true;
}
function cardAttachmentsTemplate(item, total, expanded) {
  const count = `${total} attachment${total === 1 ? '' : 's'}`;
  // The <details> open state belongs to the user; the template never binds it.
  // Expanding the summary is what pays for the metadata read.
  return html`<details
    class="card-attachments"
    data-state-key=${`item:${item.id}:attachments`}
    aria-label=${count}
    ref=${expanded ? attach(restoreAttachmentDisclosure, item.id, expanded) : undefined}
    onToggle=${(event) => {
      if (expanded) {
        if (event.currentTarget.open) expanded.add(item.id);
        else expanded.delete(item.id);
      }
      if (event.currentTarget.open) void ensureAttachments(findItem(item.id) || item);
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
        attachmentsLoaded(item)
          ? keyedList(
              item.attachments,
              (attachment) => attachment.id,
              (attachment) =>
                attachmentTileLinkTemplate(
                  item,
                  attachment,
                  undefined,
                  undefined,
                  ' card-attachment-option',
                ),
            )
          : emptyStateTemplate('Loading attachments…')
      }
    </div>
  </details>`;
}
export function cardTemplate(item, expanded) {
  const overdue = !!itemDateStatus(item)?.overdue;
  const links = state.board.links.filter((l) => l.items.includes(item.id));
  const total = attachmentCount(item);
  const sprintName = (id) => state.board.sprints.find((s) => s.id === id)?.name || id;
  return html`<article
    class=${classNames({ card: true, 'is-overdue': overdue })}
    data-item=${item.id}
    data-focus-key=${`item:${item.id}:card`}
    data-drag-type="card"
    draggable=${writable() && !item.archived}
    tabindex="0"
    aria-label=${`Open work item ${item.title}; draggable`}
    ref=${attach(attachCard, item.id)}
    onClick=${(event) => openCardFromClick(event, item)}
    onKeydown=${(event) => openCardFromKey(event, item)}
  >
    <div class=${classNames({ 'card-top': true, 'card-top-overdue': overdue })}>
      <button
        type="button"
        class="card-title"
        data-focus-key=${`item:${item.id}:title`}
        onClick=${() => editItem(item)}
      >${item.title}</button>
      ${overdue ? dueDateBadgeTemplate(item, ' card-title-due') : null}
    </div>
    <div class="card-meta">
      <div class="card-projects">${projectBadgesTemplate(item)}</div>
      ${participantStackTemplate(item)}
    </div>
    <div class="tags" data-card-section="sprints">
      ${item.sprint_ids.map(
        (id) =>
          html`<span class="badge badge-sprint" data-sprint-id=${id}>${sprintName(id)}</span>`,
      )}
    </div>
    <div class="tags" data-card-section="labels">
      ${item.labels.map(labelBadgeTemplate)}
      ${blocked(item) ? html`<span class="badge warning">Blocked by dependency</span>` : null}
      ${overdue ? null : dueDateBadgeTemplate(item)}
      ${item.archived ? html`<span class="badge">Archived</span>` : null}
    </div>
    ${
      item.archived
        ? html`<div class="card-controls">
            <button
              type="button"
              disabled=${!writable() || state.integrationFormOpen}
              onClick=${() => quick({ kind: 'item.restore', target: item.id })}
            >Restore item</button>
          </div>`
        : null
    }
    ${links.length ? cardLinksTemplate(item, links) : null}
    ${total ? cardAttachmentsTemplate(item, total, expanded) : null}
  </article>`;
}
function attachColumn(section, id) {
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
function columnTemplate(col, items, expanded) {
  const peers = items.filter((item) => item.column_id === col.id);
  const total = state.board.items.filter(
    (item) => !item.archived && item.column_id === col.id,
  ).length;
  return html`<section
    class="column"
    data-column=${col.id}
    aria-label=${col.name}
    ref=${attach(attachColumn, col.id)}
  >
    <div
      class="column-head"
      data-drag-type="list"
      draggable=${writable()}
      aria-label=${`Drag list ${col.name}`}
      ref=${attach(attachDrag, 'list', col.id)}
    >
      <h3>${col.name}</h3>
      <small>${`${peers.length} shown · ${columnWIPLabel(col, total)}`}</small>
    </div>
    ${keyedList(
      peers,
      (item) => item.id,
      (item) => cardTemplate(item, expanded),
    )}
    ${peers.length ? null : emptyStateTemplate('No work here')}
  </section>`;
}
export function BoardContent({ items }) {
  const expanded = useRef(new Set());
  const root = useRef(null);
  useLayoutEffect(() => {
    const open = new Set(
      [...root.current.querySelectorAll('.card-attachments[open]')]
        .map((node) => node.closest('[data-item]')?.dataset.item)
        .filter(Boolean),
    );
    for (const id of expanded.current) if (!open.has(id)) expanded.current.delete(id);
    for (const id of open) expanded.current.add(id);
  });
  return html`<div class="board" data-content-view="board" ref=${root}>
    ${keyedList(
      state.board.columns,
      (column) => column.id,
      (column) => columnTemplate(column, items, expanded.current),
    )}
  </div>`;
}
function editColumn(column) {
  $('editor').close();
  const existing = !!column;
  column ||= { name: '', category: 'todo', wip: 0 };
  openEditor(
    existing ? 'Edit board column' : 'Add board column',
    () => html`${fieldTemplate('name', 'Column name', column.name, 'text', undefined, {
      required: true,
      maxLength: 80,
    })}
      ${fieldTemplate('category', 'Lifecycle category', column.category, 'text', [
        ['todo', 'To do'],
        ['doing', 'In progress'],
        ['done', 'Done'],
      ])}
      ${fieldTemplate(
        'wip',
        'WIP limit · 0 means unlimited',
        String(column.wip),
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
      )}`,
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
function removeColumn(column) {
  $('editor').close();
  openEditor(
    'Remove column & move cards',
    () => html`<p>${`All cards in ${column.name}, including archived ones, must move to another column.`}</p>
      ${fieldTemplate(
        'destination',
        'Destination column',
        '',
        'text',
        state.board.columns.filter((v) => v.id !== column.id).map((v) => [v.id, v.name]),
      )}`,
    (data) => ({ kind: 'column.delete', target: column.id, destination: data.get('destination') }),
  );
}
async function moveColumnLeft(column, index) {
  await quick({
    kind: 'column.rank',
    target: column.id,
    before: state.board.columns[index - 1].id,
  });
  $('editor').close();
}
export function setupBoard() {
  const action = (text, fn) => accessButtonTemplate(text, fn, { tracked: false });
  openEditor(
    'Board setup',
    () => html`${helpTextTemplate(
      'Configure columns, lifecycle categories, ordering, and WIP policy. All changes are revision checked.',
    )}
      ${state.board.columns.map(
        (c, index) => html`<div class="setup-row">
          <strong>${c.name}</strong>
          <small class="muted">${`${c.category} · WIP ${c.wip || 'unlimited'}`}</small>
          <div class="actions">
            ${action('Edit', () => editColumn(c))}
            ${index > 0 ? action('Move left', () => moveColumnLeft(c, index)) : null}
            ${state.board.columns.length > 1 ? action('Remove…', () => removeColumn(c)) : null}
          </div>
        </div>`,
      )}
      ${accessButtonTemplate('＋ Add column', () => editColumn(), {
        className: 'primary',
        tracked: false,
      })}`,
    () => ({}),
    true,
  );
}
