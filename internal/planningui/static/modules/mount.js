// The two content mounts: the planning frame and the page root.
import { $ } from './dom.js';
import { state } from './state.js';
import { hooks } from './hooks.js';

// `#content` has exactly two mounts: the persistent planning frame — project
// lens, sprint summaries, the planning filter slot and the board/list body — and
// `#page-root`, where every other view renders one page root. Keeping the frame
// attached lets the summaries and filters hold their state across renders.
export function planningHost() {
  mountPage(false, '');
  return $('planning-body');
}
// `keepView` names the page root that survives this render, so the view's lit
// root is updated in place instead of rebuilt.
export function pageHost(keepView = '') {
  mountPage(true, keepView);
  return $('page-root');
}
export function pageRoot(contentView) {
  return $('page-root').querySelector(`:scope > [data-content-view="${contentView}"]`);
}
function mountPage(showPageRoot, keepView) {
  const host = $('page-root');
  const keep = keepView ? pageRoot(keepView) : null;
  const discarded = [...host.children].filter((node) => node !== keep);
  // The planning filter bar is relocated, never duplicated, so it must be moved
  // home before the page root hosting it is discarded.
  if (discarded.some((node) => node.contains($('planning-filters')))) hooks.placeFilters();
  $('planning-frame').hidden = showPageRoot;
  host.hidden = !showPageRoot;
  discarded.forEach((node) => node.remove());
  setContentBusy(state.contentBusy);
}
export function setContentBusy(value) {
  state.contentBusy = !!value;
  const region = $('planning-frame').hidden ? $('page-root') : $('planning-body');
  ($('page-root') === region ? $('planning-body') : $('page-root')).removeAttribute('aria-busy');
  region.setAttribute('aria-busy', String(state.contentBusy));
}
