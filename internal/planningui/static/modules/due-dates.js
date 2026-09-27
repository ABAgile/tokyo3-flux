// Due-date badges and the overdue refresh.
import { dueDatePresentation } from './format.js';
import { hooks } from './hooks.js';
import { html } from './vdom.js';
import { setState, state, useStore } from './state.js';

export function itemDateStatus(item, now = state.dueDateNow || new Date()) {
  const category =
    state.board?.columns.find((column) => column.id === item.column_id)?.category || '';
  return dueDatePresentation(item.due_date, category, !!item.archived, now);
}
// `extraClass` places the badge, for example beside an overdue card title.
export function dueDateBadgeTemplate(item, extraClass = '', id) {
  const status = itemDateStatus(item);
  if (!status) return null;
  const category =
    state.board?.columns.find((column) => column.id === item.column_id)?.category || '';
  return html`<span
    id=${id}
    class="badge badge-due${status.overdue ? ' is-overdue' : ''}${extraClass}"
    data-due-date-badge=${item.id}
    data-due-date=${item.due_date}
    data-due-category=${category}
    data-due-archived=${String(!!item.archived)}
  >${status.label}</span>`;
}
export function EditorDueBadge({ item, id }) {
  const now = useStore((current) => current.dueDateNow);
  return itemDateStatus(item, now)?.overdue ? dueDateBadgeTemplate(item, '', id) : null;
}
// Date-dependent UI is a normal App update. Editor fields subscribe only for
// their date badge, keeping native drafts and other field widgets untouched.
export function refreshDueDateBadges(now = new Date()) {
  setState({ dueDateNow: now });
  hooks.renderContent();
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
