// Preact owns the application shell; named content hosts keep existing view
// lifetimes stable while their controllers move into components.
import { Fragment, html, nothing, useLayoutEffect, useRef, withKey } from './preact.js';
import { state, useStore } from './state.js';
import { workspaceLabel } from './format.js';
import { memberName } from './people.js';
import { StatusBars } from './notices.js';
import { EditorDialog } from './dialog.js';
import { emptyStateTemplate } from './layout.js';
import { filteredItems, planningFilterChipsTemplate } from './filters.js';
import { labelOptionColors } from './items.js';
import { WorkspaceSelection, WorkspaceCreation } from './gate-components.js';
import { ProjectsPage } from './view-projects.js';
import { SprintsPage } from './view-sprints.js';
import { MembersPage } from './view-members.js';
import { LabelsPage } from './view-labels.js';
import { HistoryPage } from './view-history.js';
import { BoardContent } from './view-board.js';
import { ListPresentation } from './view-list.js';
import { CardListContent } from './view-archive.js';
import { FirstRunPage, showFirstRun } from './view-gate.js';

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
function selectShell(state) {
  return {
    board: state.board,
    root: state.root,
    session: state.session,
    workspaces: state.workspaces,
    view: state.view,
    presentation: state.presentation,
    scope: state.scope,
    theme: state.theme,
    workspaceGate: state.workspaceGate,
    busy: state.busy,
    loading: state.loading,
    integrationFormOpen: state.integrationFormOpen,
    undoOffer: state.undoOffer,
    undoText: state.undoText,
    editorDialog: state.editorDialog,
    editorSaveText: state.editorSaveText,
    editorError: state.editorError,
    contentBusy: state.contentBusy,
  };
}
function sameShell(left, right) {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.is(left[key], right[key]))
  );
}
function shellTitle({ board, view, presentation, workspaceGate, workspaces }) {
  if (board) return view === 'board' && presentation === 'list' ? 'Planning list' : TITLES[view];
  if (workspaceGate === 'select') return 'Choose a workspace';
  if (workspaceGate === 'create')
    return workspaces.length ? 'Create a workspace' : 'Create your first workspace';
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

function PageContent({
  board,
  view,
  workspaceGate,
  workspaces,
  session,
  onWorkspaceChoose,
  onWorkspaceCreate,
  onWorkspaceSubmit,
  onWorkspaceBack,
}) {
  if (!board) {
    if (workspaceGate === 'select')
      return html`<section class="panel workspace-gate" data-content-view="workspace-select" aria-label="Choose a workspace">
        <${WorkspaceSelection} workspaces=${workspaces} choose=${onWorkspaceChoose} create=${onWorkspaceCreate} />
      </section>`;
    if (workspaceGate === 'create')
      return html`<section class="panel workspace-gate" data-content-view="workspace-create" aria-label="Create a workspace">
        <${WorkspaceCreation} name=${session?.name} hasWorkspaces=${workspaces.length > 0} submit=${onWorkspaceSubmit} back=${onWorkspaceBack} />
      </section>`;
    return html`<div data-content-view="workspace-loading">${emptyStateTemplate('Loading workspace access…')}</div>`;
  }
  const pages = {
    projects: ProjectsPage,
    sprints: SprintsPage,
    members: MembersPage,
    labels: LabelsPage,
    history: HistoryPage,
  };
  const Page = pages[view];
  return Page ? html`<div class="page-stack" data-content-view=${view}><${Page} /></div>` : nothing;
}

function PlanningContent({ board, view, presentation, busy, loading, integrationFormOpen, items }) {
  if (showFirstRun())
    return html`<${FirstRunPage}
      board=${board}
      disabled=${board.role === 'viewer' || busy || loading || integrationFormOpen}
    />`;
  if (view === 'board' && presentation === 'list')
    return html`<${ListPresentation} items=${items} />`;
  if (view === 'board') return html`<${BoardContent} items=${items} />`;
  return html`<${CardListContent}
    items=${items}
    view=${view}
    archiveMore=${state.archiveMore}
    disabled=${busy || loading}
  />`;
}

function PlanningBody({
  active,
  board,
  view,
  presentation,
  busy,
  loading,
  integrationFormOpen,
  items,
}) {
  const content = useRef(nothing);
  if (active && board && ['board', 'archive'].includes(view))
    content.current = html`${withKey(
      board.workspace.id,
      html`<${PlanningContent}
        board=${board}
        view=${view}
        presentation=${presentation}
        busy=${busy}
        loading=${loading}
        integrationFormOpen=${integrationFormOpen}
        items=${items}
      />`,
    )}`;
  return content.current;
}

// The App owns both content mounts; the planning body keeps its component
// lifetime while hidden, just as the persistent frame did before migration.
function PlanningArea({
  showPageRoot,
  pageContent,
  contentBusy,
  board,
  view,
  presentation,
  scope,
  busy,
  loading,
  integrationFormOpen,
  onPresentation,
  onScopeChange,
  onFilterChange,
  onSearchInput,
  onSearchChange,
  onSearchKeyDown,
}) {
  const showFilters = !!board && !['history', 'projects', 'labels', 'members'].includes(view);
  const showLabelFilter = !['sprints', 'history'].includes(view);
  const items = board && ['board', 'archive'].includes(view) ? filteredItems() : [];
  const count =
    !board || !['board', 'archive'].includes(view)
      ? ''
      : view === 'archive'
        ? `${items.length} archived${state.archiveMore ? '+' : ''} · workspace revision ${board.workspace.revision}`
        : `${items.length} items · workspace revision ${board.workspace.revision}`;
  const selectedSprint = board?.sprints?.find((sprint) => sprint.id === scope);
  const summaryLabel =
    selectedSprint?.state === 'closed' ? `Closed sprint: ${selectedSprint.name}` : 'Active sprints';
  const focusKey = useRef('');
  const focusRoute = `${showPageRoot ? 'page' : view}:${view === 'board' ? presentation : ''}`;
  const previousRoute = useRef(focusRoute);
  if (previousRoute.current !== focusRoute) {
    focusKey.current = '';
    previousRoute.current = focusRoute;
  }
  useLayoutEffect(() => {
    if (showPageRoot || !focusKey.current || document.activeElement !== document.body) return;
    const target = document.querySelector(
      `#planning-body [data-focus-key="${CSS.escape(focusKey.current)}"]`,
    );
    target?.focus({ preventScroll: true });
  });
  const recordFocus = (event) => {
    const target = event.target.closest?.('[data-focus-key]');
    focusKey.current = target?.dataset.focusKey || '';
  };
  const clearOutsideFocus = (event) => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
      focusKey.current = '';
  };
  return html`<${Fragment}>
      <section id="content" aria-label="Planning content">
        <div id="planning-frame" class="page-stack" hidden=${showPageRoot}>
          <section id="project-summary" class="panel project-summary" hidden aria-label="Project summary"></section>
          <section id="sprint-summary" class="sprints" aria-label=${summaryLabel}></section>
          <div id="planning-filter-slot" class="filter-slot">
            <div id="planning-filters" class="filter-bar" hidden=${!showFilters}>
              <div class="actions">
                <label id="scope-label" hidden=${view !== 'board'}>Scope<select id="scope" value=${scope} onChange=${onScopeChange}>
                  <option value="active">Active sprints</option><option value="backlog">Backlog</option><option value="all">All open work</option>
                  ${board?.sprints?.map((sprint) => html`<option key=${sprint.id} value=${sprint.id}>${`${sprint.name} (${sprint.state})`}</option>`)}
                </select></label>
                <label>Project<select id="project" aria-label="Project" value="all" disabled=${!board || busy || loading} onChange=${(event) => onFilterChange('project', event)}>
                  <option value="all">All projects</option><option value="none">No project</option>
                  ${board?.projects?.map((project) => html`<option key=${project.id} value=${project.id}>${project.name}</option>`)}
                </select></label>
                <label>Assignee<select id="assignee" aria-label="Assignee" value="all" disabled=${!board || busy || loading} onChange=${(event) => onFilterChange('assignee', event)}>
                  <option value="all">All assignees</option><option value="none">Unassigned</option>
                  ${board?.members?.map((member) => html`<option key=${member.subject} value=${member.subject}>${memberName(member.subject)}</option>`)}
                </select></label>
                <label id="label-filter" hidden=${!showLabelFilter}>Label<select id="label" aria-label="Label" value="all" disabled=${!board || busy || loading} onChange=${(event) => onFilterChange('label', event)}>
                  <option value="all">All labels</option><option value="none">No labels</option>
                  ${board?.labels?.map((label) => html`<option key=${label.name} value=${label.name} style=${labelOptionColors(label.name)}>${label.name}</option>`)}
                </select></label>
                <label id="search-filter" hidden=${view === 'history'}>Search<input id="search" type="search" autocomplete="off" placeholder=${view === 'sprints' ? 'Find sprints…' : 'Find work…'} maxlength="240" onInput=${onSearchInput} onChange=${onSearchChange} onKeydown=${onSearchKeyDown} /></label>
              </div>
              <div class="filter-bar-end">
                <div id="presentation-toggle" class="presentation-toggle" role="group" aria-label="Planning presentation" hidden=${!board || view !== 'board'}>
                  <button id="presentation-board" type="button" disabled=${!board || busy || loading || integrationFormOpen} aria-pressed=${String(presentation === 'board')} onClick=${() => onPresentation('board')}>Board</button>
                  <button id="presentation-list" type="button" disabled=${!board || busy || loading || integrationFormOpen} aria-pressed=${String(presentation === 'list')} onClick=${() => onPresentation('list')}>List</button>
                </div>
                <span id="count" class="filter-bar-count muted">${count}</span>
              </div>
            </div>
            ${planningFilterChipsTemplate(showFilters, showLabelFilter)}
          </div>
          <div
            id="planning-body"
            aria-busy=${showPageRoot ? undefined : String(contentBusy)}
            onFocusCapture=${recordFocus}
            onBlurCapture=${clearOutsideFocus}
            onPointerDownCapture=${recordFocus}
          ><${PlanningBody}
            active=${!showPageRoot}
            board=${board}
            view=${view}
            presentation=${presentation}
            busy=${busy}
            loading=${loading}
            integrationFormOpen=${integrationFormOpen}
            items=${items}
          /></div>
        </div>
        <div id="page-root" hidden=${!showPageRoot} aria-busy=${showPageRoot ? String(contentBusy) : undefined}>
          ${showPageRoot ? pageContent : nothing}
        </div>
      </section>
    </>`;
}

