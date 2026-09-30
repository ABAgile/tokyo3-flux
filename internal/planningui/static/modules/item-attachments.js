// Card attachments: loading, uploads, drops and tiles.
import { api, apiUpload, errorMessage, isAbortError, requestKey } from './api.js';
import { workspaceSignal } from './workspace-session.js';
import { attachmentSize, attachmentKind, attachmentTypeDescription } from './format.js';
import { emptyStateTemplate } from './layout.js';
import { html } from './vdom.js';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from './vendor-preact.js';

import { setState, state, useStore, sessionCSRF } from './state.js';
import { usePermissions, writable } from './permissions.js';
import { notice } from './notices.js';
import { memberName } from './people.js';
import { selectLookups } from './lookups.js';
import { useDismiss, useMutation } from './ui-hooks.js';
import { useAttachmentTooltip } from './tooltip.js';

/** @param {DataTransfer | null | undefined} dataTransfer */
export function isFileTransfer(dataTransfer) {
  return Array.from(dataTransfer?.types || []).includes('Files');
}
/**
 * @param {Flux.Item} item
 * @param {Flux.Attachment} attachment
 * @param {string} base
 */
function attachmentHref(item, attachment, base) {
  return `${base}/items/${encodeURIComponent(item.id)}/attachments/${encodeURIComponent(attachment.id)}`;
}
// A board read reports how many attachments a card has, not what they are, so
// metadata is fetched per card the first time it is actually shown. Loaded
// lists live in the store by item id; a fresh board drops them and the next
// viewer reloads them.
/** @type {Map<string, Promise<void>>} */
const attachmentLoads = new Map();
/** @param {string} itemID */
export function useAttachmentList(itemID) {
  return useStore((current) => current.attachmentLists[itemID]);
}
/** @param {Flux.State} current */
export function selectBoardGeneration(current) {
  return current.boardGeneration;
}
/**
 * @param {Pick<Flux.Item, 'attachment_count'> | undefined} item
 * @param {Flux.Attachment[] | undefined} list
 */
export function attachmentCount(item, list) {
  const declared = item?.attachment_count;
  return Array.isArray(list)
    ? list.length
    : declared !== undefined && Number.isSafeInteger(declared) && declared > 0
      ? declared
      : 0;
}
/**
 * @param {string} itemID
 * @param {Flux.Attachment[]} attachments
 */
function setItemAttachments(itemID, attachments) {
  setState((current) => ({
    attachmentLists: { ...current.attachmentLists, [itemID]: attachments },
  }));
}
/**
 * @param {string | undefined} itemID
 * @returns {Promise<void> | undefined}
 */
export function ensureAttachments(itemID) {
  if (!itemID || !state.root || Array.isArray(state.attachmentLists[itemID])) return undefined;
  const root = state.root,
    generation = state.boardGeneration,
    signal = workspaceSignal();
  const loadKey = `${root}\u0000${generation}\u0000${itemID}`;
  if (attachmentLoads.has(loadKey)) return attachmentLoads.get(loadKey);
  const current = () => !signal.aborted && state.boardGeneration === generation;
  const pending = (async () => {
    try {
      const data = await api(`${root}/items/${encodeURIComponent(itemID)}/attachments`, {
        signal,
      });
      if (!current()) return;
      if (!validAttachments(data) || data.some((attachment) => attachment.item_id !== itemID))
        throw new Error('Attachment list is invalid. Refresh to retry.');
      setItemAttachments(itemID, data);
    } catch (error) {
      if (current()) notice(errorMessage(error), true);
    } finally {
      attachmentLoads.delete(loadKey);
    }
  })();
  attachmentLoads.set(loadKey, pending);
  return pending;
}
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024,
  MAX_ITEM_ATTACHMENTS = 100;
/** @type {Map<string, string>} */
const uploadRequestKeys = new Map();
/**
 * @param {Flux.Item} item
 * @param {File} file
 */
function uploadSignature(item, file) {
  return [item.id, file.name, file.size, file.lastModified || 0, file.type || ''].join('\u0000');
}
/**
 * @param {Flux.Item} item
 * @param {File} file
 */
function uploadRequestKey(item, file) {
  const signature = uploadSignature(item, file);
  let key = uploadRequestKeys.get(signature);
  if (!key) {
    if (uploadRequestKeys.size >= 1000) {
      const oldest = uploadRequestKeys.keys().next().value;
      if (oldest !== undefined) uploadRequestKeys.delete(oldest);
    }
    key = requestKey();
    uploadRequestKeys.set(signature, key);
  }
  return { signature, key };
}
/** @param {string} signature */
function clearUploadRequestKey(signature) {
  uploadRequestKeys.delete(signature);
}
/**
 * @param {Flux.Item} item
 * @param {File | null | undefined} file
 */
