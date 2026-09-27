// Status line, error bar, the planning-change notice and the undo offer.
import { Fragment } from './vendor-preact.js';
import { html, shallowEqual } from './vdom.js';
import { state, setState, useStore } from './state.js';

export function StatusBars({ refresh }) {
  const {
    noticeText,
    errorText,
    planningChangeNotice,
    planningChangeText,
    busy,
    loading,
    integrationFormOpen,
  } = useStore(
    (current) => ({
      noticeText: current.noticeText,
      errorText: current.errorText,
      planningChangeNotice: current.planningChangeNotice,
      planningChangeText: current.planningChangeText,
      busy: current.busy,
      loading: current.loading,
      integrationFormOpen: current.integrationFormOpen,
    }),
    shallowEqual,
  );
  return html`<${Fragment}>
    <p id="notice" role="status" aria-live="polite">${noticeText}</p>
    <div id="error-bar" class="notice-bar notice-bar-danger" hidden=${!errorText} role="alert">
      <span id="error-text">${errorText}</span>
      <button type="button" id="error-dismiss" aria-label="Dismiss error" onClick=${clearError}>Dismiss</button>
    </div>
    <div
      id="planning-change"
      class="notice-bar notice-bar-warning"
      hidden=${!planningChangeNotice}
      role="status"
      aria-live="polite"
    >
      <span id="planning-change-text">${planningChangeText}</span>
      <button
        type="button"
        id="planning-refresh"
        disabled=${busy || loading || integrationFormOpen}
        onClick=${refresh}
      >Refresh</button>
    </div>
  </${Fragment}>`;
}

// Transient progress and errors are separate surfaces. Preact retains the live
// regions and changes their text only when a new announcement is made.
export function notice(text, error = false) {
  if (error) showError(text);
  else setStatus(text);
}
function setStatus(text) {
  const value = String(text || '');
  if (value !== state.noticeText) setState({ noticeText: value });
}
function showError(text) {
  const value = String(text || '');
  if (value !== state.errorText) setState({ errorText: value });
}
export function clearError() {
  if (state.errorText) setState({ errorText: '' });
}
export function showPlanningChangeNotice(text = 'Planning changed elsewhere · Refresh to review') {
  if (state.planningChangeNotice && state.planningChangeText === text) return;
  setState({ planningChangeNotice: true, planningChangeText: text });
}
export function clearPlanningChangeNotice() {
  if (state.planningChangeNotice) setState({ planningChangeNotice: false });
}
// An undo offer expires after UNDO_TTL. The timer is transient browser state,
// so it stays in this module rather than in the store.
export const UNDO_TTL = 10000;
let undoTimer;
export function clearUndo() {
  clearTimeout(undoTimer);
  undoTimer = undefined;
  setState({ undoOffer: undefined, undoText: '' });
}
export function offerUndo(text, commands) {
  const list = (Array.isArray(commands) ? commands : [commands]).filter(Boolean);
  clearUndo();
  if (!list.length) return;
  setState({ undoOffer: list, undoText: text });
  undoTimer = setTimeout(clearUndo, UNDO_TTL);
}
