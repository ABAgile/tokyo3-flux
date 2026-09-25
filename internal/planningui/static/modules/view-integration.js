// The GitLab integration form on the Projects page.
import { el, button, field } from './dom.js';
import { helpText, errorLine, setErrorText } from './layout.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { notice } from './notices.js';
import { renderControls } from './controls.js';
import { multiSelect } from './multi-select.js';
import { integrationProjectEntries, loadGitLabProjects } from './gitlab-catalog.js';
import { change } from './commands.js';

export function editIntegration() {
  if (!state.board || state.busy || state.loading || state.integrationFormOpen) return;
  state.integrationFormOpen = true;
  state.integrationCatalog = [];
  state.integrationCatalogLoaded = false;
  state.integrationCatalogError = '';
  state.integrationCatalogLoading = false;
  state.integrationCatalogRequest++;
  if (state.board.connector_instance) void loadIntegrationCatalog();
  else hooks.render();
}
export async function loadIntegrationCatalog() {
  if (!state.board || state.integrationCatalogLoading || state.view !== 'projects') return;
  const currentBoard = state.board,
    currentRoot = state.root,
    request = ++state.integrationCatalogRequest;
  state.integrationCatalogLoading = true;
  state.integrationCatalogError = '';
  if (state.integrationFormOpen) {
    hooks.render();
    notice('Loading available GitLab projects…');
  }
  try {
    const catalog = await loadGitLabProjects(currentRoot);
    if (
      request !== state.integrationCatalogRequest ||
      state.board !== currentBoard ||
      state.root !== currentRoot
    )
      return;
    state.integrationCatalog = catalog;
    state.integrationCatalogLoaded = true;
  } catch (error) {
    if (
      request !== state.integrationCatalogRequest ||
      state.board !== currentBoard ||
      state.root !== currentRoot
    )
      return;
    state.integrationCatalogError = error.message;
    state.integrationCatalogLoaded = true;
  } finally {
    // biome-ignore lint/correctness/noUnsafeFinally: a superseded request must not render; try/catch never rethrow.
    if (request !== state.integrationCatalogRequest) return;
    state.integrationCatalogLoading = false;
    if (state.board === currentBoard && state.root === currentRoot && state.view === 'projects') {
      if (state.integrationFormOpen) notice('');
      hooks.render();
    }
  }
}
export function renderIntegrationForm() {
  const currentBoard = state.board;
  const readOnly = currentBoard.role !== 'admin';
  const selected = currentBoard.integration.projects.map(String);
  const form = el('form', undefined, 'inline-maintenance-form');
  form.append(
    helpText(
      `Operator-configured instance: ${currentBoard.connector_instance || 'Not configured'}`,
    ),
  );
  form.append(helpText(`Existing approval: ${currentBoard.integration.instance || 'None'}`));
  multiSelect(
    form,
    'projects',
    'Approved GitLab projects',
    integrationProjectEntries(state.integrationCatalog, selected),
    selected,
    undefined,
    'Choose projects visible to the configured server-side read connector. The selected projects and their engineering metadata are shared with every workspace reader.',
  );
  if (state.integrationCatalogLoading) form.append(helpText('Loading available GitLab projects…'));
  if (state.integrationCatalogError) {
    form.append(
      errorLine(
        `Could not load the GitLab project list. ${state.integrationCatalogError} Existing approvals remain available so they are not removed accidentally.`,
      ),
    );
    const retry = button('Retry loading projects', loadIntegrationCatalog);
    retry.disabled = readOnly || state.integrationCatalogLoading;
    form.append(retry);
  } else if (
    currentBoard.connector_instance &&
    !state.integrationCatalogLoading &&
    !state.integrationCatalog.length
  ) {
    form.append(helpText('No GitLab projects are visible to the configured read connector.'));
  }
  form.append(
    helpText(
      'Every workspace member, including viewers and authorized machine readers, can see engineering metadata from these projects. Revoking a project or changing the instance removes its links and cached observations; cards and audit remain. No selected projects disables the integration.',
    ),
  );
  const consent = field(
    form,
    'consent',
    'I approve this metadata visibility and any removals',
    'yes',
    'checkbox',
  );
  consent.required = true;
  consent.parentElement.classList.add('consent');
  if (!currentBoard.connector_instance)
    form.append(
      helpText(
        'Ask the operator to set FLUX_GITLAB_URL and FLUX_GITLAB_SERVICE_TOKEN. Planning works without a connector.',
      ),
    );
  const error = errorLine();
  form.append(error);
  const actions = el('div', undefined, 'dialog-foot inline-maintenance-actions');
  const cancel = button('Cancel', () => {
    state.integrationFormOpen = false;
    state.integrationCatalogError = '';
    state.integrationCatalogLoading = false;
    state.integrationCatalogRequest++;
    hooks.render();
  });
  actions.append(cancel);
  let save;
  if (!readOnly) {
    save = button('Save changes', undefined, 'primary');
    save.type = 'submit';
    save.disabled = state.integrationCatalogLoading;
    actions.append(save);
  }
  form.append(actions);
  if (readOnly || state.integrationCatalogLoading) {
    form.querySelectorAll('input,select,textarea').forEach((input) => {
      input.disabled = true;
    });
    form.querySelectorAll('[data-multi-edit],[data-multi-remove]').forEach((input) => {
      input.disabled = true;
    });
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (readOnly || !save || state.busy || state.integrationCatalogLoading) return;
    const parts = new FormData(form).getAll('projects');
    try {
      if (parts.length > 100) throw new Error('Select at most 100 GitLab projects.');
      if (
        parts.some((value) => !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
      )
        throw new Error('Choose only positive numeric GitLab projects.');
      if (new Set(parts).size !== parts.length)
        throw new Error('A GitLab project may only be selected once.');
      state.integrationFormOpen = false;
      save.disabled = true;
      cancel.disabled = true;
      await change({
        revision: state.board.workspace.revision,
        kind: 'integration.save',
        integration: { instance: state.board.connector_instance, projects: parts.map(Number) },
      });
      state.integrationCatalogError = '';
      state.integrationCatalogLoading = false;
      state.integrationCatalogRequest++;
      hooks.render();
    } catch (submitError) {
      state.integrationFormOpen = true;
      setErrorText(
        error,
        `${submitError.message} Your input is retained. For a revision conflict, copy your changes, close, refresh, and reopen before retrying.`,
      );
      save.disabled = false;
      cancel.disabled = false;
      renderControls();
    }
  });
  return form;
}
