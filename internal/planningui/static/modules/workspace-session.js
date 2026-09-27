// One AbortController per workspace session. Work that belongs to a workspace
// but outlives the component that started it — card-drop uploads, board and
// page loads, polls, link attachment after the editor closed — takes this
// signal, so leaving the workspace cancels all of it in one place.
let controller = new AbortController();

export function workspaceSignal() {
  return controller.signal;
}
// Called whenever the workspace root changes: the previous session's work is
// aborted and later work belongs to the new one.
export function beginWorkspaceSession() {
  controller.abort();
  controller = new AbortController();
  return controller.signal;
}
// Work owned by both a caller and the workspace session stops when either ends.
export function withWorkspace(signal) {
  return signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
}
