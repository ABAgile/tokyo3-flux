// The body-level App: sidebar, page frame, planning content, the editor dialog
// host with its dialog map, and the App-lifetime effects.
import { Fragment, useLayoutEffect, useReducer, useRef } from './vendor-preact.js';
import { html, shallowEqual } from './vdom.js';

import { useStore } from './state.js';
import { workspaceLabel } from './format.js';
import { StatusBars } from './notices.js';
import { canWrite } from './permissions.js';
import { emptyStateTemplate } from './layout.js';
import { selectFilteredItems, singleFilterValue } from './filters.js';
import { itemLookup, selectLookups } from './lookups.js';
import { useDueDateClock } from './due-dates.js';
import { usePolling } from './sync.js';
import { usePlanningURL } from './url-state.js';
import { EditorDialog } from './dialog.js';
import { AttachmentTooltip } from './tooltip.js';
import { isFileTransfer } from './item-attachments.js';
import { useEventListener } from './ui-hooks.js';
import { ErrorBoundary } from './error-boundary.js';
import {
  applyHistoryNavigation,
  chooseWorkspace,
  createWorkspace,
  navigate,
  newItem,
  refreshWorkspace,
  runUndo,
  showProposals,
  showWorkspaceCreate,
  showWorkspaceSelection,
  toggleTheme,
} from './actions.js';
import { WorkspaceSelection, WorkspaceCreation } from './gate-components.js';
import { AddLinkDialog } from './item-links.js';
import { ArchiveItemDialog, ItemEditorDialog } from './item-editor.js';
import { LinksDialog } from './gitlab.js';
import { PlanningFilters, SearchDebounce } from './planning-filters.js';
import { ProjectsPage, ProjectDialog } from './view-projects.js';
import {
  SprintsPage,
  SprintSummary,
  SprintDialog,
  CloseSprintDialog,
  ArchiveSprintDialog,
} from './view-sprints.js';
import { MembersPage, MemberDialog, RemoveMemberDialog, AddMemberDialog } from './view-members.js';
import { LabelsPage, LabelDialog, DeleteLabelDialog } from './view-labels.js';
import { HistoryPage } from './view-history.js';
import {
  BoardContent,
  ProjectSummary,
  BoardSetupDialog,
  ColumnDialog,
  RemoveColumnDialog,
  setupBoard,
} from './view-board.js';
import { ListPresentation } from './view-list.js';
import { CardListContent } from './view-archive.js';
import { BulkAssignDialog, BulkSprintDialog, BulkLabelDialog, BulkArchiveDialog } from './bulk.js';
import {
  ProposalsDialog,
  ProposalImportDialog,
  ProposalReviewDialog,
  ProposalRejectDialog,
} from './view-proposals.js';
import { FirstRunPage, showFirstRun } from './view-gate.js';
import { ShortcutsDialog, useGlobalShortcuts } from './shortcuts.js';

// Every editor dialog, by the type named in `openDialog(type, props)`.
/** @type {Readonly<{ [T in Flux.DialogType]: (props: Flux.DialogProps[T]) => unknown }>} */
export const DIALOGS = Object.freeze({
  'item.edit': ItemEditorDialog,
  'item.archive': ArchiveItemDialog,
  'links.show': LinksDialog,
  'link.add': AddLinkDialog,
  'board.setup': BoardSetupDialog,
  'column.edit': ColumnDialog,
  'column.remove': RemoveColumnDialog,
  'bulk.assign': BulkAssignDialog,
  'bulk.sprint': BulkSprintDialog,
  'bulk.label': BulkLabelDialog,
  'bulk.archive': BulkArchiveDialog,
  'sprint.edit': SprintDialog,
  'sprint.close': CloseSprintDialog,
  'sprint.archive': ArchiveSprintDialog,
  'project.edit': ProjectDialog,
  'label.edit': LabelDialog,
  'label.delete': DeleteLabelDialog,
  'member.edit': MemberDialog,
  'member.remove': RemoveMemberDialog,
  'member.add': AddMemberDialog,
  proposals: ProposalsDialog,
  'proposal.import': ProposalImportDialog,
  'proposal.review': ProposalReviewDialog,
  'proposal.reject': ProposalRejectDialog,
});

