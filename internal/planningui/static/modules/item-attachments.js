// Card attachments: loading, uploads, drops, tiles and the tooltip.
import { el } from './dom.js';
import { api, apiUpload, requestKey } from './api.js';
import { attachmentSize, attachmentKind, attachmentTypeDescription } from './format.js';
import { emptyStateTemplate } from './layout.js';
import {
  html,
  nothing,
  keyedList,
  syncDisabled,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from './preact.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { writable } from './permissions.js';
import { notice } from './notices.js';
import { renderControls } from './controls.js';
import { memberName } from './people.js';

export function isFileTransfer(dataTransfer) {
  return Array.from(dataTransfer?.types || []).includes('Files');
}
function attachmentHref(item, attachment, base = state.root) {
  return `${base}/items/${encodeURIComponent(item.id)}/attachments/${encodeURIComponent(attachment.id)}`;
}
// A board read reports how many attachments a card has, not what they are, so
// metadata is fetched per card the first time it is actually shown. An item
// whose list has been loaded keeps it on the board item itself; merging a
// fresh board drops that field and the next viewer reloads it.
const attachmentLoads = new Map(),
  attachmentListeners = new Set();
export function attachmentsLoaded(item) {
  return Array.isArray(item?.attachments);
}
export function attachmentCount(item) {
  return attachmentsLoaded(item)
    ? item.attachments.length
    : Number.isSafeInteger(item?.attachment_count) && item.attachment_count > 0
      ? item.attachment_count
      : 0;
}
function setItemAttachments(item, attachments) {
  const target = state.board?.items.find((value) => value.id === item.id) || item;
  target.attachments = attachments;
  target.attachment_count = attachments.length;
  if (target !== item) {
    item.attachments = attachments;
    item.attachment_count = attachments.length;
  }
  attachmentListeners.forEach((listener) => listener(item.id));
}
export function ensureAttachments(item) {
  if (!item || !state.root || attachmentsLoaded(item)) return attachmentLoads.get(item?.id);
  if (attachmentLoads.has(item.id)) return attachmentLoads.get(item.id);
  const currentBoard = state.board,
    currentRoot = state.root,
    id = item.id;
  const pending = (async () => {
    try {
      const data = await api(`${currentRoot}/items/${encodeURIComponent(id)}/attachments`);
      if (state.board !== currentBoard || state.root !== currentRoot) return;
      if (!validAttachments(data) || data.some((attachment) => attachment.item_id !== id))
        throw new Error('Attachment list is invalid. Refresh to retry.');
      setItemAttachments(item, data);
      hooks.renderContent();
    } catch (error) {
      if (state.board === currentBoard && state.root === currentRoot) notice(error.message, true);
    } finally {
      attachmentLoads.delete(id);
    }
  })();
  attachmentLoads.set(id, pending);
  return pending;
}
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024,
  MAX_ITEM_ATTACHMENTS = 100;
const uploadRequestKeys = new Map();
function uploadSignature(item, file) {
  return [item.id, file.name, file.size, file.lastModified || 0, file.type || ''].join('\u0000');
}
function uploadRequestKey(item, file) {
  const signature = uploadSignature(item, file);
  let key = uploadRequestKeys.get(signature);
  if (!key) {
    if (uploadRequestKeys.size >= 1000)
      uploadRequestKeys.delete(uploadRequestKeys.keys().next().value);
    key = requestKey();
    uploadRequestKeys.set(signature, key);
  }
  return { signature, key };
}
function clearUploadRequestKey(signature) {
  uploadRequestKeys.delete(signature);
}
function attachmentRejection(item, file) {
  if (attachmentCount(item) >= MAX_ITEM_ATTACHMENTS)
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
// browser cannot measure the request body.
async function uploadItemFile(item, file, onProgress) {
  const currentRoot = state.root;
  const request = uploadRequestKey(item, file);
  const form = new FormData();
  form.append('file', file);
  const data = await apiUpload(`${currentRoot}/items/${encodeURIComponent(item.id)}/attachments`, {
    headers: { 'X-CSRF-Token': state.session.csrf, 'Idempotency-Key': request.key },
    body: form,
    onProgress,
  });
  if (!validAttachments([data]) || data.item_id !== item.id)
    throw new Error('Attachment response is invalid. Refresh to retry.');
  clearUploadRequestKey(request.signature);
  if (state.root !== currentRoot) return undefined;
  // Without the current list there is nothing to append to, so the count is
  // advanced and the list reloaded rather than invented from one response.
  if (attachmentsLoaded(item))
    setItemAttachments(item, [...item.attachments.filter((value) => value.id !== data.id), data]);
  else {
    item.attachment_count = attachmentCount(item) + 1;
    void ensureAttachments(item);
  }
  return data;
}
// Dropping files onto a card uploads them without opening the editor. Progress
// and failures are reported through the shared status and error surfaces.
async function dropFilesOntoItem(item, files) {
  const selected = Array.from(files || []).filter(Boolean);
  if (!selected.length || state.uploadBusy || !writable()) return;
  state.uploadBusy = true;
  renderControls();
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
        await uploadItemFile(item, file, (fraction) => {
          if (fraction !== undefined)
            notice(`Uploading ${file.name} to “${item.title}” · ${Math.round(fraction * 100)}%`);
        });
      } catch (error) {
        notice(error.message, true);
        break;
      }
      uploaded++;
    }
  } finally {
    state.uploadBusy = false;
    renderControls();
  }
  if (uploaded) {
    notice(`${uploaded} attachment${uploaded === 1 ? '' : 's'} uploaded to “${item.title}”.`);
    hooks.renderContent();
  }
}
// Cards and list rows accept file drops. Planning drags are unaffected because
// only transfers that carry files are intercepted.
export function itemFileDropZone(node, item) {
  // The element can outlive the board payload that created it. Resolve the
  // current record at event time so permissions, names and counts stay fresh.
  const currentItem = () => state.board?.items.find((value) => value.id === item.id) || item;
  const clear = () => node.classList.remove('attachment-drop-active');
  const show = (event) => {
    if (!isFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (writable() && !state.uploadBusy && !currentItem().archived) {
      event.dataTransfer.dropEffect = 'copy';
      node.classList.add('attachment-drop-active');
    } else {
      event.dataTransfer.dropEffect = 'none';
      clear();
    }
  };
  node.addEventListener('dragenter', show);
  node.addEventListener('dragover', show);
  node.addEventListener('dragleave', (event) => {
    if (!(event.relatedTarget instanceof Node) || !node.contains(event.relatedTarget)) clear();
  });
  node.addEventListener('drop', (event) => {
    if (!isFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    clear();
    const current = currentItem();
    if (writable() && !state.uploadBusy && !current.archived)
      void dropFilesOntoItem(current, event.dataTransfer.files);
  });
}
export function attachmentPaperclipTemplate() {
  return html`<span class="attachment-paperclip" aria-hidden="true">📎</span>`;
}
// `extraClass` adds a placement class, for example on a card's attachment list.
export function attachmentTileLinkTemplate(
  item,
  attachment,
  base = state.root,
  metadata = attachmentSize(attachment.size),
  extraClass = '',
) {
  return html`<a
    class="attachment-link attachment-tile-link${extraClass}"
    href=${attachmentHref(item, attachment, base)}
    aria-label=${attachment.name}
    download=""
    data-attachment-tooltip=${attachmentTypeDescription(attachment)}
    data-attachment-id=${String(attachment.id)}
  >
    <span class="attachment-file-mark" aria-hidden="true">${attachmentKind(attachment)}</span>
    <span class="attachment-tile-copy">
      <span class="attachment-name">${attachment.name}</span>
      <span class="attachment-meta">${metadata}</span>
    </span>
  </a>`;
}
function attachmentTooltipHost() {
  return document.querySelector('dialog[open]') || document.body;
}
function ensureAttachmentTooltip() {
  if (state.attachmentTooltip) return state.attachmentTooltip;
  state.attachmentTooltip = el('span', undefined, 'attachment-tooltip');
  state.attachmentTooltip.id = 'attachment-tooltip';
  state.attachmentTooltip.setAttribute('role', 'tooltip');
  state.attachmentTooltip.hidden = true;
  return state.attachmentTooltip;
}
function attachmentLinkTarget(target) {
  return target instanceof Element ? target.closest('.attachment-tile-link') : undefined;
}
function attachmentTooltipAnchor(target, source) {
  const mark =
    (source instanceof Element ? source.closest('.attachment-file-mark') : undefined) ||
    target.querySelector('.attachment-file-mark');
  return mark && target.contains(mark) ? mark : target;
}
export function hideAttachmentTooltip(target) {
  if (target && target !== state.attachmentTooltipTarget) return;
  if (state.attachmentTooltipTarget?.getAttribute('aria-describedby') === 'attachment-tooltip')
    state.attachmentTooltipTarget.removeAttribute('aria-describedby');
  state.attachmentTooltipTarget = undefined;
  if (state.attachmentTooltip) state.attachmentTooltip.hidden = true;
}
function showAttachmentTooltip(target, source) {
  if (!target?.dataset.attachmentTooltip) {
    hideAttachmentTooltip();
    return;
  }
  if (state.attachmentTooltipTarget && state.attachmentTooltipTarget !== target)
    hideAttachmentTooltip();
  const tooltip = ensureAttachmentTooltip();
  const host = attachmentTooltipHost();
  if (tooltip.parentElement !== host) host.append(tooltip);
  state.attachmentTooltipTarget = target;
  tooltip.textContent = target.dataset.attachmentTooltip;
  target.setAttribute('aria-describedby', tooltip.id);
  tooltip.hidden = false;
  const rootStyle = getComputedStyle(document.documentElement);
  const gap = Number.parseFloat(rootStyle.getPropertyValue('--s1')) || 4;
  const edge = Number.parseFloat(rootStyle.getPropertyValue('--s4')) || 16;
  const targetBox = target.getBoundingClientRect();
  const anchor = attachmentTooltipAnchor(target, source).getBoundingClientRect();
  const size = tooltip.getBoundingClientRect();
  const maxLeft = Math.max(edge, innerWidth - size.width - edge);
  const left = Math.min(Math.max(edge, anchor.left), maxLeft);
  const top = Math.min(
    Math.max(edge, targetBox.bottom + gap),
    Math.max(edge, innerHeight - size.height - edge),
  );
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}
function repositionAttachmentTooltip() {
  const dialog = state.attachmentTooltipTarget?.closest('dialog');
  if (state.attachmentTooltipTarget?.isConnected && (!dialog || dialog.open))
    showAttachmentTooltip(state.attachmentTooltipTarget);
  else hideAttachmentTooltip();
}
function attachmentTileTemplate(item, attachment, base, metadata, onRemove) {
  return html`<div class="attachment-tile" data-attachment-id=${String(attachment.id)}>
    ${attachmentTileLinkTemplate(item, attachment, base, metadata)}
    ${
      onRemove
        ? html`<details class="attachment-actions" data-state-key=${`attachment:${attachment.id}:actions`}>
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
                ref=${syncDisabled(!writable() || state.integrationFormOpen)}
                onClick=${onRemove}
              >Remove attachment</button>
            </div>
          </details>`
        : nothing
    }
  </div>`;
}
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
// The component owns loading, upload progress and drop state. The file input's
// value remains native form state, and drag listeners are scoped to its lifetime.
function ItemAttachments({ item, readOnly }) {
  const [currentRoot] = useState(() => state.root);
  const [inputID] = useState(() => `attachment-file-${requestKey()}`);
  const [local, setLocal] = useState({
    busy: false,
    status: '',
    error: false,
    progress: undefined,
    progressShown: false,
    dropping: false,
  });
  // Ref updates synchronously so repeated native events cannot race a state commit.
  const localRef = useRef(local);
  localRef.current = local;
  const section = useRef();
  const itemRef = useRef(item);
  itemRef.current = item;
  const active = useRef(false);
  const updateLocal = (next) => {
    const value = typeof next === 'function' ? next(localRef.current) : next;
    localRef.current = value;
    setLocal(value);
  };
  const setStatus = (text, error = false) =>
    updateLocal({ ...localRef.current, status: text || '', error });
  const fileInput = () => section.current?.querySelector('.attachment-file-input');
  const addButton = () => section.current?.querySelector('.attachment-add');
  async function removeAttachment(attachment) {
    if (localRef.current.busy || !writable()) return;
    const currentItem = itemRef.current;
    updateLocal({
      ...localRef.current,
      busy: true,
      status: `Removing ${attachment.name}…`,
      error: false,
    });
    try {
      await api(attachmentHref(currentItem, attachment, currentRoot), {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': state.session.csrf },
      });
      if (state.root !== currentRoot || !active.current) return;
      setItemAttachments(
        currentItem,
        (currentItem.attachments || []).filter((value) => value.id !== attachment.id),
      );
      hooks.renderContent();
      setStatus(currentItem.attachments.length ? 'Attachment removed.' : 'No attachments yet.');
    } catch (error) {
      if (active.current) setStatus(error.message, true);
    } finally {
      if (active.current) {
        updateLocal({ ...localRef.current, busy: false });
        renderControls();
      }
    }
  }
  async function uploadFile(file) {
    addButton()?.focus();
    if (localRef.current.busy || state.uploadBusy || !writable()) return false;
    const currentItem = itemRef.current;
    const rejection = attachmentRejection(currentItem, file);
    if (rejection) {
      setStatus(rejection, true);
      return false;
    }
    updateLocal({
      ...localRef.current,
      busy: true,
      progress: 0,
      progressShown: true,
      status: `Uploading ${file.name}…`,
      error: false,
    });
    state.uploadBusy = true;
    let uploaded = false;
    try {
      await uploadItemFile(currentItem, file, (fraction) => {
        if (!active.current) return;
        updateLocal({ ...localRef.current, progress: fraction });
        if (fraction !== undefined)
          setStatus(`Uploading ${file.name} · ${Math.round(fraction * 100)}%`);
      });
      if (state.root !== currentRoot || !active.current) return false;
      hooks.renderContent();
      setStatus('Attachment uploaded.');
      uploaded = true;
    } catch (error) {
      if (active.current) setStatus(error.message, true);
    } finally {
      state.uploadBusy = false;
      if (active.current) {
        updateLocal({
          ...localRef.current,
          busy: false,
          progress: 0,
          progressShown: false,
        });
        renderControls();
        const add = addButton();
        if (add && !add.disabled) add.focus();
      }
    }
    return uploaded;
  }
  async function uploadFiles(files) {
    if (localRef.current.busy || state.uploadBusy || !writable()) return;
    const selected = Array.from(files || []).filter(Boolean);
    const input = fileInput();
    if (input) input.value = '';
    if (!selected.length) {
      setStatus('Choose a file first.', true);
      addButton()?.focus();
      return;
    }
    let uploaded = 0;
    for (const file of selected) {
      if (!(await uploadFile(file))) break;
      uploaded++;
    }
    if (uploaded > 1 && active.current) setStatus(`${uploaded} attachments uploaded.`);
  }
  const clearDrop = () => {
    section.current?.classList.remove('attachment-drop-active');
    updateLocal({ ...localRef.current, dropping: false });
  };
  const showDrop = (event) => {
    if (!isFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (writable() && !localRef.current.busy && !state.uploadBusy) {
      event.dataTransfer.dropEffect = 'copy';
      section.current?.classList.add('attachment-drop-active');
      updateLocal({ ...localRef.current, dropping: true });
    } else {
      event.dataTransfer.dropEffect = 'none';
      clearDrop();
    }
  };
  useLayoutEffect(() => {
    active.current = true;
    const onAttachmentsLoaded = (id) => {
      if (id === item.id) updateLocal({ ...localRef.current });
    };
    attachmentListeners.add(onAttachmentsLoaded);
    const node = section.current;
    const onDragLeave = (event) => {
      if (!(event.relatedTarget instanceof Node) || !node.contains(event.relatedTarget))
        clearDrop();
    };
    const onDrop = (event) => {
      if (!isFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      clearDrop();
      if (writable() && !localRef.current.busy && !state.uploadBusy)
        void uploadFiles(event.dataTransfer.files);
    };
    if (!readOnly) {
      node.addEventListener('dragenter', showDrop);
      node.addEventListener('dragover', showDrop);
      node.addEventListener('dragleave', onDragLeave);
      node.addEventListener('drop', onDrop);
    }
    return () => {
      active.current = false;
      attachmentListeners.delete(onAttachmentsLoaded);
      node.classList.remove('attachment-drop-active');
      node.removeEventListener('dragenter', showDrop);
      node.removeEventListener('dragover', showDrop);
      node.removeEventListener('dragleave', onDragLeave);
      node.removeEventListener('drop', onDrop);
    };
  }, [item.id, readOnly]);
  useEffect(() => {
    if (!attachmentsLoaded(itemRef.current)) void ensureAttachments(itemRef.current);
  }, [item]);
  const listTemplate = () => {
    if (!attachmentsLoaded(item)) return emptyStateTemplate('Loading attachments…');
    if (!item.attachments.length) return emptyStateTemplate('No attachments yet.');
    return keyedList(
      item.attachments,
      (attachment) => attachment.id,
      (attachment) =>
        attachmentTileTemplate(
          item,
          attachment,
          currentRoot,
          `${attachmentSize(attachment.size)} · ${memberName(attachment.uploader)}`,
          readOnly ? undefined : () => removeAttachment(attachment),
        ),
    );
  };
  const uploadTemplate = () => html`<div class="attachment-upload">
    <button
      type="button"
      class="attachment-add"
      data-write="true"
      aria-controls=${inputID}
      title="Choose a file to attach"
      ref=${syncDisabled(local.busy || !writable() || state.integrationFormOpen)}
      onClick=${() => fileInput()?.click()}
    >Add attachment</button>
    <span class="attachment-drop-hint" hidden=${!local.dropping}>Drop files here</span>
    <progress
      class="attachment-progress"
      max="1"
      value=${local.progress ?? nothing}
      hidden=${!local.progressShown}
      aria-label="Upload progress"
    ></progress>
    <input
      type="file"
      class="attachment-file-input"
      id=${inputID}
      tabindex="-1"
      aria-label="Attachment file"
      onChange=${(event) => {
        const input = event.currentTarget;
        void uploadFiles(input.files ? [input.files[0]] : []);
      }}
      onCancel=${(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (active.current) addButton()?.focus();
      }}
    />
  </div>`;
  return html`<section class="item-attachments" aria-label="Attachments" ref=${section}>
    <div class="section-head">
      <div class="attachment-heading">
        ${attachmentPaperclipTemplate()}
        <h3>Attachments</h3>
        <span class="attachment-count" aria-hidden="true">${String(attachmentCount(item))}</span>
      </div>
      ${readOnly ? nothing : uploadTemplate()}
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
export function itemAttachmentsTemplate(item, readOnly) {
  return html`<${ItemAttachments} key=${item.id} item=${item} readOnly=${readOnly} />`;
}
// Registers the attachment tooltip listeners; app.js calls this once at startup.
export function initAttachmentTooltips() {
  document.addEventListener('pointerover', (e) => {
    const target = attachmentLinkTarget(e.target);
    if (target && !(e.relatedTarget instanceof Node && target.contains(e.relatedTarget)))
      showAttachmentTooltip(target, e.target);
  });
  document.addEventListener('pointerout', (e) => {
    const target = attachmentLinkTarget(e.target);
    if (
      !target ||
      (e.relatedTarget instanceof Node && target.contains(e.relatedTarget)) ||
      target.matches(':hover') ||
      target.contains(document.activeElement)
    )
      return;
    hideAttachmentTooltip(target);
  });
  document.addEventListener('focusin', (e) => {
    const target = attachmentLinkTarget(e.target);
    if (target) showAttachmentTooltip(target, e.target);
  });
  document.addEventListener('focusout', (e) => {
    const target = attachmentLinkTarget(e.target);
    if (
      !target ||
      (e.relatedTarget instanceof Node && target.contains(e.relatedTarget)) ||
      target.matches(':hover')
    )
      return;
    hideAttachmentTooltip(target);
  });
  window.addEventListener('resize', repositionAttachmentTooltip);
  document.addEventListener('scroll', repositionAttachmentTooltip, true);
}
