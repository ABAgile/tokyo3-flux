// Status line, error bar and the "planning changed elsewhere" notice.
import { $ } from './dom.js';
import { state } from './state.js';

// Transient progress and errors are separate surfaces. `#notice` is a polite
// status line that is only written when its text actually changes, so screen
// readers are not re-announced on every render pass. Errors persist in their
// own assertive bar until dismissed or until a later success clears them.
export function notice(text, error = false) {
  if (error) showError(text);
  else setStatus(text);
}
function setStatus(text) {
  const value = String(text || '');
  if (value === state.noticeText) return;
  state.noticeText = value;
  $('notice').textContent = value;
}
function showError(text) {
  const value = String(text || '');
  if (value === state.errorText && !$('error-bar').hidden) return;
  state.errorText = value;
  $('error-text').textContent = value;
  $('error-bar').hidden = !value;
}
export function clearError() {
  if (!state.errorText && $('error-bar').hidden) return;
  state.errorText = '';
  $('error-text').textContent = '';
  $('error-bar').hidden = true;
}
export function showPlanningChangeNotice(text = 'Planning changed elsewhere · Refresh to review') {
  const banner = $('planning-change');
  if (
    state.planningChangeNotice &&
    !banner.hidden &&
    $('planning-change-text').textContent === text
  )
    return;
  state.planningChangeNotice = true;
  $('planning-change-text').textContent = text;
  banner.hidden = false;
}
export function clearPlanningChangeNotice() {
  state.planningChangeNotice = false;
  $('planning-change').hidden = true;
}