const VIEWS = [
  ['board', '▦', 'Kanban board'],
  ['sprints', '◷', 'Sprints'],
  ['projects', '▤', 'Projects'],
  ['members', '♙', 'Members'],
  ['labels', '▥', 'Labels'],
  ['archive', '▣', 'Archive'],
  ['history', '↺', 'History'],
];
const TITLES = {
  board: 'Kanban board',
  sprints: 'Sprints',
  projects: 'Projects',
  labels: 'Labels',
  members: 'Members',
  archive: 'Archive',
  history: 'History',
};
const SUBTITLES = {
  projects: 'Organize workspace projects and GitLab integration.',
  labels: 'Maintain labels used to classify work.',
  members: 'Manage workspace members, roles, and names.',
};
const PAGE_VIEWS = ['projects', 'sprints', 'members', 'labels', 'history'];
const PAGES = {
  projects: ProjectsPage,
  sprints: SprintsPage,
  members: MembersPage,
  labels: LabelsPage,
  history: HistoryPage,
};

function shellTitle({ board, view, presentation, workspaceGate, workspaceCount }) {
  if (board) return view === 'board' && presentation === 'list' ? 'Planning list' : TITLES[view];
  if (workspaceGate === 'select') return 'Choose a workspace';
  if (workspaceGate === 'create')
    return workspaceCount ? 'Create a workspace' : 'Create your first workspace';
  return 'Loading planning data';
}
function shellSubtitle({ board, view, workspaceGate }) {
  if (!board) {
    if (workspaceGate === 'select') return 'Select a shared planning space to continue.';
    if (workspaceGate === 'create') return 'Set up a shared planning space for your team.';
    return 'Checking workspace access…';
  }
  if (board.role === 'viewer') return 'Read-only workspace access.';
  return SUBTITLES[view] || 'Plan intentionally. Keep work moving.';
}
function blocked(current) {
  return current.busy || current.loading || current.integrationFormOpen;
}

function selectSidebar(current) {
  return {
    board: current.board,
    root: current.root,
    session: current.session,
    workspaces: current.workspaces,
    view: current.view,
    theme: current.theme,
    workspaceGate: current.workspaceGate,
    disabled: blocked(current),
  };
}
function Sidebar() {
  const { board, root, session, workspaces, view, theme, workspaceGate, disabled } = useStore(
    selectSidebar,
    shallowEqual,
  );
  // A refused workspace change renders again so the select shows the current one.
  const [, rerender] = useReducer((value) => value + 1, 0);
  const currentWorkspace =
    board?.workspace?.id ||
    workspaces.find(
      (workspace) => `/api/v2/workspaces/${encodeURIComponent(workspace.id)}` === root,
    )?.id ||
    '';
  const changeWorkspace = async (event) => {
    if (!(await chooseWorkspace(event.currentTarget.value))) rerender();
  };
  return html`<aside class="sidebar">
    <a class="brand" href="/" aria-label="Flux home"><span class="mark">F</span> flux <small>PLANNING</small></a>
    <div id="workspace-field" class="workspace-field" hidden=${!board && workspaceGate !== 'loading'}>
      <div class="workspace-label-row">
        <label for="workspace">Workspace</label>
        <div class="workspace-actions">
          <button id="new-workspace" class="icon-button" type="button" aria-label="Create workspace" title="Create workspace" disabled=${!session || disabled} onClick=${showWorkspaceCreate}><span aria-hidden="true">＋</span></button>
          <button id="refresh" class="icon-button" type="button" aria-label="Refresh" title="Refresh workspace" disabled=${disabled} onClick=${refreshWorkspace}><span aria-hidden="true">↻</span></button>
        </div>
      </div>
      <select id="workspace" aria-label="Workspace" value=${currentWorkspace} disabled=${!board || disabled} onChange=${changeWorkspace}>
        ${workspaces.map((workspace) => html`<option key=${workspace.id} value=${workspace.id}>${workspaceLabel(workspace)}</option>`)}
      </select>
    </div>
    <nav aria-label="Planning views" hidden=${!board}>
      ${VIEWS.map(([id, icon, label]) => html`<button key=${id} data-view=${id} aria-current=${view === id ? 'page' : null} disabled=${disabled} onClick=${() => navigate(id)}><span class="nav-icon" aria-hidden="true">${icon}</span><span>${label}</span></button>`)}
    </nav>
    <div class="sidebar-foot">
      <div class="sidebar-session">
        <button id="theme" class="icon-button theme-toggle" type="button" aria-label="Switch theme" title=${theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick=${toggleTheme}><span aria-hidden="true">${theme === 'dark' ? '☀' : '☾'}</span></button>
        <div class="sidebar-account"><span id="identity">${session?.name || session?.subject || 'Loading session…'}</span><a href="/auth/logout">Sign out</a></div>
      </div>
    </div>
  </aside>`;
}