function attachmentRejection(item, file) {
  if (attachmentCount(item, state.attachmentLists[item.id]) >= MAX_ITEM_ATTACHMENTS)
    return `This card already has the maximum of ${MAX_ITEM_ATTACHMENTS} attachments.`;
  if (
    !file ||
    typeof file.name !== 'string' ||
    !file.name ||
    !Number.isFinite(file.size) ||
    file.size < 0
  )
    return 'Choose a file first.';
  if (file.size > MAX_ATTACHMENT_BYTES) return 'Attachments must be 20 MiB or smaller.';
  return '';
}
// Shared upload used by the editor picker, the editor drop zone, and card
// file drops. Progress is reported as a 0..1 fraction, or undefined when the
// browser cannot measure the request body. `signal` belongs to the workspace
// session or to a component keyed by it, so an aborted upload is never
// applied to another workspace.
/**
 * @param {Flux.Item} item
 * @param {File} file
 * @param {(fraction: number | undefined) => void} onProgress
 * @param {AbortSignal} signal
 * @returns {Promise<Flux.Attachment | undefined>}
 */
async function uploadItemFile(item, file, onProgress, signal) {
  const request = uploadRequestKey(item, file);
  const form = new FormData();
  form.append('file', file);
  const data = await apiUpload(`${state.root}/items/${encodeURIComponent(item.id)}/attachments`, {
    headers: { 'X-CSRF-Token': sessionCSRF(), 'Idempotency-Key': request.key },
    body: form,
    onProgress,
    signal,
  });
  if (!validAttachments([data]) || data.item_id !== item.id)
    throw new Error('Attachment response is invalid. Refresh to retry.');
  clearUploadRequestKey(request.signature);
  if (signal.aborted) return undefined;
  // Without the current list there is nothing to append to, so the list is
  // reloaded rather than invented from one response.
  const list = state.attachmentLists[item.id];
  if (Array.isArray(list))
    setItemAttachments(item.id, [...list.filter((value) => value.id !== data.id), data]);
  else void ensureAttachments(item.id);
  return data;
}
// Dropping files onto a card uploads them without opening the editor. Progress
// and failures are reported through the shared status and error surfaces; the
// uploads belong to the workspace session and stop when it ends.
/**
 * @param {Flux.Item} item
 * @param {ArrayLike<File> | null | undefined} files
 */
async function dropFilesOntoItem(item, files) {
  const selected = Array.from(files || []).filter(Boolean);
  if (!selected.length || state.uploadBusy || !writable()) return;
  const signal = workspaceSignal();
  setState({ uploadBusy: true });
  let uploaded = 0;
  try {
    for (const file of selected) {
      const rejection = attachmentRejection(item, file);
      if (rejection) {
        notice(rejection, true);
        break;
      }
      notice(`Uploading ${file.name} to “${item.title}”…`);
      try {
        await uploadItemFile(
          item,
          file,
          (fraction) => {
            if (fraction !== undefined && !signal.aborted)
              notice(`Uploading ${file.name} to “${item.title}” · ${Math.round(fraction * 100)}%`);
          },
          signal,
        );
      } catch (error) {
        if (!isAbortError(error)) notice(errorMessage(error), true);
        break;
      }
      if (signal.aborted) break;
      uploaded++;
    }
  } finally {
    setState({ uploadBusy: false });
  }
  if (uploaded && !signal.aborted)
    notice(`${uploaded} attachment${uploaded === 1 ? '' : 's'} uploaded to “${item.title}”.`);
}
// Cards and list rows accept file drops. Planning drags are unaffected because
// only transfers that carry files are intercepted. The current record is
// resolved by id at event time, so permissions, names and counts stay fresh.
/** @param {string} itemID */
export function useItemFileDrop(itemID) {
  const [active, setActive] = useState(false);
  const currentItem = () =>
    state.board?.items.find((value) => value.id === itemID) ||
    state.archiveItems.find((value) => value.id === itemID);
  const show = (/** @type {DragEvent} */ event) => {
    const transfer = event.dataTransfer;
    if (!transfer || !isFileTransfer(transfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const item = currentItem();
    const allowed = writable() && !state.uploadBusy && item && !item.archived;
    transfer.dropEffect = allowed ? 'copy' : 'none';
    setActive(!!allowed);
  };
  const props = {
    onDragEnter: show,
    onDragOver: show,
    onDragLeave: (/** @type {Flux.TargetEvent<HTMLElement, DragEvent>} */ event) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !event.currentTarget.contains(event.relatedTarget)
      )
        setActive(false);
    },
    onDrop: (/** @type {DragEvent} */ event) => {
      const transfer = event.dataTransfer;
      if (!transfer || !isFileTransfer(transfer)) return;
      event.preventDefault();
      event.stopPropagation();
      setActive(false);
      const item = currentItem();
      if (writable() && !state.uploadBusy && item && !item.archived)
        void dropFilesOntoItem(item, transfer.files);
    },
  };
  return { props, className: active ? 'attachment-drop-active' : '' };
}
export function attachmentPaperclipTemplate() {
  return html`<span class="attachment-paperclip" aria-hidden="true">📎</span>`;
}
// `extraClass` adds a placement class, for example on a card's attachment list.
// `base` is the workspace root the attachment belongs to.
/**
 * @param {{
 *   item: Flux.Item,
 *   attachment: Flux.Attachment,
 *   base: string,
 *   metadata?: string,
 *   extraClass?: string,
 * }} props
 */
