// Presentation components: all domain state and actions arrive as props.
import { html, useLayoutEffect, useRef } from './preact.js';

export function WorkspaceSelection({ workspaces, choose, create }) {
  return html`
    <p class="help">Select the workspace you want to open. You can switch workspaces from the sidebar after entering one.</p>
    <div class="workspace-choice-list" role="list">
      ${workspaces.map(
        (workspace) => html`
        <button key=${workspace.id} type="button" class="workspace-choice"
          data-workspace-choice=${workspace.id} aria-label=${`Open ${workspace.name}`}
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

export function WorkspaceCreation({ name, hasWorkspaces, submit, back }) {
  const input = useRef();
  useLayoutEffect(() => input.current.focus(), []);
  // Submission currently owns the input's value/disabled state and the status
  // line's contents. Do not bind those properties until that controller moves
  // into this component; this keeps one writer per property during migration.
  return html`
    <p class="help">${
      name
        ? `You are signed in as ${name}. Create a workspace to start planning; you will be its initial administrator.`
        : 'Create a workspace to start planning; your signed-in account will be its initial administrator.'
    }</p>
    <form class="workspace-create-form" onSubmit=${submit}>
      <label>Workspace name<input ref=${input} id="workspace-name" name="name" type="text" required maxLength="120" autocomplete="organization" placeholder="e.g. Team Alpha" /></label>
      <p class="workspace-create-status" data-status-class="workspace-create-status" data-workspace-create-status="true" hidden role="status" aria-live="polite"></p>
      <div class="actions">
        <button type="submit" class="primary">Create workspace</button>
        ${hasWorkspaces && html`<button type="button" onClick=${back}>Back to workspace selection</button>`}
      </div>
    </form>
  `;
}

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
