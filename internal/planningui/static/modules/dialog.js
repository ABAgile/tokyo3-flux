// The editor dialog: a native modal whose content is the dialog component the
// App's dialog map names, and the shared form layout every dialog uses.
import { html } from './vdom.js';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  h,
} from './vendor-preact.js';
import { errorMessage, requestKey } from './api.js';
import { setState, state, useStore } from './state.js';
import { focusKey } from './ui-hooks.js';
import { clearFocusRequest } from './focus-request.js';
import { change } from './commands.js';
import { closeEditor, setEditorError } from './dialog-state.js';
import { setSharedItem } from './url-state.js';
import { AttachmentTooltip } from './tooltip.js';
import { ErrorBoundary } from './error-boundary.js';

// The open dialog record: { type, props, key, revision, returnFocusKey }.
const DialogContext = createContext(/** @type {Flux.DialogRecord | undefined} */ (undefined));
function useDialog() {
  return useContext(DialogContext);
}

// A native <dialog> whose modal state follows `open`. Native Escape, backdrop
// clicks and closes are reported; the caller decides what they mean.
/**
 * @param {{
 *   id: string,
 *   labelledBy: string,
 *   open: boolean,
 *   onCancel?: (event: Event) => void,
 *   onBackdrop?: (event: MouseEvent) => void,
 *   onClosed?: (event: Event) => void,
 *   children?: unknown,
 * }} props
 */
export function Modal({ id, labelledBy, open, onCancel, onBackdrop, onClosed, children }) {
  const ref = useRef(/** @type {HTMLDialogElement | null} */ (null));
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  // A click on the dialog element itself lands on its backdrop or padding,
  // never on its content. It counts only when the press began there too, so
  // dragging a text selection out of the content does not dismiss the dialog.
  const pressedOnBackdrop = useRef(false);
  const press = (/** @type {PointerEvent} */ event) => {
    pressedOnBackdrop.current = event.target === ref.current;
  };
  const click = (/** @type {MouseEvent} */ event) => {
    if (event.target === ref.current && pressedOnBackdrop.current) onBackdrop?.(event);
  };
  return html`<dialog
    id=${id}
    aria-labelledby=${labelledBy}
    ref=${ref}
    onCancel=${onCancel}
    onPointerDown=${press}
    onClick=${click}
    onClose=${onClosed}
  >${children}</dialog>`;
}

/** @param {Flux.State} current */
function selectEditorDialog(current) {
  return current.editorDialog;
}
// A dialog that fails to render keeps its head and close button, so it can
// always be dismissed.
/**
 * @param {string} label
 * @param {() => void} retry
 */
function dialogFallback(label, retry) {
  const dismiss = () => {
    if (!state.busy) closeEditor();
  };
  return html`<div class="dialog-panel">
    <div class="dialog-head">
      <div id="editor-title-group"><h2 id="editor-title">${label}</h2></div>
      <button type="button" id="dismiss" aria-label="Close editor" onClick=${dismiss}>×</button>
    </div>
    <div class="notice-bar notice-bar-danger" role="alert" data-error-boundary="true">
      <span>This dialog could not be shown. Retry, or close it and reload the page if this keeps happening.</span>
      <button type="button" onClick=${retry}>Retry</button>
    </div>
  </div>`;
}
// The open dialog's say over a close request: `reason` is 'backdrop' for a
// click outside it and 'dismiss' for Cancel, the close button or Escape. The
// guard returns true when it has taken over the close, for example to offer
// saving unsaved input first, and false to let the dialog close.
/** @typedef {'backdrop' | 'dismiss'} CloseReason */
/** @type {((reason: CloseReason) => boolean) | undefined} */
let closeGuard;
/** @param {(reason: CloseReason) => boolean} guard */
export function useCloseGuard(guard) {
  const latest = useRef(guard);
  latest.current = guard;
  useEffect(() => {
    const run = (/** @type {CloseReason} */ reason) => latest.current(reason);
    closeGuard = run;
    return () => {
      if (closeGuard === run) closeGuard = undefined;
    };
  }, []);
}
/** @param {CloseReason} reason */
function requestClose(reason) {
  if (!state.busy && !closeGuard?.(reason)) closeEditor();
}
// Hosts the open dialog. `dialogs` maps a dialog type to its component; a
// component's optional static `onClose(props)` runs when its dialog is closed
// rather than replaced by another.
/**
 * @typedef {{
 *   (props: Flux.DialogProps[Flux.DialogType]): unknown,
 *   onClose?: (props: Flux.DialogProps[Flux.DialogType]) => void,
 * }} DialogComponent
 */