export function AttachmentTileLink({
  item,
  attachment,
  base,
  metadata = attachmentSize(attachment.size),
  extraClass = '',
}) {
  const description = attachmentTypeDescription(attachment);
  const tooltip = useAttachmentTooltip(description);
  return html`<a
    class="attachment-link attachment-tile-link${extraClass}"
    href=${attachmentHref(item, attachment, base)}
    aria-label=${attachment.name}
    aria-describedby=${tooltip.active ? 'attachment-tooltip' : null}
    download=""
    data-attachment-tooltip=${description}
    data-attachment-id=${String(attachment.id)}
    ref=${tooltip.ref}
    ...${tooltip.props}
  >
    <span class="attachment-file-mark" aria-hidden="true" ref=${tooltip.anchorRef}>${attachmentKind(attachment)}</span>
    <span class="attachment-tile-copy">
      <span class="attachment-name">${attachment.name}</span>
      <span class="attachment-meta">${metadata}</span>
    </span>
  </a>`;
}
// The actions menu is a native disclosure whose open state the component owns,
// so an outside pointer closes it.
/** @param {{ attachment: Flux.Attachment, onRemove: () => unknown }} props */
function AttachmentActions({ attachment, onRemove }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(/** @type {HTMLDetailsElement | null} */ (null));
  const { writeDisabled } = usePermissions();
  useDismiss(ref, open, () => setOpen(false), { closeOnEscape: false });
  return html`<details
    class="attachment-actions"
    data-state-key=${`attachment:${attachment.id}:actions`}
    open=${open}
    ref=${ref}
    onToggle=${(/** @type {Flux.TargetEvent<HTMLDetailsElement>} */ event) => setOpen(event.currentTarget.open)}
  >
    <summary
      class="attachment-actions-toggle"
      aria-label=${`Attachment actions for ${attachment.name}`}
      title="Attachment actions"
    >⋯</summary>
    <div class="attachment-actions-menu" role="menu">
      <button
        type="button"
        class="attachment-remove"
        role="menuitem"
        data-write="true"
        disabled=${writeDisabled}
        onClick=${onRemove}
      >Remove attachment</button>
    </div>
  </details>`;
}
/**
 * @param {unknown} data
 * @returns {data is Flux.Attachment[]}
 */
function validAttachments(data) {
  return (
    Array.isArray(data) &&
    data.every(
      (attachment) =>
        attachment &&
        Number.isSafeInteger(attachment.id) &&
        attachment.id > 0 &&
        typeof attachment.item_id === 'string' &&
        typeof attachment.name === 'string' &&
        attachment.name &&
        typeof attachment.content_type === 'string' &&
        attachment.content_type &&
        typeof attachment.digest === 'string' &&
        /^sha256:[0-9a-f]{64}$/.test(attachment.digest) &&
        Number.isSafeInteger(attachment.size) &&
        attachment.size >= 0 &&
        typeof attachment.uploader === 'string' &&
        attachment.uploader &&
        typeof attachment.created_at === 'string' &&
        !Number.isNaN(Date.parse(attachment.created_at)),
    )
  );
}
/**
 * @typedef {{
 *   status: string,
 *   error: boolean,
 *   progress: number | undefined,
 *   progressShown: boolean,
 *   dropping: boolean,
 * }} AttachmentsState
 */
