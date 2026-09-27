// Role checks as state selectors, and the write/admin buttons that honor them.
import { html, shallowEqual } from './vdom.js';
import { state, useStore } from './state.js';

export function canWrite(current) {
  return !!current.board && current.board.role !== 'viewer' && !current.busy && !current.loading;
}
function canAdmin(current) {
  return !!current.board && current.board.role === 'admin' && !current.busy && !current.loading;
}
function canUseGitLab(current) {
  return (
    canWrite(current) &&
    !!current.board.connector_instance &&
    current.board.connector_instance === current.board.integration.instance &&
    !!current.board.integration.projects.length
  );
}
function canCommentIn(current) {
  return (
    !!current.board &&
    (current.board.role === 'member' || current.board.role === 'admin') &&
    !current.busy &&
    !current.loading
  );
}
// Controllers check the state at the time of the event.
export function writable() {
  return canWrite(state);
}
export function adminWritable() {
  return canAdmin(state);
}
export function gitLabWritable() {
  return canUseGitLab(state);
}
export function canComment() {
  return canCommentIn(state);
}

function selectPermissions(current) {
  const blocked = current.integrationFormOpen;
  return {
    role: current.board?.role,
    busy: current.busy || current.loading,
    write: canWrite(current),
    admin: canAdmin(current),
    gitlab: canUseGitLab(current),
    comment: canCommentIn(current),
    // Write and admin controls also wait while the integration form is open.
    writeDisabled: !canWrite(current) || blocked,
    adminDisabled: !canAdmin(current) || blocked,
  };
}
export function usePermissions() {
  return useStore(selectPermissions, shallowEqual);
}
function accessDisabled(access, permissions) {
  if (access === 'write') return permissions.writeDisabled;
  if (access === 'admin') return permissions.adminDisabled;
  return false;
}

// `access` marks write ('write') or admin ('admin') controls; their disabled
// state follows the current permissions and busy state.
function ActionIcon({ label, icon, onClick, className, access, disabled }) {
  const permissions = usePermissions();
  return html`<button
    type="button"
    class=${`action-icon${className ? ` ${className}` : ''}`}
    data-icon=${icon}
    data-action-label=${label}
    aria-label=${label}
    title=${label}
    data-write=${access === 'write' ? 'true' : null}
    data-admin-write=${access === 'admin' ? 'true' : null}
    disabled=${disabled ?? accessDisabled(access, permissions)}
    onClick=${onClick}
  ></button>`;
}
/**
 * @param {string} label
 * @param {string} icon
 * @param {() => void} onClick
 * @param {{ className?: string, access?: 'write' | 'admin', disabled?: boolean }} [options]
 */
export function actionIconTemplate(label, icon, onClick, { className, access, disabled } = {}) {
  return html`<${ActionIcon}
    label=${label}
    icon=${icon}
    onClick=${onClick}
    className=${className}
    access=${access}
    disabled=${disabled}
  />`;
}
export function writeIconTemplate(label, icon, onClick, className) {
  return actionIconTemplate(label, icon, onClick, { className, access: 'write' });
}
export function adminIconTemplate(label, icon, onClick, className) {
  return actionIconTemplate(label, icon, onClick, { className, access: 'admin' });
}
// A text button for a write ('write') or admin ('admin') action. `tracked`
// false omits the data-write marker for buttons inside dialogs and cards.
function AccessButton({ text, onClick, className, access = 'write', tracked = true, label }) {
  const permissions = usePermissions();
  const mark = tracked ? access : undefined;
  return html`<button
    type="button"
    class=${className || null}
    aria-label=${label || null}
    data-write=${mark === 'write' ? 'true' : null}
    data-admin-write=${mark === 'admin' ? 'true' : null}
    disabled=${accessDisabled(access, permissions)}
    onClick=${onClick}
  >${text}</button>`;
}
export function accessButtonTemplate(text, onClick, options = {}) {
  return html`<${AccessButton} text=${text} onClick=${onClick} ...${options} />`;
}
