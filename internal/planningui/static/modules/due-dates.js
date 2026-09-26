// Due-date badges and the overdue refresh.
import { uid } from './dom.js';
import { dueDatePresentation } from './format.js';
import { hooks } from './hooks.js';
import { html, nodeOf, nothing } from './lit.js';
import { state } from './state.js';

export function itemDateStatus(item, now = new Date()) {
  const category =
    state.board?.columns.find((column) => column.id === item.column_id)?.category || '';
  return dueDatePresentation(item.due_date, category, !!item.archived, now);
}
// `extraClass` places the badge, for example beside an overdue card title.
export function dueDateBadgeTemplate(item, extraClass = '') {
  const status = itemDateStatus(item);
  if (!status) return nothing;
  const category =
    state.board?.columns.find((column) => column.id === item.column_id)?.category || '';
  return html`<span
    class="badge badge-due${status.overdue ? ' is-overdue' : ''}${extraClass}"
    data-due-date-badge=${item.id}
    data-due-date=${item.due_date}
    data-due-category=${category}
    data-due-archived=${String(!!item.archived)}
  >${status.label}</span>`;
}
export function dueDateBadge(item) {
  return itemDateStatus(item) ? nodeOf(dueDateBadgeTemplate(item)) : undefined;
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
// Cards and list rows are lit templates that compute their badges from the
// date, so they are re-rendered; editor badges are patched in place.
export function refreshDueDateBadges(now = new Date()) {
  document.querySelectorAll('.badge-due[data-due-date-badge]').forEach((badge) => {
    if (badge.closest('.card,.list-row')) return;
    const status = dueDatePresentation(
      badge.dataset.dueDate,
      badge.dataset.dueCategory,
      badge.dataset.dueArchived === 'true',
      now,
    );
    if (!status) {
      badge.remove();
      return;
    }
    badge.textContent = status.label;
    badge.classList.toggle('is-overdue', status.overdue);
    positionEditorDueBadge(badge, status.overdue);
  });
  if (document.querySelector('.card,.list-row')) hooks.renderContent();
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
