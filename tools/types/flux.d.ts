// Shared types for the planning UI, checked by `make check-web` with
// `tsc --checkJs`. Modules refer to them in JSDoc as `Flux.<Name>`; nothing
// here is loaded by the browser. Board entities mirror the /api/v2 JSON
// contract in internal/planning.
declare namespace Flux {
  // ── Board entities ────────────────────────────────────────────────────────
  type Role = 'viewer' | 'member' | 'admin';
  interface Workspace {
    id: string;
    name: string;
    role: Role | string;
    revision: number;
  }
  interface Session {
    subject: string;
    name: string;
    avatar_url: string;
    csrf: string;
    demo?: boolean;
  }
  interface Member {
    subject: string;
    name: string;
    role: Role | string;
    username?: string;
    avatar_url?: string;
  }
  interface Label {
    name: string;
    color: string;
  }
  interface Project {
    id: string;
    workspace_id?: string;
    name: string;
    revision?: number;
  }
  interface Column {
    id: string;
    name: string;
    category: 'todo' | 'doing' | 'done' | string;
    position?: number;
    wip: number;
  }
  interface Item {
    id: string;
    title: string;
    description: string;
    start_date: string;
    end_date: string;
    due_date: string;
    column_id: string;
    project_id: string;
    project_ids: string[];
    sprint_ids: string[];
    assignee: string;
    rank?: number;
    revision?: number;
    archived?: boolean;
    labels: string[];
    dependencies: string[];
    attachment_count?: number;
  }
  type SprintState = 'planned' | 'active' | 'closed';
  interface Sprint {
    id: string;
    name: string;
    goal: string;
    start: string;
    end: string;
    state: SprintState | string;
    revision?: number;
  }
  interface Scope {
    sprint_id: string;
    item_id: string;
  }
  interface Participant {
    item_id: string;
    subject: string;
    roles: string[];
    name?: string;
    username?: string;
    avatar_url?: string;
  }
  interface Pipeline {
    id: number;
    url?: string;
    state: string;
    sha?: string;
  }
  interface Observation {
    url: string;
    title: string;
    mr_state: string;
    draft: boolean;
    review?: string;
    pipeline?: Pipeline | null;
  }
  interface Link {
    id: string;
    project: number;
    kind: 'mr' | 'pipeline' | string;
    number: number;
    items: string[];
    observation?: Observation | null;
    outcome: string;
    refresh_pending?: boolean;
    last_success?: string | null;
  }
  interface Integration {
    instance: string;
    projects: number[];
  }
  interface Board {
    workspace: Workspace;
    role: Role | string;
    refresh_seconds?: number;
    connector_instance: string;
    integration: Integration;
    projects: Project[];
    columns: Column[];
    items: Item[];
    sprints: Sprint[];
    labels: Label[];
    members: Member[];
    links: Link[];
    participants: Participant[];
    closed_scope: Scope[];
  }
  interface Attachment {
    id: number;
    item_id: string;
    name: string;
    content_type: string;
    size: number;
    digest: string;
    uploader: string;
    created_at: string;
  }
  interface HistoryEvent {
    id: number;
    actor: string;
    action: string;
    target: string;
    reason: string;
    at: string;
    revision: number;
    legacy_project_id?: string;
  }
  interface SprintHistoryRecord {
    sprint: Sprint;
    closure: {
      closed_at: string;
      scope_count?: number;
      completed_count?: number;
      carry_over_count?: number;
    };
  }
  // A revision-checked planning change posted to /changes.
  interface Command {
    kind: string;
    revision?: number;
    target?: string;
    before?: string;
    destination?: string;
    reason?: string;
    name?: string;
    color?: string;
    restore_sprint_ids?: string[];
    item?: Partial<Item>;
    column?: Partial<Column>;
    sprint?: Partial<Sprint>;
    project?: Partial<Project>;
    member?: Partial<Member>;
    integration?: Integration;
    link?: { project: number; kind: string; number: number };
    proposal?: unknown;
  }

  // ── Derived data ──────────────────────────────────────────────────────────
  // Board lookups from `boardLookups`; render helpers take these explicitly.
  interface Lookups {
    readonly session: Session | undefined;
    readonly membersBySubject: ReadonlyMap<string, Member>;
    readonly labelsByName: ReadonlyMap<string, Label>;
    readonly projectsById: ReadonlyMap<string, Project>;
    readonly sprintsById: ReadonlyMap<string, Sprint>;
    readonly columnsById: ReadonlyMap<string, Column>;
    readonly participantsByItem: ReadonlyMap<string, Participant[]>;
    readonly activeSprints: readonly Sprint[];
  }
  // Everything a memoized card or List row renders besides its own item.
  interface RowContext {
    lookups: Lookups;
    linksByItem: Map<string, Link[]>;
    sprintName: (id: string) => string;
    canWrite: boolean;
    writeDisabled: boolean;
    busy: boolean;
    role: string | undefined;
    now: Date | undefined;
    root: string | undefined;
  }
  // Filter groups hold accepted values; empty means all, `none` no association.
  interface Filters {
    project: string[];
    assignee: string[];
    label: string[];
  }
  interface ProjectFilters {
    assignee: string[];
    label: string[];
  }

