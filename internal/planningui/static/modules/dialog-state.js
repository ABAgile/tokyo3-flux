// Editor dialog state. A dialog is data — `{ type, props }` — looked up in the
// App's dialog map; opening a dialog replaces the current one.
import { requestKey } from './api.js';
import { setState, state } from './state.js';

export function isEditorOpen(current = state) {
  return !!current.editorDialog;
}
// Dialogs are snapshots: `props` are captured when the dialog opens, and write
// commands present the workspace revision it was opened at.
/**
 * @template {Flux.DialogType} T
 * @param {T} type
 * @param {Flux.DialogProps[T]} props
 */
export function openDialog(type, props) {
  const current = state.editorDialog;
  // The control that opened the first dialog gets focus back when the dialog
  // closes, by logical key if the original element was re-rendered meanwhile.
  const opener = /** @type {HTMLElement | null | undefined} */ (
    document.activeElement?.closest?.('[data-focus-key]')
  );
  setState({
    editorDialog: {
      type,
      props,
      key: requestKey(),
      revision: state.board?.workspace.revision,
      returnFocusKey: current ? current.returnFocusKey : opener?.dataset.focusKey || '',
    },
    editorError: '',
  });
}
export function closeEditor() {
  if (state.busy || !state.editorDialog) return;
  setState({ editorDialog: undefined, editorError: '' });
}
export function setEditorError(text) {
  setState({ editorError: String(text || '') });
}
