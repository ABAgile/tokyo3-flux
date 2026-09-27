// The GitLab integration form on the Projects page.
import { errorLineTemplate, fieldTemplate, helpTextTemplate } from './layout.js';
import { html } from './vdom.js';
import { useEffect, useRef } from './vendor-preact.js';
import { setState, state, useStore } from './state.js';
import { notice } from './notices.js';
import { MultiSelect } from './multi-select.js';
import { integrationProjectEntries } from './gitlab-catalog.js';
import { change } from './commands.js';

export function editIntegration() {
  if (!state.board || state.busy || state.loading || state.integrationFormOpen) return;
  setState({
    integrationFormOpen: true,
    integrationDraft: state.board.integration.projects.map(String),
    integrationConsent: false,
    integrationSubmitting: false,
    integrationFormError: '',
  });
}
function cancelIntegration() {
  setState({
    integrationFormOpen: false,
    integrationDraft: undefined,
    integrationConsent: false,
    integrationSubmitting: false,
    integrationFormError: '',
  });
}
async function submitIntegration(event, readOnly, loading) {
  event.preventDefault();
  const form = event.currentTarget;
  if (readOnly || state.busy || loading || state.integrationSubmitting) return;
  const parts = new FormData(form).getAll('projects');
  try {
    if (parts.length > 100) throw new Error('Select at most 100 GitLab projects.');
    if (parts.some((value) => !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))))
      throw new Error('Choose only positive numeric GitLab projects.');
    if (new Set(parts).size !== parts.length)
      throw new Error('A GitLab project may only be selected once.');
    setState({ integrationFormOpen: false, integrationSubmitting: true, integrationFormError: '' });
    await change({
      revision: state.board.workspace.revision,
      kind: 'integration.save',
      integration: { instance: state.board.connector_instance, projects: parts.map(Number) },
    });
    setState({ integrationDraft: undefined, integrationConsent: false });
  } catch (submitError) {
    setState({
      integrationFormOpen: true,
      integrationFormError: `${submitError.message} Your input is retained. For a revision conflict, copy your changes, close, refresh, and reopen before retrying.`,
    });
  } finally {
    setState({ integrationSubmitting: false });
  }
}
function selectIntegrationForm(current) {
  return current.integrationSubmitting + '\u0000' + current.integrationFormError;
}
// The form's selections and consent live in the store, so a failed save
// reopens it intact. The catalog is owned by the Projects page request.
export function IntegrationForm({ board, catalog, loading, error, onRetry }) {
  useStore(selectIntegrationForm);
  const readOnly = board.role !== 'admin';
  const selected = state.integrationDraft ?? board.integration.projects.map(String);
  const disabled = readOnly || loading || state.integrationSubmitting;
  // The status line announces the catalog load and clears only its own text.
  const announced = useRef(false);
  useEffect(() => {
    if (loading) {
      announced.current = true;
      notice('Loading available GitLab projects…');
    } else if (announced.current) {
      announced.current = false;
      notice('');
    }
  }, [loading]);
  const catalogNote = error
    ? html`${errorLineTemplate(
        `Could not load the GitLab project list. ${error} Existing approvals remain available so they are not removed accidentally.`,
      )}<button type="button" disabled=${disabled} onClick=${onRetry}
          >Retry loading projects</button
        >`
    : board.connector_instance && !loading && !catalog.length
      ? helpTextTemplate('No GitLab projects are visible to the configured read connector.')
      : null;
  return html`<form
    class="inline-maintenance-form"
    onSubmit=${(event) => submitIntegration(event, readOnly, loading)}
  >
    ${helpTextTemplate(`Operator-configured instance: ${board.connector_instance || 'Not configured'}`)}
    ${helpTextTemplate(`Existing approval: ${board.integration.instance || 'None'}`)}
    <${MultiSelect}
      name="projects"
      title="Approved GitLab projects"
      entries=${integrationProjectEntries(catalog, selected)}
      defaultValue=${selected}
      helpText="Choose projects visible to the configured server-side read connector. The selected projects and their engineering metadata are shared with every workspace reader."
      disabled=${disabled}
      onChange=${(values) => setState({ integrationDraft: values })}
    />
    ${loading ? helpTextTemplate('Loading available GitLab projects…') : null}
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
      {
        required: true,
        className: 'consent',
        disabled,
        defaultChecked: state.integrationConsent,
        onChange: (event) => setState({ integrationConsent: event.currentTarget.checked }),
      },
    )}
    ${
      board.connector_instance
        ? null
        : helpTextTemplate(
            'Ask the operator to set FLUX_GITLAB_URL and FLUX_GITLAB_SERVICE_TOKEN. Planning works without a connector.',
          )
    }
    ${errorLineTemplate(state.integrationFormError)}
    <div class="dialog-foot inline-maintenance-actions">
      <button type="button" data-integration-cancel disabled=${state.integrationSubmitting} onClick=${cancelIntegration}>Cancel</button>
      ${
        readOnly
          ? null
          : html`<button type="submit" class="primary" disabled=${disabled}>Save changes</button>`
      }
    </div>
  </form>`;
}
