// The GitLab integration form on the Projects page.
import { errorLineTemplate, fieldTemplate, helpTextTemplate, setErrorText } from './layout.js';
import { html, nothing } from './lit.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { notice } from './notices.js';
import { renderControls } from './controls.js';
import { multiSelectTemplate } from './multi-select.js';
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
function cancelIntegration() {
  state.integrationFormOpen = false;
  state.integrationCatalogError = '';
  state.integrationCatalogLoading = false;
  state.integrationCatalogRequest++;
  hooks.render();
}
async function submitIntegration(event, readOnly) {
  event.preventDefault();
  const form = event.currentTarget;
  const save = form.querySelector('[type="submit"]');
  const cancel = form.querySelector('[data-integration-cancel]');
  const error = form.querySelector('[data-integration-error]');
  if (readOnly || !save || state.busy || state.integrationCatalogLoading) return;
  const parts = new FormData(form).getAll('projects');
  try {
    if (parts.length > 100) throw new Error('Select at most 100 GitLab projects.');
    if (parts.some((value) => !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))))
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
}
// The form is rendered when it opens or its catalog changes (the Projects page
// keys it on those inputs). While it is shown, the error line and the
// disabled state of its buttons during a save belong to submitIntegration.
export function integrationFormTemplate() {
  const currentBoard = state.board;
  const readOnly = currentBoard.role !== 'admin';
  const loading = state.integrationCatalogLoading;
  const selected = currentBoard.integration.projects.map(String);
  const disabled = readOnly || loading;
  const catalogNote = state.integrationCatalogError
    ? html`${errorLineTemplate(
        `Could not load the GitLab project list. ${state.integrationCatalogError} Existing approvals remain available so they are not removed accidentally.`,
      )}<button type="button" ?disabled=${disabled} @click=${loadIntegrationCatalog}
          >Retry loading projects</button
        >`
    : currentBoard.connector_instance && !loading && !state.integrationCatalog.length
      ? helpTextTemplate('No GitLab projects are visible to the configured read connector.')
      : nothing;
  return html`<form
    class="inline-maintenance-form"
    @submit=${(event) => submitIntegration(event, readOnly)}
  >
    ${helpTextTemplate(
      `Operator-configured instance: ${currentBoard.connector_instance || 'Not configured'}`,
    )}
    ${helpTextTemplate(`Existing approval: ${currentBoard.integration.instance || 'None'}`)}
    ${multiSelectTemplate(
      'projects',
      'Approved GitLab projects',
      integrationProjectEntries(state.integrationCatalog, selected),
      selected,
      undefined,
      'Choose projects visible to the configured server-side read connector. The selected projects and their engineering metadata are shared with every workspace reader.',
      { disabled },
    )}
    ${loading ? helpTextTemplate('Loading available GitLab projects…') : nothing}
    ${catalogNote}
    ${helpTextTemplate(
      'Every workspace member, including viewers and authorized machine readers, can see engineering metadata from these projects. Revoking a project or changing the instance removes its links and cached observations; cards and audit remain. No selected projects disables the integration.',
    )}
    ${fieldTemplate(
      'consent',
      'I approve this metadata visibility and any removals',
      'yes',
      'checkbox',
      undefined,
      { required: true, className: 'consent', disabled },
    )}
    ${
      currentBoard.connector_instance
        ? nothing
        : helpTextTemplate(
            'Ask the operator to set FLUX_GITLAB_URL and FLUX_GITLAB_SERVICE_TOKEN. Planning works without a connector.',
          )
    }
    <p class="error" role="alert" hidden data-integration-error></p>
    <div class="dialog-foot inline-maintenance-actions">
      <button type="button" data-integration-cancel @click=${cancelIntegration}>Cancel</button>
      ${
        readOnly
          ? nothing
          : html`<button type="submit" class="primary" ?disabled=${loading}>Save changes</button>`
      }
    </div>
  </form>`;
}