  // ── UI records ────────────────────────────────────────────────────────────
  // The List detail pane; `item` is the snapshot being edited.
  interface Detail {
    itemID: string;
    formKey: string;
    item: Item;
    itemRevision: number | undefined;
    draft: ItemDraft | undefined;
    originFocusKey: string | undefined;
    dirty: boolean;
    focusNonce: number;
  }
  interface ItemDraft {
    title: string;
    description: string;
    start_date: string;
    end_date: string;
    due_date: string;
    column_id: string;
    project_ids: string[];
    assignee: string;
    sprint_ids: string[];
    labels: string[];
    dependencies: string[];
    link_ids: string[];
  }
  type EditorMode = 'modal' | 'detail';
  // The open dialog: the component named by `type` gets `props`.
  interface DialogRecord<T extends DialogType = DialogType> {
    type: T;
    props: DialogProps[T];
    key: string;
    revision: number | undefined;
    returnFocusKey: string;
  }
  interface FocusRequest {
    scope: string;
    key: string;
    nonce: number;
  }
  interface AttachmentTooltip {
    owner: string;
    text: string;
    inDialog: boolean;
    anchor: Box;
    target: Box;
  }
  interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  }
  interface PlanningURLState {
    mode?: 'list' | 'board';
    project?: string;
    assignee?: string;
    label?: string;
    scope?: string;
    item?: string;
  }

  // Props of every dialog in the App's DIALOGS map, by `openDialog` type.
  interface DialogProps {
    'item.edit': { item: Partial<Item>; draft?: ItemDraft; readOnly: boolean };
    'item.archive': { item: Item; mode: EditorMode };
    'links.show': {
      item: Item;
      links: Link[];
      instance: string;
      refreshSeconds: number | undefined;
      ready: boolean;
    };
    'link.add': {
      item: Item;
      draft?: ItemDraft;
      mode: EditorMode;
      originFocusKey?: string;
      previousLinkIDs: string[];
      root: string;
    };
    'board.setup': { columns: Column[] };
    'column.edit': { column?: Column };
    'column.remove': { column: Column; destinations: [string, string][] };
    'bulk.assign': { selected: number; members: Member[] };
    'bulk.sprint': { selected: number; sprints: Sprint[] };
    'bulk.label': { selected: number; labels: Label[] };
    'bulk.archive': { selected: number };
    'sprint.edit': { sprint?: Sprint };
    'sprint.close': {
      sprint: Sprint;
      scoped: number;
      unfinished: number;
      destinations: [string, string][];
    };
    'sprint.archive': { sprint: Sprint };
    'project.edit': { project?: Project };
    'label.edit': { name?: string; color?: string };
    'label.delete': { label: Label; count: number };
    'member.edit': { member: Member };
    'member.remove': { member: Member; assigned: number };
    'member.add': { root: string; connector: boolean };
    proposals: { root: string };
    'proposal.import': { document?: unknown; id: string };
    'proposal.review': { root: string; id: string };
    'proposal.reject': { id: string };
  }
  type DialogType = keyof DialogProps;

  // ── The store ─────────────────────────────────────────────────────────────
  interface State {
    boardETag: string;
    boardETagRoot: string;
    boardGeneration: number;
    session: Session | undefined;
    workspaces: Workspace[];
    board: Board | undefined;
    root: string | undefined;
    view: 'board' | 'sprints' | 'projects' | 'members' | 'labels' | 'archive' | 'history' | string;
    presentation: 'board' | 'list';
    scope: string;
    theme: 'light' | 'dark' | string;
    busy: boolean;
    loading: boolean;
    planningChangeNotice: boolean;
    planningChangeText: string;
    dueDateNow: Date | undefined;
    workspaceGate: '' | 'loading' | 'select' | 'create';
    workspaceCreating: boolean;
    workspaceCreateKey: string;
    workspaceCreateName: string;
    workspaceCreateDraft: string;
    workspaceCreateStatus: string;
    workspaceCreateStatusError: boolean;
    pendingPlanningURLState: PlanningURLState | undefined;
    planningURLReady: boolean;
    filters: Filters;
    projectFilters: ProjectFilters;
    projectSearch: string;
    selectedItemID: string;
    detail: Detail | undefined;
    detailError: string;
    sharedItemID: string;
    editorItemID: string;
    attachmentLists: Record<string, Attachment[] | undefined>;
    history: HistoryEvent[];
    historyBefore: number;
    historyMore: boolean;
    archiveItems: Item[];
    archiveOffset: number;
    archiveMore: boolean;
    sprintHistory: SprintHistoryRecord[];
    sprintHistoryOffset: number;
    sprintHistoryMore: boolean;
    sprintHistoryError: string;
    bulkSelection: string[];
    undoOffer: Command[] | undefined;
    undoText: string;
    integrationFormOpen: boolean;
    integrationDraft: string[] | undefined;
    integrationConsent: boolean;
    integrationSubmitting: boolean;
    integrationFormError: string;
    burndownExpanded: string[];
    burndownPending: number;
    searchQuery: string;
    searchInput: string;
    noticeText: string;
    errorText: string;
    dragging: boolean;
    uploadBusy: boolean;
    editorDialog: DialogRecord | undefined;
    editorError: string;
    shortcutsOpen: boolean;
    focusRequest: FocusRequest | undefined;
  }
  // Event-rate pointer state, in its own store (modules/pointer-state.js).
  interface PointerState {
    dropTarget: { key: string; mark: 'before' | 'after' | 'end' } | undefined;
    attachmentTooltip: AttachmentTooltip | undefined;
  }
  // A store update: a partial state, or a function of the current state that
  // returns one (or nothing, for no change).
  type Patch<S> = Partial<S> | ((current: S) => Partial<S> | undefined | void);
}
