// The Kanban board: project lens, columns, cards and board setup.
import { $, el, field } from './dom.js';
import { columnWIPLabel } from './format.js';
import {
  contentRoot,
  helpText,
  helpTextTemplate,
  emptyStateTemplate,
  metricListTemplate,
} from './layout.js';
import { attach, classMap, html, nothing, render, repeat } from './lit.js';
import { state } from './state.js';
import { writable, writeButton } from './permissions.js';
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

// #project-summary is a static host: its hidden state and label are set here,
// its children rendered by lit.
export function renderProjectSummary() {
  const summary = $('project-summary');
  const projectID = singleFilterValue('project');
  const project = state.board.projects.find((value) => value.id === projectID);
  if (state.view !== 'board' || !project || ['all', 'none'].includes(projectID)) {
    summary.hidden = true;
    render(nothing, summary);
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
  const coverage = active.map((sprint) => {
    const count = items.filter((item) => item.sprint_ids.includes(sprint.id)).length;
    return html`<span class="badge">${`${sprint.name} · ${count}`}</span>`;
  });
  summary.hidden = false;
  summary.setAttribute('aria-label', `${project.name} project summary`);
  render(
    html`<div class="project-summary-head">
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
        ${unscheduled ? html`<span class="badge">${`Backlog · ${unscheduled}`}</span>` : nothing}
        ${!active.length && !unscheduled ? html`<span class="muted">None</span>` : nothing}
      </div>`,
    summary,
  );
}
// Cards and columns are lit templates: every render describes the whole board
// and lit updates only what changed, so focus, hover, open <details> and
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
        @click=${() => showLinks(item)}
      >View observations</button>
    </div>
    <div class="card-links" aria-label="GitLab links">
      ${repeat(
        links,
        (link) => link.id,
        (link) =>
          html`${
            link.kind === 'mr'
              ? cardObservationIconTemplate(link, `item:${item.id}:observation:${link.id}`)
              : nothing
          }${cardLinkTemplate(link, `item:${item.id}:link:${link.id}`)}`,
      )}
    </div>
  </div>`;
}
function cardAttachmentsTemplate(item, total) {
  const count = `${total} attachment${total === 1 ? '' : 's'}`;
  // The <details> open state belongs to the user; the template never binds it.
  // Expanding the summary is what pays for the metadata read.
  return html`<details
    class="card-attachments"
    data-state-key=${`item:${item.id}:attachments`}
    aria-label=${count}
    @toggle=${(event) => {
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
          ? repeat(
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
export function cardTemplate(item) {
  const overdue = !!itemDateStatus(item)?.overdue;
  const links = state.board.links.filter((l) => l.items.includes(item.id));
  const total = attachmentCount(item);
  const sprintName = (id) => state.board.sprints.find((s) => s.id === id)?.name || id;
  return html`<article
    class=${classMap({ card: true, 'is-overdue': overdue })}
    data-item=${item.id}
    data-drag-type="card"
    tabindex="0"
    aria-label=${`Open work item ${item.title}; draggable`}
    ${attach(attachCard, item.id)}
    @click=${(event) => openCardFromClick(event, item)}
    @keydown=${(event) => openCardFromKey(event, item)}
  >
    <div class=${classMap({ 'card-top': true, 'card-top-overdue': overdue })}>
      <button
        type="button"
        class="card-title"
        data-focus-key=${`item:${item.id}:title`}
        @click=${() => editItem(item)}
      >${item.title}</button>
      ${overdue ? dueDateBadgeTemplate(item, ' card-title-due') : nothing}
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
      ${blocked(item) ? html`<span class="badge warning">Blocked by dependency</span>` : nothing}
      ${overdue ? nothing : dueDateBadgeTemplate(item)}
      ${item.archived ? html`<span class="badge">Archived</span>` : nothing}
    </div>
    ${
      item.archived
        ? html`<div class="card-controls">
            <button
              type="button"
              ?disabled=${!writable() || state.integrationFormOpen}
              @click=${() => quick({ kind: 'item.restore', target: item.id })}
            >Restore item</button>
          </div>`
        : nothing
    }
    ${links.length ? cardLinksTemplate(item, links) : nothing}
    ${total ? cardAttachmentsTemplate(item, total) : nothing}
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
function columnTemplate(col, items) {
  const peers = items.filter((item) => item.column_id === col.id);
  const total = state.board.items.filter(
    (item) => !item.archived && item.column_id === col.id,
  ).length;
  return html`<section
    class="column"
    data-column=${col.id}
    aria-label=${col.name}
    ${attach(attachColumn, col.id)}
  >
    <div
      class="column-head"
      data-drag-type="list"
      aria-label=${`Drag list ${col.name}`}
      ${attach(attachDrag, 'list', col.id)}
    >
      <h3>${col.name}</h3>
      <small>${`${peers.length} shown · ${columnWIPLabel(col, total)}`}</small>
    </div>
    ${repeat(peers, (item) => item.id, cardTemplate)}
    ${peers.length ? nothing : emptyStateTemplate('No work here')}
  </section>`;
}
export function renderBoardContent(content, items) {
  const current = content.firstElementChild;
  const root =
    current?.dataset.contentView === 'board' ? current : contentRoot('div', 'board', 'board');
  render(
    repeat(
      state.board.columns,
      (column) => column.id,
      (column) => columnTemplate(column, items),
    ),
    root,
  );
  // A new root is filled while detached, so the page takes one insertion.
  if (root !== current) content.replaceChildren(root);
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
