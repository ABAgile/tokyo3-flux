// Card lists outside the board columns: the Archive view and its paging.
import { emptyStateTemplate } from './layout.js';
import { Fragment, useRef } from './vendor-preact.js';
import { html } from './vdom.js';

import { useStore } from './state.js';
import { notice } from './notices.js';
import { loadArchive } from './page-data.js';
import { useFocusRestore } from './ui-hooks.js';
import { Card, useBlockedIDs, useExpandedAttachments, useRowContext } from './view-board.js';

async function loadOlderArchive() {
  try {
    await loadArchive();
  } catch (error) {
    notice(error.message, true);
  }
}
function selectScope(current) {
  return current.scope;
}
export function CardListContent({ items, view, archiveMore, disabled }) {
  const scope = useStore(selectScope);
  const context = useRowContext();
  const blockedIDs = useBlockedIDs(items);
  const [expanded, toggle] = useExpandedAttachments();
  const root = useRef(null);
  const focus = useFocusRestore(root, view);
  const empty =
    view === 'board' && scope === 'backlog'
      ? 'Backlog is clear. Create work without a sprint to plan what comes next.'
      : 'No matching work.';
  return html`<${Fragment}>
    <div class="list" data-content-view=${`list:${view}`} ref=${root} ...${focus}>
      ${items.map(
        (item) => html`<${Card}
          key=${item.id}
          item=${item}
          context=${context}
          isBlocked=${blockedIDs.has(item.id)}
          attachmentsOpen=${expanded.has(item.id)}
          onAttachmentsToggle=${toggle}
        />`,
      )}
      ${items.length ? null : emptyStateTemplate(empty)}
    </div>
    ${view === 'archive' && archiveMore ? html`<button type="button" class="archive-more" disabled=${disabled} onClick=${loadOlderArchive}>Load older archived work</button>` : null}
  </${Fragment}>`;
}
