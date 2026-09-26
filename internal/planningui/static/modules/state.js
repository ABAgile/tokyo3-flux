// Mutable planning-shell state shared by app.js and its feature modules.
// Modules cannot assign to imported bindings, so every top-level variable the
// shell reassigns lives here and is read and written as `state.<name>`.
export const state = {
  // Board reads are revalidated against the copy already in memory, so a refresh
  // that finds nothing new transfers no payload. The ETag is scoped to the root
  // it was issued for and discarded whenever the workspace changes.
  boardETag: '',
  boardETagRoot: '',
  session: undefined,
  workspaces: [],
  board: undefined,
  root: undefined,
  view: 'board',
  presentation: 'board',
  busy: false,
  loading: false,
  planningChangeNotice: false,
  overdueTimer: undefined,
  workspaceGate: 'loading',
  workspaceCreating: false,
  workspaceCreateKey: '',
  workspaceCreateName: '',
  membershipPoll: false,
  pendingPlanningURLState: undefined,
  projectSearch: '',
  projectFilterIDs: undefined,
  selectedItemID: '',
  detailPane: undefined,
  detailState: undefined,
  // The open card is URL state: `item` names the card whose details are on
  // screen, so the address bar is always a shareable link to the current card.
  sharedItemID: '',
  sharedItemSync: false,
  editorItemID: '',
  attachmentTooltip: undefined,
  attachmentTooltipTarget: undefined,
  observationTooltipTarget: undefined,
  history: [],
  historyBefore: 0,
  historyMore: false,
  loadGeneration: 0,
  // Archived work is paged from its own endpoint; the board payload carries only
  // the live working set plus archived items still referenced by scope or dependencies.
  archiveItems: [],
  archiveOffset: 0,
  archiveMore: false,
  sprintHistory: [],
  sprintHistoryOffset: 0,
  sprintHistoryMore: false,
  sprintHistoryError: '',
  bulkSelection: new Set(),
  undoOffer: undefined,
  undoTimer: undefined,
  integrationFormOpen: false,
  integrationCatalog: [],
  integrationCatalogLoaded: false,
  integrationCatalogError: '',
  integrationCatalogLoading: false,
  integrationCatalogRequest: 0,
  burndownData: new Map(),
  burndownRequests: new Map(),
  burndownErrors: new Map(),
  burndownExpanded: new Set(),
  burndownGeneration: 0,
  searchQuery: '',
  searchDebounce: undefined,
  searchIndexGeneration: 0,
  noticeText: '',
  errorText: '',
  shortcutChord: 0,
  // The busy flag belongs to the region that is actually rebuilt, so the filter
  // bar and the summaries above it stay available while work loads.
  contentBusy: true,
  drag: undefined,
  dragPreview: undefined,
  // One upload at a time per browser, so a card drop and the editor picker
  // cannot race each other onto the same item.
  uploadBusy: false,
  editorReturn: undefined,
  // The control that opened the editor dialog, for focus return after a rebuild.
  editorOpener: undefined,
  observationPoll: false,
  observationDigest: '',
  observationReadAt: 0,
};
