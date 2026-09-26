// The workspace gate, workspace list and creation, and the first-run checklist.
import { $, options } from './dom.js';
import { api, requestKey } from './api.js';
import { workspaceLabel } from './format.js';
import { renderRoot, helpTextTemplate, setStatusText } from './layout.js';
import { html, nothing, repeat } from './lit.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { accessButtonTemplate } from './permissions.js';
import { notice, clearError, clearPlanningChangeNotice } from './notices.js';
import { renderControls } from './controls.js';
import { setContentBusy } from './mount.js';
import { projectFilters, clearFilterGroup, clearFilters, resetSearch } from './filters.js';
import { resetBurndown } from './view-burndown.js';
import { clearUndo } from './commands.js';
import { closeEditor } from './dialog.js';
import { persistWorkspaceURL, persistPlanningURL, applyPlanningURLState } from './url-state.js';
import { closeDetail } from './item-detail.js';
import { resetSprintHistory } from './view-sprints.js';
import { goToView } from './shortcuts.js';

function validWorkspaceList(data) {
  return (
    Array.isArray(data) &&
    data.every(
      (workspace) =>
        workspace &&
        typeof workspace.id === 'string' &&
        workspace.id &&
        typeof workspace.name === 'string' &&
        workspace.name &&
        typeof workspace.role === 'string' &&
        Number.isSafeInteger(workspace.revision),
    )
  );
}
export function workspaceListSignature(list) {
  return JSON.stringify(
    list.map((workspace) => [workspace.id, workspace.name, workspace.role, workspace.revision]),
  );
}
function updateWorkspaceOptions(selected = '') {
  const signature = workspaceListSignature(state.workspaces);
  const select = $('workspace');
  if (select.dataset.signature === signature && select.value === selected) return;
  options(
    select,
    state.workspaces.map((workspace) => [workspace.id, workspaceLabel(workspace)]),
    selected,
  );
  select.dataset.signature = signature;
}
export async function loadWorkspaces(selected = '') {
  const next = await api('/api/v2/workspaces');
  if (!validWorkspaceList(next)) throw new Error('Workspace list is invalid. Refresh to retry.');
  state.workspaces = next;
  updateWorkspaceOptions(
    selected && state.workspaces.some((workspace) => workspace.id === selected) ? selected : '',
  );
  return next;
}
export function enterWorkspaceGate(mode, message) {
  if (state.detailState) closeDetail({ force: true, focus: false });
  if ($('editor').open && !state.busy) closeEditor();
  clearUndo();
  state.bulkSelection.clear();
  state.board = undefined;
  state.root = undefined;
  state.boardETag = '';
  state.boardETagRoot = '';
  resetSprintHistory();
  state.workspaceGate = mode;
  state.pendingPlanningURLState = undefined;
  persistWorkspaceURL('');
  if (message) notice(message);
  hooks.render();
}
export async function refreshWorkspaceGate() {
  if (state.busy || state.loading || state.integrationFormOpen) return false;
  const generation = ++state.loadGeneration;
  state.loading = true;
  renderControls();
  setContentBusy(true);
  try {
    const next = await loadWorkspaces('');
    if (generation !== state.loadGeneration) return false;
    if (next.length === 1) {
      state.loading = false;
      return await chooseWorkspace(next[0].id);
    }
    state.workspaceGate = next.length ? 'select' : 'create';
    if (!next.length) persistWorkspaceURL('');
    notice(
      next.length
        ? 'Choose a workspace to continue.'
        : 'No workspace yet. Create one to get started.',
    );
    return true;
  } catch (e) {
    if (generation === state.loadGeneration) notice(e.message, true);
    return false;
  } finally {
    if (generation === state.loadGeneration) {
      state.loading = false;
      hooks.render();
    }
  }
}
// Gate pages keep their root while the gate mode is unchanged, so a render
// during loading keeps what the user typed.
export function renderWorkspaceSelection(content) {
  const gate = renderRoot(
    content,
    'panel workspace-gate',
    'workspace-select',
    html`${helpTextTemplate(
      'Select the workspace you want to open. You can switch workspaces from the sidebar after entering one.',
    )}
      <div class="workspace-choice-list" role="list">
        ${repeat(
          state.workspaces,
          (workspace) => workspace.id,
          (workspace) => html`<button
            type="button"
            class="workspace-choice"
            data-workspace-choice=${workspace.id}
            aria-label=${`Open ${workspace.name}`}
            @click=${() => {
              void chooseWorkspace(workspace.id);
            }}
          >
            <span class="workspace-choice-copy">
              <strong>${workspace.name}</strong>
              <small class="muted">${`${workspace.role} access`}</small>
            </span>
            <span class="workspace-choice-action">Open →</span>
          </button>`,
        )}
      </div>
      <div class="actions workspace-gate-actions">
        <button type="button" class="primary" @click=${showWorkspaceCreate}>Create a workspace</button>
      </div>`,
    'section',
  );
  gate.setAttribute('aria-label', 'Choose a workspace');
}
// The name input, submit button and status line belong to createWorkspace
// while a request runs, so the template binds none of their state.
export function renderWorkspaceCreation(content) {
  const created = content.firstElementChild?.dataset.contentView !== 'workspace-create';
  const gate = renderRoot(
    content,
    'panel workspace-gate',
    'workspace-create',
    html`${helpTextTemplate(
      state.session?.name
        ? `You are signed in as ${state.session.name}. Create a workspace to start planning; you will be its initial administrator.`
        : 'Create a workspace to start planning; your signed-in account will be its initial administrator.',
    )}
      <form class="workspace-create-form" @submit=${createWorkspace}>
        <label
          >Workspace name<input
            name="name"
            type="text"
            id="workspace-name"
            required
            maxlength="120"
            autocomplete="organization"
            placeholder="e.g. Team Alpha"
        /></label>
        <p
          class="workspace-create-status"
          data-status-class="workspace-create-status"
          data-workspace-create-status="true"
          hidden
          role="status"
          aria-live="polite"
        ></p>
        <div class="actions">
          <button type="submit" class="primary">Create workspace</button>
          ${
            state.workspaces.length
              ? html`<button type="button" @click=${showWorkspaceSelection}
                  >Back to workspace selection</button
                >`
              : nothing
          }
        </div>
      </form>`,
    'section',
  );
  gate.setAttribute('aria-label', 'Create a workspace');
  if (created) gate.querySelector('#workspace-name').focus();
}
// A brand-new board shows a short setup path instead of empty columns, so the
// workspace-creation momentum carries into the first sprint and card.
export function renderFirstRun(content) {
  const steps = [
    {
      done: state.board.projects.length > 0,
      title: 'Create a project',
      help: 'Projects classify work items; they are optional but make filtering and the project lens useful.',
      action: 'Open Projects',
      run: () => goToView('projects'),
    },
    {
      done: state.board.sprints.length > 0,
      title: 'Create and start a sprint',
      help: 'Give the sprint a goal and a time box, then start it so the board can show active scope.',
      action: 'Open Sprints',
      run: () => goToView('sprints'),
    },
    {
      done: state.board.items.length > 0,
      title: 'Add your first work item',
      help: 'Every card belongs to a board column; sprints and projects can be added at any time.',
      action: '＋ New item',
      run: () => $('new-item').click(),
    },
  ];
  const setup = renderRoot(
    content,
    'panel first-run',
    'first-run',
    html`<h2 id="first-run-heading">Set up your planning workspace</h2>
      ${helpTextTemplate(
        'Three steps get this workspace to a board your team can use. You can do them in any order.',
      )}
      <ol class="first-run-steps">
        ${steps.map(
          (step, index) => html`<li
            class=${`first-run-step${step.done ? ' is-done' : ''}`}
            aria-label=${`${step.title} — ${step.done ? 'done' : 'not started'}`}
          >
            <span class="first-run-mark" aria-hidden="true">${step.done ? '✓' : String(index + 1)}</span>
            <div class="first-run-copy">
              <strong>${step.title}</strong>
              <span class="help">${step.help}</span>
            </div>
            ${accessButtonTemplate(step.action, step.run, {
              className: step.done ? undefined : 'primary',
              tracked: false,
              label: `${step.action}: ${step.title}`,
            })}
          </li>`,
        )}
      </ol>`,
    'section',
  );
  setup.setAttribute('aria-labelledby', 'first-run-heading');
}
export function showFirstRun() {
  return (
    state.view === 'board' &&
    state.board.role !== 'viewer' &&
    !state.board.items.length &&
    !state.board.sprints.length &&
    !state.searchQuery
  );
}
function showWorkspaceSelection() {
  if (state.busy || state.loading) return;
  state.workspaceGate = 'select';
  hooks.render();
  document.querySelector('[data-workspace-choice]')?.focus();
}
export function showWorkspaceCreate() {
  if (state.busy || state.loading || state.integrationFormOpen) return;
  state.workspaceCreateKey = '';
  state.workspaceCreateName = '';
  if (state.board) {
    enterWorkspaceGate('create', 'Create a workspace to add another planning space.');
    return;
  }
  state.workspaceGate = 'create';
  hooks.render();
}
async function createWorkspace(event) {
  event.preventDefault();
  if (state.workspaceCreating || state.busy || state.loading) return;
  const form = event.currentTarget;
  const input = form.elements.name;
  const status = form.querySelector('[data-workspace-create-status]');
  const submit = form.querySelector('button[type="submit"]');
  const name = String(input.value || '').trim();
  const setStatus = (text, error = false) => setStatusText(status, text, error);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL and line breaks are rejected on purpose.
  if (!name || name.length > 120 || /[\u0000\r\n]/.test(name)) {
    setStatus('Workspace name must be between 1 and 120 characters.', true);
    input.focus();
    return;
  }
  if (state.workspaceCreateName !== name || !state.workspaceCreateKey) {
    state.workspaceCreateName = name;
    state.workspaceCreateKey = requestKey();
  }
  state.workspaceCreating = true;
  submit.disabled = true;
  input.disabled = true;
  setStatus('Creating workspace…');
  try {
    const created = await api('/api/v2/workspaces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': state.session.csrf,
        'Idempotency-Key': state.workspaceCreateKey,
      },
      body: JSON.stringify({ name }),
    });
    if (!validWorkspaceList([created]))
      throw new Error('Workspace response is invalid. Refresh to retry.');
    const next = await loadWorkspaces(created.id);
    if (!next.some((workspace) => workspace.id === created.id))
      throw new Error('The new workspace is not available yet. Refresh to retry.');
    state.pendingPlanningURLState = undefined;
    if (!(await chooseWorkspace(created.id)))
      throw new Error('Workspace created, but its board could not be opened. Refresh to retry.');
    state.workspaceCreateKey = '';
    state.workspaceCreateName = '';
  } catch (error) {
    if (!document.querySelector('[data-workspace-create-status]')) {
      state.workspaceGate = 'create';
      state.root = undefined;
      hooks.render();
    }
    const currentForm = document.querySelector('.workspace-create-form');
    const currentStatus = currentForm?.querySelector('[data-workspace-create-status]');
    const currentInput = currentForm?.elements.name;
    if (currentInput && !currentInput.value) currentInput.value = state.workspaceCreateName || name;
    if (currentStatus) setStatusText(currentStatus, error.message, true);
    if (currentInput) currentInput.focus();
  } finally {
    state.workspaceCreating = false;
    const currentForm = document.querySelector('.workspace-create-form');
    if (currentForm) {
      currentForm.elements.name.disabled = false;
      currentForm.querySelector('button[type="submit"]').disabled = false;
    }
    renderControls();
  }
}
export async function chooseWorkspace(workspaceID = '') {
  if (state.busy || state.loading) return false;
  if (state.detailState && !closeDetail({ focus: false })) {
    if (state.board?.workspace?.id) $('workspace').value = state.board.workspace.id;
    return false;
  }
  const selectedID = workspaceID || $('workspace').value;
  if (!state.workspaces.some((workspace) => workspace.id === selectedID)) return false;
  const urlState = state.pendingPlanningURLState;
  state.pendingPlanningURLState = undefined;
  state.integrationFormOpen = false;
  state.integrationCatalog = [];
  state.integrationCatalogLoaded = false;
  state.integrationCatalogError = '';
  state.integrationCatalogLoading = false;
  state.integrationCatalogRequest++;
  clearPlanningChangeNotice();
  clearUndo();
  clearError();
  state.bulkSelection.clear();
  state.board = undefined;
  state.workspaceGate = 'loading';
  updateWorkspaceOptions(selectedID);
  resetBurndown();
  state.burndownExpanded.clear();
  resetSprintHistory();
  state.projectSearch = '';
  clearFilterGroup(projectFilters);
  clearFilters();
  $('scope').value = 'active';
  resetSearch();
  state.root = `/api/v2/workspaces/${encodeURIComponent(selectedID)}`;
  hooks.render();
  const refreshed = await hooks.refresh();
  if (!refreshed) {
    if (urlState && state.workspaceGate === 'loading') state.pendingPlanningURLState = urlState;
    return false;
  }
  state.workspaceGate = '';
  persistWorkspaceURL(selectedID);
  if (urlState) applyPlanningURLState(urlState);
  else persistPlanningURL();
  return true;
}