function selectHeading(current) {
  return {
    board: current.board,
    view: current.view,
    presentation: current.presentation,
    workspaceGate: current.workspaceGate,
    workspaceCount: current.workspaces.length,
    canWrite: canWrite(current) && !current.integrationFormOpen,
  };
}
function Heading() {
  const heading = useStore(selectHeading, shallowEqual);
  return html`<div class="heading">
    <div><h1 id="title">${shellTitle(heading)}</h1><p id="subtitle" class="muted">${shellSubtitle(heading)}</p></div>
    <div class="actions heading-actions" hidden=${!heading.board}>
      <button id="proposals" onClick=${showProposals}>Proposals</button>
      <button id="columns" data-write disabled=${!heading.canWrite} onClick=${setupBoard}>Board setup</button>
      <button id="new-item" class="primary" data-write disabled=${!heading.canWrite} onClick=${newItem}>＋ New item</button>
    </div>
  </div>`;
}

function selectUndo(current) {
  return {
    offer: !!current.undoOffer,
    text: current.undoText,
    disabled: !current.board || current.board.role === 'viewer' || current.busy || current.loading,
  };
}
function UndoBar() {
  const undo = useStore(selectUndo, shallowEqual);
  return html`<div id="undo-bar" class="notice-bar notice-bar-accent" hidden=${!undo.offer} role="status" aria-live="polite">
    <span id="undo-text">${undo.text}</span>
    <button id="undo" type="button" disabled=${undo.disabled} onClick=${runUndo}>Undo</button>
  </div>`;
}

function selectGatePage(current) {
  return {
    board: current.board,
    view: current.view,
    workspaceGate: current.workspaceGate,
    workspaces: current.workspaces,
    session: current.session,
  };
}
function PageContent() {
  const { board, view, workspaceGate, workspaces, session } = useStore(
    selectGatePage,
    shallowEqual,
  );
  if (!board) {
    if (workspaceGate === 'select')
      return html`<section class="panel workspace-gate" data-content-view="workspace-select" aria-label="Choose a workspace">
        <${WorkspaceSelection} workspaces=${workspaces} choose=${chooseWorkspace} create=${showWorkspaceCreate} />
      </section>`;
    if (workspaceGate === 'create')
      return html`<section class="panel workspace-gate" data-content-view="workspace-create" aria-label="Create a workspace">
        <${WorkspaceCreation} name=${session?.name} hasWorkspaces=${workspaces.length > 0} submit=${createWorkspace} back=${showWorkspaceSelection} />
      </section>`;
    return html`<div data-content-view="workspace-loading">${emptyStateTemplate('Loading workspace access…')}</div>`;
  }
  const Page = PAGES[view];
  if (!Page) return null;
  return html`<div class="page-stack" data-content-view=${view}><${Page} /></div>`;
}

