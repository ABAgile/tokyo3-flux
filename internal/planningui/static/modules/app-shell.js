// Preact owns the application shell. Legacy page mounts are isolated below it
// until their templates move into this tree.
import { Component, Fragment, html } from './preact.js';
import { useStore } from './state.js';
import { workspaceLabel } from './format.js';
import { StatusBars } from './notices.js';

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
    workspaceGate: state.workspaceGate,
    busy: state.busy,
    loading: state.loading,
    integrationFormOpen: state.integrationFormOpen,
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

// These hosts retain the existing DOM-first page/dialog lifetimes. The parent
// shell can update without reconciling children managed by those controllers.
class LegacyMain extends Component {
  shouldComponentUpdate() {
    return false;
  }

  render() {
    return html`<${Fragment}>
      <div id="undo-bar" class="notice-bar notice-bar-accent" hidden role="status" aria-live="polite">
        <span id="undo-text"></span>
        <button id="undo" type="button">Undo</button>
      </div>
      <section id="content" aria-label="Planning content">
        <div id="planning-frame" class="page-stack">
          <section id="project-summary" class="panel project-summary" hidden aria-label="Project summary"></section>
          <section id="sprint-summary" class="sprints" aria-label="Active sprints"></section>
          <div id="planning-filter-slot" class="filter-slot">
            <div id="planning-filters" class="filter-bar">
              <div class="actions">
                <label id="scope-label">Scope<select id="scope"><option value="active" selected>Active sprints</option><option value="backlog">Backlog</option><option value="all">All open work</option></select></label>
                <label>Project<select id="project" aria-label="Project"><option value="all">All projects</option><option value="none">No project</option></select></label>
                <label>Assignee<select id="assignee" aria-label="Assignee"><option value="all">All assignees</option><option value="none">Unassigned</option></select></label>
                <label id="label-filter">Label<select id="label" aria-label="Label"><option value="all">All labels</option><option value="none">No labels</option></select></label>
                <label id="search-filter">Search<input id="search" type="search" autocomplete="off" placeholder="Find work… (press /)" maxlength="240"></label>
              </div>
              <div class="filter-bar-end">
                <div id="presentation-toggle" class="presentation-toggle" role="group" aria-label="Planning presentation">
                  <button id="presentation-board" type="button" aria-pressed="true">Board</button>
                  <button id="presentation-list" type="button" aria-pressed="false">List</button>
                </div>
                <span id="count" class="filter-bar-count muted"></span>
              </div>
            </div>
            <div id="filter-chips" class="filter-chips" hidden role="group" aria-label="Active filters"></div>
          </div>
          <div id="planning-body" aria-busy="true"></div>
        </div>
        <div id="page-root" hidden></div>
      </section>
    </>`;
  }
}

class LegacyDialogs extends Component {
  shouldComponentUpdate() {
    return false;
  }

  render() {
    return html`<${Fragment}>
      <dialog id="editor" aria-labelledby="editor-title">
        <form id="editor-form">
          <div class="dialog-head">
            <h2 id="editor-title">Work item</h2>
            <button type="button" id="dismiss" aria-label="Close editor">×</button>
          </div>
          <div id="fields"></div>
          <p id="form-error" role="alert"></p>
          <div class="dialog-foot">
            <button type="button" id="cancel">Cancel</button>
            <button type="submit" class="primary" id="save">Save changes</button>
          </div>
        </form>
      </dialog>
      <dialog id="shortcuts" aria-labelledby="shortcuts-title">
        <div class="dialog-panel">
          <div class="dialog-head">
            <h2 id="shortcuts-title">Keyboard shortcuts</h2>
            <button type="button" id="shortcuts-dismiss" aria-label="Close keyboard shortcuts">×</button>
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
          <div class="dialog-foot"><button type="button" id="shortcuts-close" class="primary">Close</button></div>
        </div>
      </dialog>
    </>`;
  }
}

export function App({ refresh }) {
  const shell = useStore(selectShell, sameShell);
  const {
    board,
    session,
    workspaces,
    root,
    view,
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
  return html`<${Fragment}>
    <a class="skip" href="#main">Skip to planning</a>
    <aside class="sidebar">
      <a class="brand" href="/" aria-label="Flux home"><span class="mark">F</span> flux <small>PLANNING</small></a>
      <div id="workspace-field" class="workspace-field" hidden=${!board && workspaceGate !== 'loading'}>
        <div class="workspace-label-row">
          <label for="workspace">Workspace</label>
          <div class="workspace-actions">
            <button id="new-workspace" class="icon-button" type="button" aria-label="Create workspace" title="Create workspace" disabled=${!session || disabled}><span aria-hidden="true">＋</span></button>
            <button id="refresh" class="icon-button" type="button" aria-label="Refresh" title="Refresh workspace" disabled=${disabled}><span aria-hidden="true">↻</span></button>
          </div>
        </div>
        <select id="workspace" aria-label="Workspace" value=${currentWorkspace} disabled=${!board || disabled}>
          ${workspaces.map((workspace) => html`<option key=${workspace.id} value=${workspace.id}>${workspaceLabel(workspace)}</option>`)}
        </select>
      </div>
      <nav aria-label="Planning views" hidden=${!board}>
        ${VIEWS.map(([id, icon, label]) => html`<button key=${id} data-view=${id} aria-current=${view === id ? 'page' : null} disabled=${disabled}><span class="nav-icon" aria-hidden="true">${icon}</span><span>${label}</span></button>`)}
      </nav>
      <div class="sidebar-foot">
        <div class="sidebar-session">
          <button id="theme" class="icon-button theme-toggle" type="button" aria-label="Switch theme" title="Switch theme"><span aria-hidden="true">☾</span></button>
          <div class="sidebar-account"><span id="identity">${session?.name || session?.subject || 'Loading session…'}</span><a href="/auth/logout">Sign out</a></div>
        </div>
      </div>
    </aside>
    <main id="main" tabindex="-1">
      <div class="heading">
        <div><h1 id="title">${shellTitle(shell)}</h1><p id="subtitle" class="muted">${shellSubtitle(shell)}</p></div>
        <div class="actions heading-actions" hidden=${!board}>
          <button id="proposals">Proposals</button>
          <button id="columns" data-write>Board setup</button>
          <button id="new-item" class="primary" data-write>＋ New item</button>
        </div>
      </div>
      <div id="status-bars"><${StatusBars} refresh=${refresh} /></div>
      <${LegacyMain} />
    </main>
    <${LegacyDialogs} />
  </>`;
}
