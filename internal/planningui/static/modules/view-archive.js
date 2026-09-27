// The Archive view and its paging.
import { $ } from './dom.js';
import { api } from './api.js';
import { emptyStateTemplate } from './layout.js';
import { Fragment, html, nothing, keyedList } from './preact.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { notice } from './notices.js';
import { cardTemplate } from './view-board.js';

async function loadOlderArchive() {
  try {
    await loadArchive();
    hooks.renderContent();
  } catch (error) {
    notice(error.message, true);
  }
}
export function CardListContent({ items, view, archiveMore, disabled }) {
  const empty =
    view === 'board' && $('scope').value === 'backlog'
      ? 'Backlog is clear. Create work without a sprint to plan what comes next.'
      : 'No matching work.';
  return html`<${Fragment}>
    <div class="list" data-content-view=${`list:${view}`}>
      ${keyedList(
        items,
        (item) => item.id,
        (item) => cardTemplate(item),
      )}
      ${items.length ? nothing : emptyStateTemplate(empty)}
    </div>
    ${view === 'archive' && archiveMore ? html`<button type="button" class="archive-more" disabled=${disabled} onClick=${loadOlderArchive}>Load older archived work</button>` : nothing}
  </${Fragment}>`;
}
const ARCHIVE_PAGE = 50;
export function resetArchive() {
  state.archiveItems = [];
  state.archiveOffset = 0;
  state.archiveMore = false;
}
export async function loadArchive(reset = false) {
  const offset = reset ? 0 : state.archiveOffset;
  const page = await api(`${state.root}/archive?offset=${offset}&limit=${ARCHIVE_PAGE}`);
  if (!Array.isArray(page)) throw new Error('Archive response is invalid. Refresh to retry.');
  state.archiveItems = reset ? page : [...state.archiveItems, ...page];
  state.archiveOffset = offset + page.length;
  state.archiveMore = page.length === ARCHIVE_PAGE;
}
