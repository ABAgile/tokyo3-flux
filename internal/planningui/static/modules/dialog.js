// The editor dialog: a native modal whose content is the dialog component the
// App's dialog map names, and the shared form layout every dialog uses.
import { html } from './vdom.js';
import { createContext, useContext, useLayoutEffect, useRef, useState } from './vendor-preact.js';
import { requestKey } from './api.js';
import { setState, state, useStore } from './state.js';
import { focusByKey } from './ui-hooks.js';
import { change } from './commands.js';
import { closeEditor, setEditorError } from './dialog-state.js';
import { setSharedItem } from './url-state.js';
import { AttachmentTooltip } from './tooltip.js';

// The open dialog record: { type, props, key, revision, returnFocusKey }.
const DialogContext = createContext(undefined);
function useDialog() {
  return useContext(DialogContext);
}

// A native <dialog> whose modal state follows `open`. Native Escape, backdrop
// clicks and closes are reported; the caller decides what they mean.
export function Modal({ id, labelledBy, open, onCancel, onBackdrop, onClosed, children }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  // A click on the dialog element itself lands on its backdrop or padding,
  // never on its content.
  const click = (event) => {
    if (event.target === ref.current) onBackdrop?.(event);
  };
  return html`<dialog
    id=${id}
    aria-labelledby=${labelledBy}
    ref=${ref}
    onCancel=${onCancel}
    onClick=${click}
    onClose=${onClosed}
  >${children}</dialog>`;
}

function selectEditorDialog(current) {
  return current.editorDialog;
}
// Hosts the open dialog. `dialogs` maps a dialog type to its component; a
// component's optional static `onClose(props)` runs when its dialog is closed
// rather than replaced by another.
export function EditorDialog({ dialogs }) {
  const record = useStore(selectEditorDialog);
  const Component = record ? dialogs[record.type] : undefined;
  const previous = useRef(record);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = record;
    if (!before || record) return;
    dialogs[before.type]?.onClose?.(before.props);
    focusByKey(before.returnFocusKey, { onlyIfLost: true });
    // A closed item editor is no longer a view of that card. Closing one dialog
    // to open another in the same task keeps the card in the URL.
    if (!state.detail && !state.editorDialog) {
      setState({ editorItemID: '' });
      setSharedItem('');
    }
  }, [record]);
  const cancel = (event) => {
    event.preventDefault();
    if (!state.busy) closeEditor();
  };
  const backdrop = () => {
    if (!state.busy) closeEditor();
  };
  const closed = (event) => {
    if (event.currentTarget.open || !state.editorDialog) return;
    setState({ editorDialog: undefined, editorError: '' });
  };
  return html`<${Modal}
    id="editor"
    labelledBy="editor-title"
    open=${!!Component}
    onCancel=${cancel}
    onBackdrop=${backdrop}
    onClosed=${closed}
  >
    ${
      Component
        ? html`<${DialogContext.Provider} value=${record}
            ><${Component} key=${record.key} ...${record.props}
          /></${DialogContext.Provider}>`
        : null
    }
    <${AttachmentTooltip} inDialog=${true} />
  </${Modal}>`;
}

function selectBusy(current) {
  return current.busy;
}
function selectEditorError(current) {
  return current.editorError;
}
// The one dialog layout. `onSubmit(data, form)` receives the native form data;
// a thrown error is shown on the form's error line and the input is retained.
export function FormDialog({
  title,
  titleExtra = null,
  titleBadge = null,
  saveText = 'Save changes',
  readOnly = false,
  hideSave = false,
  className,
  footerAction = null,
  onSubmit,
  onInput,
  formRef,
  children,
}) {
  const busy = useStore(selectBusy);
  const error = useStore(selectEditorError);
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const disabled = saving || busy;
  async function submit(event) {
    event.preventDefault();
    if (readOnly || state.busy || submitting.current || !onSubmit) return;
    const form = event.currentTarget;
    setEditorError('');
    submitting.current = true;
    setSaving(true);
    try {
      await onSubmit(new FormData(form), form);
    } catch (submitError) {
      setEditorError(submitError.message);
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  const dismiss = () => {
    if (!state.busy) closeEditor();
  };
  return html`<form
    id="editor-form"
    class=${className || null}
    ref=${formRef}
    onSubmit=${submit}
    onInput=${onInput}
    onChange=${onInput}
  >
    <div class="dialog-head">
      <div id="editor-title-group">
        <h2 id="editor-title">${title}</h2>
        <div id="editor-title-extra">${titleExtra}</div>
      </div>
      <div id="editor-title-badge">${titleBadge}</div>
      <button type="button" id="dismiss" aria-label="Close editor" disabled=${disabled} onClick=${dismiss}>×</button>
    </div>
    <div id="fields">${children}</div>
    <p id="form-error" role="alert" hidden=${!error}>${error}</p>
    <div class="dialog-foot">
      <span id="editor-footer-actions">${footerAction}</span>
      <button type="button" id="cancel" disabled=${disabled} onClick=${dismiss}>Cancel</button>
      <button type="submit" class="primary" id="save" hidden=${hideSave || readOnly} disabled=${disabled}>${saveText}</button>
    </div>
  </form>`;
}

// A dialog that saves one revision-checked planning command. `command(data)`
// builds it from the form; the dialog's opening revision is presented, and a
// retried save of the same command reuses its idempotency key.
export function CommandDialog({ command, afterSave, ...props }) {
  const dialog = useDialog();
  const pending = useRef({ serialized: undefined, key: undefined });
  async function onSubmit(data) {
    try {
      const full = { revision: dialog?.revision, ...command(data) };
      const serialized = JSON.stringify(full);
      if (pending.current.serialized !== serialized)
        pending.current = { serialized, key: requestKey() };
      await change(full, pending.current.key);
      if (afterSave) await afterSave(full);
      closeEditor();
    } catch (error) {
      setEditorError(
        `${error.message} Your input is retained. For a revision conflict, copy your changes, close, refresh, and reopen before retrying.`,
      );
    }
  }
  return html`<${FormDialog} ...${props} onSubmit=${onSubmit} />`;
}
