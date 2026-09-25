// The Archive view and its paging.
import { $ } from './dom.js';
import { api } from './api.js';
import { contentRoot, emptyState } from './layout.js';
import { state } from './state.js';
import { patchNode, keyedNodeKey, reconcileKeyedChildren } from './reconcile.js';
import { patchCard, appendCards } from './view-board.js';

export function renderCardListContent(content, items) {
  const next = contentRoot('div', 'list', `list:${state.view}`);
  appendCards(next, items);
  if (!items.length)
    next.append(
      emptyState(
        state.view === 'board' && $('scope').value === 'backlog'
          ? 'Backlog is clear. Create work without a sprint to plan what comes next.'
          : 'No matching work.',
      ),
    );
  const current = content.firstElementChild;
  if (!current || current.dataset.contentView !== next.dataset.contentView) {
    content.replaceChildren(next);
    return;
  }
  reconcileKeyedChildren(current, [...next.children], keyedNodeKey, (target, fresh) =>
    fresh.dataset.item ? patchCard(target, fresh) : patchNode(target, fresh),
  );
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
