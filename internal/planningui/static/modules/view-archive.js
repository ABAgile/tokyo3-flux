// The Archive view and its paging.
import { $ } from './dom.js';
import { api } from './api.js';
import { contentRoot, emptyStateTemplate } from './layout.js';
import { html, nothing, render, repeat } from './lit.js';
import { state } from './state.js';
import { cardTemplate } from './view-board.js';

export function renderCardListContent(content, items) {
  const view = `list:${state.view}`;
  const current = content.firstElementChild;
  const root = current?.dataset.contentView === view ? current : contentRoot('div', 'list', view);
  const empty =
    state.view === 'board' && $('scope').value === 'backlog'
      ? 'Backlog is clear. Create work without a sprint to plan what comes next.'
      : 'No matching work.';
  render(
    html`${repeat(items, (item) => item.id, cardTemplate)}${
      items.length ? nothing : emptyStateTemplate(empty)
    }`,
    root,
  );
  if (root !== current) content.replaceChildren(root);
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