// The planning body stays mounted while a page view is shown, so returning to
// the board keeps its component lifetime; it renders the last planning view.
function selectPlanningBody(view) {
  return (current) => {
    const board = current.board;
    return {
      board,
      presentation: current.presentation,
      items: selectFilteredItems(current, view),
      firstRun: !!board && showFirstRun(current, view),
      busy: current.busy || current.loading,
      writeBlocked: board?.role === 'viewer' || blocked(current),
      archiveMore: current.archiveMore,
    };
  };
}
function PlanningBody({ view }) {
  const body = useStore(selectPlanningBody(view), shallowEqual);
  const { board, presentation, items } = body;
  if (body.firstRun) return html`<${FirstRunPage} board=${board} disabled=${body.writeBlocked} />`;
  if (view === 'board' && presentation === 'list')
    return html`<${ListPresentation} items=${items} />`;
  if (view === 'board') return html`<${BoardContent} items=${items} />`;
  return html`<${CardListContent}
    items=${items}
    view=${view}
    archiveMore=${body.archiveMore}
    disabled=${body.busy}
  />`;
}
function selectContentBusy(current) {
  return (
    current.loading ||
    current.burndownPending > 0 ||
    (!current.board && current.workspaceGate === 'loading')
  );
}
function selectPlanningArea(current) {
  return {
    workspaceID: current.board?.workspace?.id,
    view: current.view,
    contentBusy: selectContentBusy(current),
  };
}
function selectSummaries(current) {
  return {
    board: current.board,
    lookups: selectLookups(current),
    items: itemLookup(current.board, current.archiveItems),
    view: current.view,
    scope: current.scope,
    projectID: singleFilterValue('project', current.filters),
  };
}
function Summaries() {
  const { board, lookups, items, view, scope, projectID } = useStore(selectSummaries, shallowEqual);
  return html`<${Fragment}>
    <${ProjectSummary}
      board=${board}
      lookups=${lookups}
      items=${items}
      view=${view}
      projectID=${projectID}
    />
    <${SprintSummary} board=${board} view=${view} scope=${scope} />
  </${Fragment}>`;
}
function PlanningArea() {
  const { workspaceID, view, contentBusy } = useStore(selectPlanningArea, shallowEqual);
  const showPageRoot = !workspaceID || PAGE_VIEWS.includes(view);
  const planningView = useRef('board');
  if (['board', 'archive'].includes(view)) planningView.current = view;
  // A failure below renders in place of the content only; another view or
  // workspace renders it again.
  return html`<section id="content" aria-label="Planning content">
    <${ErrorBoundary} label="Planning content" resetKey=${`${workspaceID}\u0000${view}`}>
    <div id="planning-frame" class="page-stack" hidden=${showPageRoot}>
      <${Summaries} />
      <div id="planning-filter-slot" class="filter-slot">
        ${view === 'sprints' ? null : html`<${PlanningFilters} />`}
      </div>
      <div id="planning-body" aria-busy=${showPageRoot ? undefined : String(contentBusy)}>${
        workspaceID
          ? html`<${PlanningBody} key=${workspaceID} view=${planningView.current} />`
          : null
      }</div>
    </div>
    <div id="page-root" hidden=${!showPageRoot} aria-busy=${showPageRoot ? String(contentBusy) : undefined}>
      ${showPageRoot ? html`<${PageContent} />` : null}
    </div>
    </${ErrorBoundary}>
  </section>`;
}

function selectTheme(current) {
  return current.theme;
}
// The App renders once at the body; every change reaches it through the store.
export function App({ dialogs = DIALOGS }) {
  const main = useRef(null);
  const theme = useStore(selectTheme);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useGlobalShortcuts(main);
  usePolling();
  usePlanningURL();
  useDueDateClock();
  useEventListener(window, 'popstate', () => {
    void applyHistoryNavigation();
  });
  // A file dropped outside an attachment target must not navigate the page away.
  const guardFileDrop = (event) => {
    if (isFileTransfer(event.dataTransfer)) event.preventDefault();
  };
  useEventListener(document, 'dragover', guardFileDrop);
  useEventListener(document, 'drop', guardFileDrop);
  return html`<${Fragment}>
    <a class="skip" href="#main">Skip to planning</a>
    <${Sidebar} />
    <main id="main" tabindex="-1" ref=${main}>
      <${Heading} />
      <div id="status-bars"><${StatusBars} refresh=${refreshWorkspace} /></div>
      <${UndoBar} />
      <${PlanningArea} />
    </main>
    <${EditorDialog} dialogs=${dialogs} />
    <${AttachmentTooltip} />
    <${ShortcutsDialog} />
    <${SearchDebounce} />
  </${Fragment}>`;
}