function DialogHost({ onShortcutClose }) {
  return html`<${Fragment}>
      <dialog id="shortcuts" aria-labelledby="shortcuts-title">
        <div class="dialog-panel">
          <div class="dialog-head">
            <h2 id="shortcuts-title">Keyboard shortcuts</h2>
            <button type="button" id="shortcuts-dismiss" aria-label="Close keyboard shortcuts" onClick=${onShortcutClose}>×</button>
          </div>
          <dl class="shortcut-list">
            <dt><kbd>/</kbd></dt><dd>Focus the work search</dd>
            <dt><kbd>n</kbd></dt><dd>Create a work item</dd>
            <dt><kbd>r</kbd></dt><dd>Refresh the workspace</dd>
            <dt><kbd>g</kbd> <kbd>b</kbd></dt><dd>Go to the Kanban board</dd>
            <dt><kbd>g</kbd> <kbd>s</kbd></dt><dd>Go to Sprints</dd>
            <dt><kbd>g</kbd> <kbd>p</kbd></dt><dd>Go to Projects</dd>
            <dt><kbd>g</kbd> <kbd>m</kbd></dt><dd>Go to Members</dd>
            <dt><kbd>g</kbd> <kbd>l</kbd></dt><dd>Go to Labels</dd>
            <dt><kbd>g</kbd> <kbd>a</kbd></dt><dd>Go to Archive</dd>
            <dt><kbd>g</kbd> <kbd>h</kbd></dt><dd>Go to History</dd>
            <dt><kbd>Esc</kbd></dt><dd>Leave the focused control, or close the open dialog or detail pane</dd>
            <dt><kbd>?</kbd></dt><dd>Show this list</dd>
          </dl>
          <div class="dialog-foot"><button type="button" id="shortcuts-close" class="primary" onClick=${onShortcutClose}>Close</button></div>
        </div>
      </dialog>
    </>`;
}

