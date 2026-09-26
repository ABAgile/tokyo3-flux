// The History page.
import { api } from './api.js';
import { workspaceHistoryLabel } from './format.js';
import { renderPage, emptyStateTemplate } from './layout.js';
import { html, nothing, keyedList } from './preact.js';
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
async function loadOlderHistory() {
  try {
    await loadHistory();
    hooks.renderContent();
  } catch (e) {
    notice(e.message, true);
  }
}
function historyRowTemplate(event, label) {
  const scope = event.legacy_project_id ? 'legacy project' : 'workspace';
  const meta = `${historyActorLabel(event.actor)} · ${new Date(event.at).toLocaleString()} · ${label} · ${scope} revision ${event.revision}`;
  return html`<article class="history-row">
    <strong>${event.action.replaceAll('.', ' · ')}</strong>
    <p class="muted">${meta}</p>
    ${event.target ? html`<small class="card-id">${`Target ${event.target}`}</small>` : nothing}
    ${event.reason ? html`<p>${event.reason}</p>` : nothing}
  </article>`;
}
export function renderHistory(content) {
  const label = workspaceHistoryLabel(state.board.workspace);
  renderPage(
    content,
    'history',
    html`<p class="muted">${label}</p>
      ${state.history.length ? nothing : emptyStateTemplate('No planning changes yet.')}
      ${
        state.history.length
          ? html`<div class="history-list">
              ${keyedList(
                state.history,
                (event) => event.id,
                (event) => historyRowTemplate(event, label),
              )}
            </div>`
          : nothing
      }
      ${
        state.historyMore
          ? html`<button type="button" onClick=${loadOlderHistory}>Load older changes</button>`
          : nothing
      }`,
  );
}
