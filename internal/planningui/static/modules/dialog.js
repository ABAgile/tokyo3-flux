// The shared editor dialog used by every create/edit flow.
import { $ } from './dom.js';
import { mount } from './lit.js';
import { requestKey } from './api.js';
import { state } from './state.js';
import { change } from './commands.js';
import { hideAttachmentTooltip } from './item-attachments.js';

export function closeEditor() {
  if (state.busy) return;
  const returnTo = state.editorReturn;
  state.editorReturn = undefined;
  hideAttachmentTooltip();
  $('editor').close();
  restoreEditorFocus();
  if (returnTo) returnTo();
}
// The dialog returns focus to its opener, but a board update while it was open
// can rebuild that control; focus the rebuilt control with the same focus key.
// closeEditor calls this at once, and the dialog's close event covers the paths
// that close it directly.
export function restoreEditorFocus() {
  const opener = state.editorOpener;
  state.editorOpener = undefined;
  const key = opener?.isConnected === false ? opener.dataset?.focusKey : '';
  // Focus is still on the closed dialog's control, or already on the body.
  const active = document.activeElement;
  if (key && (active === document.body || $('editor').contains(active)))
    document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus();
}
export function openEditor(title, build, submit, readOnly = false, afterSave, afterClose) {
  state.editorReturn = afterClose;
  state.editorOpener = document.activeElement;
  $('editor-title').textContent = title;
  $('editor-form')
    .querySelectorAll('.dialog-head .badge-due[data-due-date-badge]')
    .forEach((e) => e.remove());
  $('editor-form').classList.toggle(
    'item-editor-form',
    ['Work item', 'Create work item'].includes(title),
  );
  $('editor-form')
    .querySelectorAll('[data-item-footer]')
    .forEach((e) => e.remove());
  $('form-error').textContent = '';
  $('save').textContent = 'Save changes';
  $('save').hidden = readOnly;
  $('save').disabled = false;
  const revision = state.board.workspace.revision;
  let pending, key;
  // A builder returns the dialog's template, or renders into the fields itself
  // (the item editor) and returns nothing.
  $('fields').replaceChildren();
  const content = build($('fields'));
  if (content !== undefined) mount($('fields'), content);
  if (readOnly) {
    $('fields')
      .querySelectorAll(
        'input:not([data-comment-control]),textarea:not([data-comment-control]),select:not([data-comment-control])',
      )
      .forEach((e) => {
        e.disabled = true;
      });
    $('fields')
      .querySelectorAll('[data-multi-edit],[data-multi-remove]')
      .forEach((e) => {
        e.disabled = true;
      });
  }
  $('editor-form').onsubmit = async (e) => {
    e.preventDefault();
    if (readOnly || state.busy) return;
    $('form-error').textContent = '';
    $('save').disabled = true;
    $('cancel').disabled = true;
    $('dismiss').disabled = true;
    try {
      const command = { revision, ...submit(new FormData($('editor-form'))) };
      const serialized = JSON.stringify(command);
      if (pending !== serialized) {
        key = requestKey();
        pending = serialized;
      }
      await change(command, key);
      if (afterSave) await afterSave(command);
      closeEditor();
    } catch (err) {
      $('form-error').textContent =
        `${err.message} Your input is retained. For a revision conflict, copy your changes, close, refresh, and reopen before retrying.`;
    } finally {
      $('save').disabled = false;
      $('cancel').disabled = false;
      $('dismiss').disabled = false;
    }
  };
  $('editor').showModal();
}
