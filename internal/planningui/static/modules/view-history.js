// The History page.
import { el, button } from './dom.js';
import { api } from './api.js';
import { workspaceHistoryLabel } from './format.js';
import { pageStack, emptyState } from './layout.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { notice } from './notices.js';
import { memberListingInfo } from './people.js';

export async function loadHistory(reset = false) {
  const events = await api(
    state.root +
      '/history' +
      (!reset && state.historyBefore ? `?before=${state.historyBefore}` : ''),
  );
  state.history = reset ? events : [...state.history, ...events];
  state.historyBefore = events.at(-1)?.id || 0;
  state.historyMore = events.length === 50;
}
function historyActorLabel(subject) {
  const member = state.board.members.find((candidate) => candidate.subject === subject);
  const name = member
    ? memberListingInfo(member).name
    : subject === state.session?.subject
      ? String(state.session.name || '').trim()
      : '';
  return name ? `${name} (${subject})` : subject;
}
export function renderHistory(content) {
  const page = pageStack('history');
  const label = workspaceHistoryLabel(state.board.workspace);
  page.append(el('p', label, 'muted'));
  if (!state.history.length) page.append(emptyState('No planning changes yet.'));
  const list = el('div', undefined, 'history-list');
  state.history.forEach((e) => {
    const row = el('article', undefined, 'history-row');
    row.append(
      el('strong', e.action.replaceAll('.', ' · ')),
      el(
        'p',
        `${historyActorLabel(e.actor)} · ${new Date(e.at).toLocaleString()} · ${label} · ${e.legacy_project_id ? 'legacy project' : 'workspace'} revision ${e.revision}`,
        'muted',
      ),
    );
    if (e.target) row.append(el('small', `Target ${e.target}`, 'card-id'));
    if (e.reason) row.append(el('p', e.reason));
    list.append(row);
  });
  if (list.childElementCount) page.append(list);
  if (state.historyMore)
    page.append(
      button('Load older changes', async () => {
        try {
          await loadHistory();
          hooks.renderContent();
        } catch (e) {
          notice(e.message, true);
        }
      }),
    );
  content.append(page);
}
