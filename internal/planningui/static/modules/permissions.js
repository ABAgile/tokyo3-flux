// Role checks and the write/admin buttons that honor them.
import { button } from './dom.js';
import { state } from './state.js';

export function actionIconButton(label, icon, fn, className) {
  const b = button('', fn, `action-icon${className ? ` ${className}` : ''}`);
  b.dataset.icon = icon;
  b.dataset.actionLabel = label;
  b.setAttribute('aria-label', label);
  b.title = label;
  return b;
}
export function writeIconButton(label, icon, fn, className) {
  const b = actionIconButton(label, icon, fn, className);
  b.dataset.write = 'true';
  b.disabled = !writable() || state.integrationFormOpen;
  return b;
}
export function adminIconButton(label, icon, fn, className) {
  const b = actionIconButton(label, icon, fn, className);
  b.dataset.adminWrite = 'true';
  b.disabled = !adminWritable() || state.integrationFormOpen;
  return b;
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