export function App({
  refresh,
  onUndo,
  onThemeToggle,
  onWorkspaceCreate,
  onWorkspaceChoose,
  onWorkspaceChange,
  onView,
  onProposals,
  onSetupBoard,
  onNewItem,
  onPresentation,
  onScopeChange,
  onFilterChange,
  onSearchInput,
  onSearchChange,
  onSearchKeyDown,
  onShortcutClose,
  onWorkspaceSubmit,
  onWorkspaceBack,
}) {
  const shell = useStore(selectShell, sameShell);
  const {
    board,
    session,
    workspaces,
    root,
    view,
    presentation,
    scope,
    theme,
    workspaceGate,
    busy,
    loading,
    integrationFormOpen,
  } = shell;
  const currentWorkspace =
    board?.workspace?.id ||
    workspaces.find(
      (workspace) => `/api/v2/workspaces/${encodeURIComponent(workspace.id)}` === root,
    )?.id ||
    '';
  const disabled = busy || loading || integrationFormOpen;
  const canWrite = !!board && board.role !== 'viewer' && !disabled;
  return html`<${Fragment}>
    <a class="skip" href="#main">Skip to planning</a>
    <aside class="sidebar">
      <a class="brand" href="/" aria-label="Flux home"><span class="mark">F</span> flux <small>PLANNING</small></a>
      <div id="workspace-field" class="workspace-field" hidden=${!board && workspaceGate !== 'loading'}>
        <div class="workspace-label-row">
          <label for="workspace">Workspace</label>
          <div class="workspace-actions">
            <button id="new-workspace" class="icon-button" type="button" aria-label="Create workspace" title="Create workspace" disabled=${!session || disabled} onClick=${onWorkspaceCreate}><span aria-hidden="true">＋</span></button>
            <button id="refresh" class="icon-button" type="button" aria-label="Refresh" title="Refresh workspace" disabled=${disabled} onClick=${refresh}><span aria-hidden="true">↻</span></button>
          </div>
        </div>
        <select id="workspace" aria-label="Workspace" value=${currentWorkspace} disabled=${!board || disabled} onChange=${onWorkspaceChange}>
          ${workspaces.map((workspace) => html`<option key=${workspace.id} value=${workspace.id}>${workspaceLabel(workspace)}</option>`)}
        </select>
      </div>
      <nav aria-label="Planning views" hidden=${!board}>
        ${VIEWS.map(([id, icon, label]) => html`<button key=${id} data-view=${id} aria-current=${view === id ? 'page' : null} disabled=${disabled} onClick=${() => onView(id)}><span class="nav-icon" aria-hidden="true">${icon}</span><span>${label}</span></button>`)}
      </nav>
      <div class="sidebar-foot">
        <div class="sidebar-session">
          <button id="theme" class="icon-button theme-toggle" type="button" aria-label="Switch theme" title=${theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick=${onThemeToggle}><span aria-hidden="true">${theme === 'dark' ? '☀' : '☾'}</span></button>
          <div class="sidebar-account"><span id="identity">${session?.name || session?.subject || 'Loading session…'}</span><a href="/auth/logout">Sign out</a></div>
        </div>
      </div>
    </aside>
    <main id="main" tabindex="-1">
      <div class="heading">
        <div><h1 id="title">${shellTitle(shell)}</h1><p id="subtitle" class="muted">${shellSubtitle(shell)}</p></div>
        <div class="actions heading-actions" hidden=${!board}>
          <button id="proposals" onClick=${onProposals}>Proposals</button>
          <button id="columns" data-write disabled=${!canWrite} onClick=${onSetupBoard}>Board setup</button>
          <button id="new-item" class="primary" data-write disabled=${!canWrite} onClick=${onNewItem}>＋ New item</button>
        </div>
      </div>
      <div id="status-bars"><${StatusBars} refresh=${refresh} /></div>
      <div id="undo-bar" class="notice-bar notice-bar-accent" hidden=${!shell.undoOffer} role="status" aria-live="polite">
        <span id="undo-text">${shell.undoText}</span>
        <button id="undo" type="button" disabled=${!board || board.role === 'viewer' || busy || loading} onClick=${onUndo}>Undo</button>
      </div>
      <${PlanningArea}
        showPageRoot=${
          !board || ['projects', 'sprints', 'members', 'labels', 'history'].includes(view)
        }
        contentBusy=${shell.contentBusy}
        board=${board}
        view=${view}
        presentation=${presentation}
        scope=${scope}
        busy=${busy}
        loading=${loading}
        integrationFormOpen=${integrationFormOpen}
        pageContent=${html`<${PageContent}
          board=${board}
          view=${view}
          workspaceGate=${workspaceGate}
          workspaces=${workspaces}
          session=${session}
          onWorkspaceChoose=${onWorkspaceChoose}
          onWorkspaceCreate=${onWorkspaceCreate}
          onWorkspaceSubmit=${onWorkspaceSubmit}
          onWorkspaceBack=${onWorkspaceBack}
        />`}
        onPresentation=${onPresentation}
        onScopeChange=${onScopeChange}
        onFilterChange=${onFilterChange}
        onSearchInput=${onSearchInput}
        onSearchChange=${onSearchChange}
        onSearchKeyDown=${onSearchKeyDown}
      />
    </main>
    <${EditorDialog}
      config=${shell.editorDialog}
      busy=${shell.busy}
      saveText=${shell.editorSaveText}
      errorText=${shell.editorError}
    />
    <${DialogHost} onShortcutClose=${onShortcutClose} />
  </>`;
}
