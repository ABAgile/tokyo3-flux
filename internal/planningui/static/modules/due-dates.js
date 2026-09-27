// Due-date badges and the overdue clock.
import { dueDatePresentation } from './format.js';
import { html } from './vdom.js';
import { useEffect } from './vendor-preact.js';
import { setState, state, useStore } from './state.js';
import { useEventListener } from './ui-hooks.js';

// `now` is the store's due-date clock; callers that render subscribe to it.
export function itemDateStatus(item, now = state.dueDateNow || new Date()) {
  const category =
    state.board?.columns.find((column) => column.id === item.column_id)?.category || '';
  return dueDatePresentation(item.due_date, category, !!item.archived, now || new Date());
}
// `extraClass` places the badge, for example beside an overdue card title.
export function dueDateBadgeTemplate(item, now, extraClass = '', id) {
  const status = itemDateStatus(item, now);
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
export function selectDueDateNow(current) {
  return current.dueDateNow;
}
export function EditorDueBadge({ item, id }) {
  const now = useStore(selectDueDateNow);
  return itemDateStatus(item, now)?.overdue ? dueDateBadgeTemplate(item, now, '', id) : null;
}
// The date-dependent UI updates at local midnight and whenever the page becomes
// visible again; both only move the store's clock.
export function useDueDateClock() {
  useEffect(() => {
    let timer;
    const schedule = () => {
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(
        () => {
          if (!document.hidden) setState({ dueDateNow: new Date() });
          schedule();
        },
        Math.max(1, midnight.getTime() - now.getTime() + 10),
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
  useEventListener(document, 'visibilitychange', () => {
    if (!document.hidden) setState({ dueDateNow: new Date() });
  });
}
