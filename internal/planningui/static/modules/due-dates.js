// Due-date badges and the overdue refresh.
import { el, uid } from './dom.js';
import { dueDatePresentation } from './format.js';
import { state } from './state.js';

export function itemDateStatus(item, now = new Date()) {
  const category =
    state.board?.columns.find((column) => column.id === item.column_id)?.category || '';
  return dueDatePresentation(item.due_date, category, !!item.archived, now);
}
export function dueDateBadge(item) {
  const status = itemDateStatus(item);
  if (!status) return undefined;
  const badge = el('span', status.label, `badge badge-due${status.overdue ? ' is-overdue' : ''}`);
  badge.dataset.dueDateBadge = item.id;
  badge.dataset.dueDate = item.due_date;
  badge.dataset.dueCategory =
    state.board?.columns.find((column) => column.id === item.column_id)?.category || '';
  badge.dataset.dueArchived = String(!!item.archived);
  return badge;
}
export function positionCardDueBadge(badge, overdue) {
  const card = badge.closest('.card');
  if (!card) return;
  const top = card.querySelector('.card-top');
  if (overdue && top) {
    badge.classList.add('card-title-due');
    top.classList.add('card-top-overdue');
    if (!top.contains(badge)) top.append(badge);
  } else if (!overdue && badge.classList.contains('card-title-due')) {
    badge.classList.remove('card-title-due');
    top?.classList.remove('card-top-overdue');
    card.querySelector('[data-card-section="labels"]')?.append(badge);
  }
}
export function positionListDueBadge(badge, overdue) {
  const row = badge.closest('.list-row');
  if (!row) return;
  const title = row.querySelector('.list-row-title-details');
  if (overdue && title) {
    badge.classList.add('list-title-due');
    if (!title.contains(badge)) title.append(badge);
  } else if (!overdue && badge.classList.contains('list-title-due')) {
    badge.classList.remove('list-title-due');
    row.querySelector('.list-row-status-badges')?.append(badge);
  }
}
export function editorDueBadgeHost(form) {
  if (form.classList.contains('item-editor-form')) return form.querySelector('.dialog-head');
  if (form.classList.contains('item-detail-form')) return form.querySelector('.item-detail-head');
  return form.querySelector('.item-title-label');
}
export function appendEditorDueBadge(form, badge) {
  const host = editorDueBadgeHost(form);
  const close = form.classList.contains('item-editor-form')
    ? host?.querySelector('#dismiss')
    : form.classList.contains('item-detail-form')
      ? host?.querySelector('.item-detail-head-actions')
      : undefined;
  if (close) close.before(badge);
  else host?.append(badge);
}
function positionEditorDueBadge(badge, overdue) {
  const form = badge.closest('.item-editor-form,.item-detail-form');
  if (!form) return;
  const title = form.querySelector('[name="title"]');
  if (overdue) {
    badge.id ||= uid('item-title-overdue');
    title?.setAttribute('aria-describedby', badge.id);
    appendEditorDueBadge(form, badge);
  } else {
    const destination = form.querySelector('.item-status-badges');
    if (destination && !destination.contains(badge)) destination.append(badge);
    if (title?.getAttribute('aria-describedby') === badge.id)
      title.removeAttribute('aria-describedby');
  }
}
export function refreshDueDateBadges(now = new Date()) {
  document.querySelectorAll('.badge-due[data-due-date-badge]').forEach((badge) => {
    const status = dueDatePresentation(
      badge.dataset.dueDate,
      badge.dataset.dueCategory,
      badge.dataset.dueArchived === 'true',
      now,
    );
    if (!status) {
      const card = badge.closest('.card');
      badge.closest('.card,.list-row')?.classList.remove('is-overdue');
      card?.querySelector('.card-top')?.classList.remove('card-top-overdue');
      badge.remove();
      return;
    }
    badge.textContent = status.label;
    badge.classList.toggle('is-overdue', status.overdue);
    badge.closest('.card,.list-row')?.classList.toggle('is-overdue', status.overdue);
    positionCardDueBadge(badge, status.overdue);
    positionListDueBadge(badge, status.overdue);
    positionEditorDueBadge(badge, status.overdue);
  });
}
export function scheduleOverdueRefresh() {
  clearTimeout(state.overdueTimer);
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  state.overdueTimer = setTimeout(
    () => {
      if (!document.hidden) refreshDueDateBadges();
      scheduleOverdueRefresh();
    },
    Math.max(1, midnight.getTime() - now.getTime() + 10),
  );
}
