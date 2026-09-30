// Presentation components receive domain actions as props; shared form state uses selectors.
import { html } from './vdom.js';
import { useLayoutEffect, useRef } from './vendor-preact.js';
import { setState, useStore } from './state.js';
import { useFocusRestore } from './ui-hooks.js';
import { useFocusRequest } from './focus-request.js';

/**
 * @param {{
 *   workspaces: Flux.Workspace[],
 *   choose: (id: string) => unknown,
 *   create: () => unknown,
 * }} props
 */
export function WorkspaceSelection({ workspaces, choose, create }) {
  const root = useRef(/** @type {HTMLDivElement | null} */ (null));
  const { onFocusCapture, onBlurCapture } = useFocusRestore(root, 'workspaces');
  useFocusRequest('workspaces', root);
  return html`
    <p class="help">Select the workspace you want to open. You can switch workspaces from the sidebar after entering one.</p>
    <div class="workspace-choice-list" role="list" ref=${root} onFocusCapture=${onFocusCapture} onBlurCapture=${onBlurCapture}>
      ${workspaces.map(
        (workspace) => html`
        <button key=${workspace.id} type="button" class="workspace-choice"
          data-workspace-choice=${workspace.id} data-focus-key=${`workspace:${workspace.id}`} aria-label=${`Open ${workspace.name}`}
          onClick=${() => choose(workspace.id)}>
          <span class="workspace-choice-copy"><strong>${workspace.name}</strong><small class="muted">${`${workspace.role} access`}</small></span>
          <span class="workspace-choice-action">Open →</span>
        </button>
      `,
      )}
    </div>
    <div class="actions workspace-gate-actions"><button type="button" class="primary" onClick=${create}>Create a workspace</button></div>
  `;
}

/**
 * @param {{
 *   name: string | undefined,
 *   hasWorkspaces: boolean,
 *   submit: (name: string) => unknown,
 *   back: () => unknown,
 * }} props
 */
export function WorkspaceCreation({ name, hasWorkspaces, submit, back }) {
  const input = useRef(/** @type {HTMLInputElement | null} */ (null));
  const draft = useStore((current) => current.workspaceCreateDraft);
  const busy = useStore((current) => current.workspaceCreating);
  const status = useStore((current) => current.workspaceCreateStatus);
  const error = useStore((current) => current.workspaceCreateStatusError);
  useLayoutEffect(() => input.current?.focus(), []);
  useLayoutEffect(() => {
    if (error) input.current?.focus();
  }, [error, status]);
  function onSubmit(/** @type {SubmitEvent} */ event) {
    event.preventDefault();
    if (!busy) submit(input.current?.value || '');
  }
  return html`
    <p class="help">${
      name
        ? `You are signed in as ${name}. Create a workspace to start planning; you will be its initial administrator.`
        : 'Create a workspace to start planning; your signed-in account will be its initial administrator.'
    }</p>
    <form class="workspace-create-form" onSubmit=${onSubmit}>
      <label>Workspace name<input ref=${input} id="workspace-name" name="name" type="text" required maxLength="120" autocomplete="organization" placeholder="e.g. Team Alpha" value=${draft} disabled=${busy} onInput=${(/** @type {Flux.TargetEvent<HTMLInputElement>} */ event) => setState({ workspaceCreateDraft: event.currentTarget.value })} /></label>
      <p class=${`workspace-create-status${error ? ' error' : ''}`} data-status-class="workspace-create-status" data-workspace-create-status="true" hidden=${!status} role=${error ? 'alert' : 'status'} aria-live=${error ? 'assertive' : 'polite'}>${status}</p>
      <div class="actions">
        <button type="submit" class="primary" disabled=${busy}>Create workspace</button>
        ${hasWorkspaces && html`<button type="button" disabled=${busy} onClick=${back}>Back to workspace selection</button>`}
      </div>
    </form>
  `;
}

/**
 * @param {{
 *   steps: { done: boolean, title: string, help: string, action: string, run: () => unknown }[],
 *   disabled: boolean,
 * }} props
 */
export function FirstRunChecklist({ steps, disabled }) {
  return html`
    <h2 id="first-run-heading">Set up your planning workspace</h2>
    <p class="help">Three steps get this workspace to a board your team can use. You can do them in any order.</p>
    <ol class="first-run-steps">
      ${steps.map(
        (step, index) => html`
        <li key=${step.title} class=${`first-run-step${step.done ? ' is-done' : ''}`}
          aria-label=${`${step.title} — ${step.done ? 'done' : 'not started'}`}>
          <span class="first-run-mark" aria-hidden="true">${step.done ? '✓' : String(index + 1)}</span>
          <div class="first-run-copy"><strong>${step.title}</strong><span class="help">${step.help}</span></div>
          <button type="button" class=${step.done ? undefined : 'primary'} disabled=${disabled}
            aria-label=${`${step.action}: ${step.title}`} onClick=${step.run}>${step.action}</button>
        </li>
      `,
      )}
    </ol>
  `;
}