/** @param {{ dialogs: Record<Flux.DialogType, DialogComponent> }} props */
export function EditorDialog({ dialogs }) {
  const record = useStore(selectEditorDialog);
  const Component = record ? dialogs[record.type] : undefined;
  const previous = useRef(record);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = record;
    if (!before || record) return;
    dialogs[before.type]?.onClose?.(before.props);
    // The page is no longer inert: a focus move requested while the dialog
    // was open wins; otherwise focus returns to the dialog's opener. A dialog
    // that `onClose` opened in its place takes focus itself.
    const request = state.focusRequest;
    if (state.editorDialog) return;
    if (request) {
      focusKey(request.key);
      clearFocusRequest(request);
    } else focusKey(before.returnFocusKey, { onlyIfLost: true });
    // A closed item editor is no longer a view of that card. Closing one dialog
    // to open another in the same task keeps the card in the URL.
    if (!state.detail && !state.editorDialog) {
      setState({ editorItemID: '' });
      setSharedItem('');
    }
  }, [record]);
  const cancel = (/** @type {Event} */ event) => {
    event.preventDefault();
    requestClose('dismiss');
  };
  const backdrop = () => requestClose('backdrop');
  const closed = (/** @type {Flux.TargetEvent<HTMLDialogElement>} */ event) => {
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
      Component && record
        ? html`<${DialogContext.Provider} value=${record}
            ><${ErrorBoundary} key=${record.key} label="Dialog unavailable" fallback=${dialogFallback}
              ><${Component} ...${record.props}
            /></${ErrorBoundary}></${DialogContext.Provider}>`
        : null
    }
    <${AttachmentTooltip} inDialog=${true} />
  </${Modal}>`;
}

/** @param {Flux.State} current */
function selectBusy(current) {
  return current.busy;
}
/** @param {Flux.State} current */
function selectEditorError(current) {
  return current.editorError;
}
// The one dialog layout. `onSubmit(data, form)` receives the native form data;
// a thrown error is shown on the form's error line and the input is retained.
/** @param {Flux.FormDialogProps} props */
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
  async function submit(/** @type {Flux.TargetEvent<HTMLFormElement, SubmitEvent>} */ event) {
    event.preventDefault();
    if (readOnly || state.busy || submitting.current || !onSubmit) return;
    const form = event.currentTarget;
    setEditorError('');
    submitting.current = true;
    setSaving(true);
    try {
      await onSubmit(new FormData(form), form);
    } catch (submitError) {
      setEditorError(errorMessage(submitError));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  const dismiss = () => requestClose('dismiss');
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
/** @param {Flux.CommandDialogProps} props */
export function CommandDialog({ command, afterSave, ...props }) {
  const dialog = useDialog();
  /** @type {{ current: { serialized: string | undefined, key: string | undefined } }} */
  const pending = useRef({ serialized: undefined, key: undefined });
  async function onSubmit(/** @type {FormData} */ data) {
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
        `${errorMessage(error)} Your input is retained. For a revision conflict, copy your changes, close, refresh, and reopen before retrying.`,
      );
    }
  }
  return h(FormDialog, { ...props, onSubmit });
}
