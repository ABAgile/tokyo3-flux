// The shared Preact editor dialog used by every create/edit flow.
import { $ } from './dom.js';
import { html, useMemo, unmountIsland, useLayoutEffect, useRef, useState } from './preact.js';
import { requestKey } from './api.js';
import { state, setState } from './state.js';
import { change } from './commands.js';
import { hideAttachmentTooltip } from './item-attachments.js';
import { hooks } from './hooks.js';

function clearEditorTitleExtras() {
  for (const id of ['editor-title-extra', 'editor-title-badge']) {
    const host = $(id);
    unmountIsland(host);
    host.replaceChildren();
  }
}
function disposeEditorContent() {
  unmountIsland($('editor-title'));
  clearEditorTitleExtras();
}
function closeAfterNativeEvent(config, dialog) {
  if (dialog.open || (state.editorDialog && state.editorDialog !== config)) return;
  restoreEditorFocus();
  setTimeout(() => {
    if (dialog.open || (state.editorDialog && state.editorDialog !== config)) return;
    if (state.editorDialog === config)
      setState({ editorDialog: undefined, editorSaveText: 'Save changes', editorError: '' });
    if (state.detailState) return;
    state.editorItemID = '';
    hooks.setSharedItem?.('');
  }, 0);
}

export function EditorDialog({ config, busy, saveText, errorText }) {
  const dialogRef = useRef(null);
  const formRef = useRef(null);
  const pending = useRef({ serialized: undefined, key: undefined });
  const [saving, setSaving] = useState(false);
  // Editor fields are an uncontrolled snapshot; builders return VNodes without DOM side effects.
  const content = useMemo(() => config?.build?.(), [config]);
  const disabled = saving || busy;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const form = formRef.current;
    if (!config || !dialog || !form) return;
    pending.current = { serialized: undefined, key: undefined };
    unmountIsland(form.querySelector('#editor-title'));
    clearEditorTitleExtras();
    form.querySelectorAll('[data-item-footer]').forEach((node) => {
      node.remove();
    });
    form.classList.toggle(
      'item-editor-form',
      ['Work item', 'Create work item'].includes(config.title),
    );
    config.onOpen?.(form);
    setSaving(false);
    if (!dialog.open) dialog.showModal();
    return () => disposeEditorContent();
  }, [config]);

  async function submit(event) {
    event.preventDefault();
    if (!config || config.readOnly || state.busy) return;
    setState({ editorError: '' });
    const form = formRef.current;
    if (config.onSubmit) {
      try {
        await config.onSubmit(new FormData(form), {
          close: closeEditor,
          setError: setEditorError,
          form,
        });
      } catch (error) {
        setEditorError(error.message);
      }
      return;
    }
    setSaving(true);
    try {
      const command = { revision: config.revision, ...config.submit(new FormData(form)) };
      const serialized = JSON.stringify(command);
      if (pending.current.serialized !== serialized) {
        pending.current = { serialized, key: requestKey() };
      }
      await change(command, pending.current.key);
      if (config.afterSave) await config.afterSave(command);
      closeEditor();
    } catch (error) {
      setEditorError(
        `${error.message} Your input is retained. For a revision conflict, copy your changes, close, refresh, and reopen before retrying.`,
      );
    } finally {
      setSaving(false);
    }
  }

  function dismiss() {
    if (!state.busy) closeEditor();
  }
  function cancel(event) {
    event.preventDefault();
    if (event.target === dialogRef.current && !state.busy) closeEditor();
  }
  function backdrop(event) {
    if (!state.busy && event.target === dialogRef.current) closeEditor();
  }
  function closed() {
    closeAfterNativeEvent(config, dialogRef.current);
  }

  return html`<dialog
    id="editor"
    aria-labelledby="editor-title"
    ref=${dialogRef}
    onCancel=${cancel}
    onClick=${backdrop}
    onClose=${closed}
  >
    <form id="editor-form" ref=${formRef} onSubmit=${submit}>
      <div class="dialog-head">
        <div id="editor-title-group">
          <h2 id="editor-title">${config?.title || 'Work item'}</h2>
          <div id="editor-title-extra"></div>
        </div>
        <div id="editor-title-badge"></div>
        <button type="button" id="dismiss" aria-label="Close editor" disabled=${disabled} onClick=${dismiss}>×</button>
      </div>
      <div id="fields">${content}</div>
      <p id="form-error" role="alert" hidden=${!errorText}>${errorText}</p>
      <div class="dialog-foot">
        <span id="editor-footer-actions"></span>
        <button type="button" id="cancel" disabled=${disabled} onClick=${dismiss}>Cancel</button>
        <button type="submit" class="primary" id="save" hidden=${!config || config.hideSave || config.readOnly} disabled=${disabled}>
          ${saveText || config?.saveText || 'Save changes'}
        </button>
      </div>
    </form>
  </dialog>`;
}

export function closeEditor() {
  if (state.busy) return;
  const returnTo = state.editorReturn;
  state.editorReturn = undefined;
  hideAttachmentTooltip();
  const dialog = $('editor');
  if (dialog.open) dialog.close();
  setState({ editorDialog: undefined, editorSaveText: 'Save changes', editorError: '' });
  restoreEditorFocus();
  if (returnTo) returnTo();
}
// Return focus to the opener, or to the rebuilt control with the same logical key.
export function restoreEditorFocus() {
  const opener = state.editorOpener;
  state.editorOpener = undefined;
  const key = opener?.isConnected === false ? opener.dataset?.focusKey : '';
  const active = document.activeElement;
  if (key && (active === document.body || $('editor').contains(active)))
    document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus();
}
export function setEditorError(text) {
  setState({ editorError: String(text || '') });
}
export function setEditorSaveText(text) {
  if (state.editorDialog) setState({ editorSaveText: String(text || '') });
}
export function openEditor(
  title,
  build,
  submit,
  readOnly = false,
  afterSave,
  afterClose,
  options = {},
) {
  state.editorReturn = afterClose;
  if (!$('editor').open) state.editorOpener = document.activeElement;
  const config = {
    title,
    build,
    submit,
    readOnly,
    afterSave,
    onSubmit: options.onSubmit,
    onOpen: options.onOpen,
    hideSave: !!options.hideSave,
    saveText: options.saveText,
    revision: state.board.workspace.revision,
  };
  setState({
    editorDialog: config,
    editorSaveText: options.saveText || 'Save changes',
    editorError: '',
  });
}
export function openFormDialog(title, saveText, build, onSubmit, options = {}) {
  openEditor(title, build, undefined, false, undefined, undefined, {
    ...options,
    saveText,
    onSubmit,
  });
}