/**
 * @typedef {{ type: 'status', text?: string, error?: boolean }
 *   | { type: 'progress', progress: number | undefined, shown?: boolean }
 *   | { type: 'dropping', dropping: boolean }} AttachmentsAction
 */
/**
 * @param {AttachmentsState} current
 * @param {AttachmentsAction} action
 * @returns {AttachmentsState}
 */
function attachmentsReducer(current, action) {
  switch (action.type) {
    case 'status':
      return { ...current, status: action.text || '', error: !!action.error };
    case 'progress':
      return { ...current, progress: action.progress, progressShown: action.shown ?? true };
    case 'dropping':
      return current.dropping === action.dropping
        ? current
        : { ...current, dropping: action.dropping };
    default:
      return current;
  }
}
// The component owns upload progress and drop state; the list itself is shared
// store data. The file input's value remains native form state. Keyed by
// workspace root and item, so a switch remounts it and aborts its writes.
/** @param {{ root: string, item: Flux.Item, readOnly?: boolean }} props */
function ItemAttachments({ root, item, readOnly }) {
  const inputID = `attachment-file-${useId()}`;
  const [local, dispatch] = useReducer(attachmentsReducer, {
    status: '',
    error: false,
    progress: undefined,
    progressShown: false,
    dropping: false,
  });
  const writes = useMutation();
  const list = useAttachmentList(item.id);
  const generation = useStore(selectBoardGeneration);
  const lookups = useStore(selectLookups);
  const { writeDisabled } = usePermissions();
  const fileInput = useRef(/** @type {HTMLInputElement | null} */ (null));
  const addButton = useRef(/** @type {HTMLButtonElement | null} */ (null));
  // Bumped when an upload settles; the add button takes focus back once the
  // render that re-enables it has committed.
  const [refocusAdd, setRefocusAdd] = useState(0);
  useLayoutEffect(() => {
    const add = addButton.current;
    if (refocusAdd && add && !add.disabled) add.focus();
  }, [refocusAdd]);
  const setStatus = (/** @type {string} */ text, error = false) =>
    dispatch({ type: 'status', text, error });
  useEffect(() => {
    if (!Array.isArray(list)) void ensureAttachments(item.id);
  }, [item.id, list, generation]);
  /** @param {Flux.Attachment} attachment */
  async function removeAttachment(attachment) {
    if (!writable()) return;
    await writes.run(async (signal) => {
      setStatus(`Removing ${attachment.name}…`);
      try {
        await api(attachmentHref(item, attachment, root), {
          method: 'DELETE',
          headers: { 'X-CSRF-Token': sessionCSRF() },
          signal,
        });
        if (signal.aborted) return;
        const next = (state.attachmentLists[item.id] || []).filter(
          (value) => value.id !== attachment.id,
        );
        setItemAttachments(item.id, next);
        setStatus(next.length ? 'Attachment removed.' : 'No attachments yet.');
      } catch (error) {
        if (!signal.aborted) setStatus(errorMessage(error), true);
      }
    });
  }
  /** @param {ArrayLike<File> | null | undefined} files */
  async function uploadFiles(files) {
    if (writes.pending || state.uploadBusy || !writable()) return;
    const selected = Array.from(files || []).filter(Boolean);
    if (fileInput.current) fileInput.current.value = '';
    if (!selected.length) {
      setStatus('Choose a file first.', true);
      addButton.current?.focus();
      return;
    }
    await writes.run(async (signal) => {
      let uploaded = 0;
      for (const file of selected) {
        addButton.current?.focus();
        const rejection = attachmentRejection(item, file);
        if (rejection) {
          setStatus(rejection, true);
          break;
        }
        dispatch({ type: 'progress', progress: 0 });
        setStatus(`Uploading ${file.name}…`);
        setState({ uploadBusy: true });
        try {
          await uploadItemFile(
            item,
            file,
            (fraction) => {
              if (signal.aborted) return;
              dispatch({ type: 'progress', progress: fraction });
              if (fraction !== undefined)
                setStatus(`Uploading ${file.name} · ${Math.round(fraction * 100)}%`);
            },
            signal,
          );
          if (signal.aborted) break;
          setStatus('Attachment uploaded.');
          uploaded++;
        } catch (error) {
          if (!signal.aborted) setStatus(errorMessage(error), true);
          break;
        } finally {
          setState({ uploadBusy: false });
          if (!signal.aborted) dispatch({ type: 'progress', progress: 0, shown: false });
        }
      }
      if (uploaded > 1 && !signal.aborted) setStatus(`${uploaded} attachments uploaded.`);
    });
    setRefocusAdd((value) => value + 1);
  }
  const dropAllowed = () => writable() && !writes.pending && !state.uploadBusy;
  const showDrop = (/** @type {DragEvent} */ event) => {
    const transfer = event.dataTransfer;
    if (!transfer || !isFileTransfer(transfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const allowed = dropAllowed();
    transfer.dropEffect = allowed ? 'copy' : 'none';
    dispatch({ type: 'dropping', dropping: allowed });
  };
  const dropProps = readOnly
    ? {}
    : {
        onDragEnter: showDrop,
        onDragOver: showDrop,
        onDragLeave: (/** @type {Flux.TargetEvent<HTMLElement, DragEvent>} */ event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            dispatch({ type: 'dropping', dropping: false });
        },
        onDrop: (/** @type {DragEvent} */ event) => {
          const transfer = event.dataTransfer;
          if (!transfer || !isFileTransfer(transfer)) return;
          event.preventDefault();
          event.stopPropagation();
          dispatch({ type: 'dropping', dropping: false });
          if (dropAllowed()) void uploadFiles(transfer.files);
        },
      };
  const listTemplate = () => {
    if (!Array.isArray(list)) return emptyStateTemplate('Loading attachments…');
    if (!list.length) return emptyStateTemplate('No attachments yet.');
    return list.map(
      (attachment) => html`<div
        key=${attachment.id}
        class="attachment-tile"
        data-attachment-id=${String(attachment.id)}
      >
        <${AttachmentTileLink}
          item=${item}
          attachment=${attachment}
          base=${root}
          metadata=${`${attachmentSize(attachment.size)} · ${memberName(lookups, attachment.uploader)}`}
        />
        ${
          readOnly
            ? null
            : html`<${AttachmentActions}
                attachment=${attachment}
                onRemove=${() => removeAttachment(attachment)}
              />`
        }
      </div>`,
    );
  };
  const uploadTemplate = () => html`<div class="attachment-upload">
    <button
      type="button"
      class="attachment-add"
      data-write="true"
      aria-controls=${inputID}
      title="Choose a file to attach"
      disabled=${writes.pending || writeDisabled}
      ref=${addButton}
      onClick=${() => fileInput.current?.click()}
    >Add attachment</button>
    <span class="attachment-drop-hint" hidden=${!local.dropping}>Drop files here</span>
    <progress
      class="attachment-progress"
      max="1"
      value=${local.progress ?? null}
      hidden=${!local.progressShown}
      aria-label="Upload progress"
    ></progress>
    <input
      type="file"
      class="attachment-file-input"
      id=${inputID}
      tabindex="-1"
      aria-label="Attachment file"
      ref=${fileInput}
      onChange=${(/** @type {Flux.TargetEvent<HTMLInputElement>} */ event) => {
        const input = event.currentTarget;
        void uploadFiles(input.files ? [input.files[0]] : []);
      }}
      onCancel=${(/** @type {Event} */ event) => {
        event.preventDefault();
        event.stopPropagation();
        addButton.current?.focus();
      }}
    />
  </div>`;
  return html`<section
    class=${`item-attachments${local.dropping ? ' attachment-drop-active' : ''}`}
    aria-label="Attachments"
    ...${dropProps}
  >
    <div class="section-head">
      <div class="attachment-heading">
        ${attachmentPaperclipTemplate()}
        <h3>Attachments</h3>
        <span class="attachment-count" aria-hidden="true">${String(attachmentCount(item, list))}</span>
      </div>
      ${readOnly ? null : uploadTemplate()}
    </div>
    <p
      class=${local.error ? 'help error' : 'help'}
      data-status-class="help"
      hidden=${!local.status}
      role=${local.error ? 'alert' : 'status'}
      aria-live="polite"
    >${local.status}</p>
    <div class="attachment-grid">${listTemplate()}</div>
  </section>`;
}
/** @param {Flux.State} current */
function selectRoot(current) {
  return current.root;
}
/** @param {{ item: Flux.Item, readOnly?: boolean }} props */
function WorkspaceItemAttachments({ item, readOnly }) {
  const root = useStore(selectRoot);
  return html`<${ItemAttachments} key=${`${root}:${item.id}`} root=${root} item=${item} readOnly=${readOnly} />`;
}
/**
 * @param {Flux.Item} item
 * @param {boolean} [readOnly]
 */
export function itemAttachmentsTemplate(item, readOnly) {
  return html`<${WorkspaceItemAttachments} item=${item} readOnly=${readOnly} />`;
}
