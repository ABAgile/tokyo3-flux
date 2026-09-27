// Shared planning state. Components subscribe with `useStore(selector)`; every
// change is a `setState` patch that replaces top-level values. `state` is a
// read-only view for event handlers and controllers.
//
// The store holds data only: no DOM nodes, functions or timers. Transient
// browser resources live in component refs or module variables.
import { createStore } from './store.js';

/** @type {Flux.State} */
const initialState = {
  // Board reads are revalidated against the copy already in memory, so a refresh
  // that finds nothing new transfers no payload. The ETag is scoped to the root
  // it was issued for and discarded whenever the workspace changes.
  boardETag: '',
  boardETagRoot: '',
  // Bumped whenever a modified board is loaded, so derived caches and views that
  // reload with the board can key on it without watching every entity.
  boardGeneration: 0,
  session: undefined,
  workspaces: [],
  board: undefined,
  root: undefined,
  view: 'board',
  presentation: 'board',
  scope: 'active',
  theme: 'light',
  busy: false,
  loading: false,
  planningChangeNotice: false,
  planningChangeText: 'Planning changed elsewhere · Refresh to review',
  dueDateNow: undefined,
  workspaceGate: 'loading',
  workspaceCreating: false,
  workspaceCreateKey: '',
  workspaceCreateName: '',
  workspaceCreateDraft: '',
  workspaceCreateStatus: '',
  workspaceCreateStatusError: false,
  pendingPlanningURLState: undefined,
  // Planning URL parameters are written only after a workspace's URL state has
  // been applied, so a reload keeps the filters and card it was opened with.
  planningURLReady: false,
  // Planning filters hold the accepted values of each filter; an empty list
  // means "all" and the exclusive `none` means "no association".
  filters: { project: [], assignee: [], label: [] },
  projectFilters: { assignee: [], label: [] },
  projectSearch: '',
  selectedItemID: '',
  // The List detail pane: { itemID, formKey, item, itemRevision, draft,
  // originFocusKey, dirty, focusNonce }. `item` is the snapshot being edited.
  detail: undefined,
  detailError: '',
  // The open card is URL state: `item` names the card whose details are on
  // screen, so the address bar is always a shareable link to the current card.
  sharedItemID: '',
  editorItemID: '',
  // Loaded attachment metadata by item id. A fresh board drops these lists and
  // the next viewer reloads them.
  attachmentLists: {},
  history: [],
  historyBefore: 0,
  historyMore: false,
  // Archived work is paged from its own endpoint; the board payload carries only
  // the live working set plus archived items still referenced by scope or dependencies.
  archiveItems: [],
  archiveOffset: 0,
  archiveMore: false,
  sprintHistory: [],
  sprintHistoryOffset: 0,
  sprintHistoryMore: false,
  sprintHistoryError: '',
  // Selected item ids, in selection order.
  bulkSelection: [],
  undoOffer: undefined,
  undoText: '',
  integrationFormOpen: false,
  integrationDraft: undefined,
  integrationConsent: false,
  integrationSubmitting: false,
  integrationFormError: '',
  // Sprint ids whose burn-down chart is shown.
  burndownExpanded: [],
  // Burn-down requests in flight; the active content body is busy while any load.
  burndownPending: 0,
  searchQuery: '',
  searchInput: '',
  noticeText: 'Loading planning data…',
  errorText: '',
  // A drag is in progress; the marked drop zone is pointer state.
  dragging: false,
  // One upload at a time per browser, so a card drop and the editor picker
  // cannot race each other onto the same item.
  uploadBusy: false,
  // The open editor dialog: { type, props, key, revision, returnFocusKey }.
  editorDialog: undefined,
  editorError: '',
  shortcutsOpen: false,
  // A pending focus move, { scope, key, nonce }: the component named by `scope`
  // focuses the control with logical focus `key` once its render committed.
  focusRequest: undefined,
};

const { state, getState, setState, subscribe, useStore } = createStore(initialState);
export { state, getState, setState, subscribe, useStore };

// The board of the open workspace, for actions and handlers the UI offers only
// while a board is shown. Calling one without a board is a broken precondition.
/** @returns {Flux.Board} */
export function requireBoard() {
  if (!state.board) throw new Error('No workspace board is open.');
  return state.board;
}
// The API root of the open workspace, under the same precondition.
/** @returns {string} */
export function requireRoot() {
  if (!state.root) throw new Error('No workspace is open.');
  return state.root;
}
// The session's CSRF token, for writes, which the UI offers only once the
// session has loaded.
/** @returns {string} */
export function sessionCSRF() {
  if (!state.session) throw new Error('The session has not loaded.');
  return state.session.csrf;
}
