// Role checks and the write/admin buttons that honor them.
import { button } from './dom.js';
import { html, live, nodeOf, nothing } from './lit.js';
import { state } from './state.js';

// `access` marks a control renderControls keeps in step with permissions:
// 'write' ([data-write]), 'admin' ([data-admin-write]) or none. Such controls
// bind `disabled` with live(), because renderControls writes it too.
function writeDisabled(access) {
  if (access === 'write') return !writable() || state.integrationFormOpen;
  if (access === 'admin') return !adminWritable() || state.integrationFormOpen;
  return false;
}
export function actionIconTemplate(label, icon, fn, { className, access, disabled } = {}) {
  return html`<button
    type="button"
    class=${`action-icon${className ? ` ${className}` : ''}`}
    data-icon=${icon}
    data-action-label=${label}
    aria-label=${label}
    title=${label}
    data-write=${access === 'write' ? 'true' : nothing}
    data-admin-write=${access === 'admin' ? 'true' : nothing}
    ?disabled=${live(disabled ?? writeDisabled(access))}
    @click=${fn}
  ></button>`;
}
export function writeIconTemplate(label, icon, fn, className) {
  return actionIconTemplate(label, icon, fn, { className, access: 'write' });
}
export function adminIconTemplate(label, icon, fn, className) {
  return actionIconTemplate(label, icon, fn, { className, access: 'admin' });
}
// A text button for a write (`access` 'write') or admin ('admin') action.
// `tracked` false leaves it out of renderControls, as the node forms did for
// buttons inside cards and dialogs.
export function accessButtonTemplate(
  text,
  fn,
  { className, access = 'write', tracked = true } = {},
) {
  const mark = tracked ? access : undefined;
  return html`<button
    type="button"
    class=${className || nothing}
    data-write=${mark === 'write' ? 'true' : nothing}
    data-admin-write=${mark === 'admin' ? 'true' : nothing}
    ?disabled=${live(writeDisabled(access))}
    @click=${fn}
  >${text}</button>`;
}
export function actionIconButton(label, icon, fn, className) {
  return nodeOf(actionIconTemplate(label, icon, fn, { className }));
}
export function writeIconButton(label, icon, fn, className) {
  return nodeOf(writeIconTemplate(label, icon, fn, className));
}
export function adminIconButton(label, icon, fn, className) {
  return nodeOf(adminIconTemplate(label, icon, fn, className));
}
export function writable() {
  return state.board && state.board.role !== 'viewer' && !state.busy && !state.loading;
}
export function adminWritable() {
  return state.board && state.board.role === 'admin' && !state.busy && !state.loading;
}
export function gitLabWritable() {
  return (
    writable() &&
    !!state.board.connector_instance &&
    state.board.connector_instance === state.board.integration.instance &&
    !!state.board.integration.projects.length
  );
}
export function canComment() {
  return (
    state.board &&
    (state.board.role === 'member' || state.board.role === 'admin') &&
    !state.busy &&
    !state.loading
  );
}
export function writeButton(text, fn, className) {
  const b = button(text, fn, className);
  b.disabled = !writable() || state.integrationFormOpen;
  return b;
}
export function adminButton(text, fn, className) {
  const b = button(text, fn, className);
  b.dataset.adminWrite = 'true';
  b.disabled = !adminWritable() || state.integrationFormOpen;
  return b;
}
