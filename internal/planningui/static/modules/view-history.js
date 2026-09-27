// The History page.
import { workspaceHistoryLabel } from './format.js';
import { emptyStateTemplate } from './layout.js';
import { html, shallowEqual } from './vdom.js';

import { useStore } from './state.js';
import { notice } from './notices.js';
import { memberListingInfo } from './people.js';
import { selectLookups } from './lookups.js';
import { loadHistory } from './page-data.js';
function historyActorLabel(lookups, subject) {
  const { session } = lookups;
  const member = lookups.membersBySubject.get(subject);
  const name = member
    ? memberListingInfo(member, session).name
    : subject === session?.subject
      ? String(session.name || '').trim()
      : '';
  return name ? `${name} (${subject})` : subject;
}
async function loadOlderHistory() {
  try {
    await loadHistory();
  } catch (e) {
    notice(e.message, true);
  }
}
function HistoryRow({ event, label, lookups }) {
  const scope = event.legacy_project_id ? 'legacy project' : 'workspace';
  const meta = `${historyActorLabel(lookups, event.actor)} · ${new Date(event.at).toLocaleString()} · ${label} · ${scope} revision ${event.revision}`;
  return html`<article class="history-row">
    <strong>${event.action.replaceAll('.', ' · ')}</strong>
    <p class="muted">${meta}</p>
    ${event.target ? html`<small class="card-id">${`Target ${event.target}`}</small>` : null}
    ${event.reason ? html`<p>${event.reason}</p>` : null}
  </article>`;
}
function selectHistoryPage(current) {
  return {
    board: current.board,
    lookups: selectLookups(current),
    history: current.history,
    historyMore: current.historyMore,
  };
}

export function HistoryPage() {
  const { board, lookups, history, historyMore } = useStore(selectHistoryPage, shallowEqual);
  const label = workspaceHistoryLabel(board.workspace);
  return html`<p class="muted">${label}</p>
    ${history.length ? null : emptyStateTemplate('No planning changes yet.')}
    ${
      history.length
        ? html`<div class="history-list">
            ${history.map((event) => html`<${HistoryRow} key=${event.id} event=${event} label=${label} lookups=${lookups} />`)}
          </div>`
        : null
    }
    ${
      historyMore
        ? html`<button type="button" onClick=${loadOlderHistory}>Load older changes</button>`
        : null
    }`;
}
