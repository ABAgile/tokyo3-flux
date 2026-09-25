// Card attachments: loading, uploads, drops, tiles and the tooltip.
import { el, button } from './dom.js';
import { api, apiUpload, requestKey } from './api.js';
import { attachmentSize, attachmentKind, attachmentTypeDescription } from './format.js';
import { statusLine, setStatusText, emptyState } from './layout.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { writable } from './permissions.js';
import { notice } from './notices.js';
import { renderControls } from './controls.js';
import { memberName } from './people.js';
import { reconcileKeyedChildren } from './reconcile.js';

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
  const clear = () => node.classList.remove('attachment-drop-active');
  const show = (event) => {
    if (!isFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (writable() && !state.uploadBusy && !item.archived) {
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
    if (writable() && !state.uploadBusy && !item.archived)
      void dropFilesOntoItem(item, event.dataTransfer.files);
  });
}
function attachmentFileMark(attachment) {
  const mark = el('span', attachmentKind(attachment), 'attachment-file-mark');
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}
export function attachmentPaperclip() {
  const icon = el('span', '📎', 'attachment-paperclip');
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}
function attachmentLinkView(item, attachment, base = state.root) {
  const link = el('a', attachment.name, 'attachment-link');
  link.href = attachmentHref(item, attachment, base);
  link.setAttribute('aria-label', attachment.name);
  link.setAttribute('download', '');
  link.dataset.attachmentTooltip = attachmentTypeDescription(attachment);
  return link;
}
export function attachmentTileLink(
  item,
  attachment,
  base = state.root,
  metadata = attachmentSize(attachment.size),
) {
  const link = attachmentLinkView(item, attachment, base);
  link.dataset.attachmentId = String(attachment.id);
  link.classList.add('attachment-tile-link');
  const copy = el('span', undefined, 'attachment-tile-copy');
  copy.append(
    el('span', attachment.name, 'attachment-name'),
    el('span', metadata, 'attachment-meta'),
  );
  link.replaceChildren(attachmentFileMark(attachment), copy);
  return link;
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
function attachmentTile(item, attachment, base, metadata, onRemove) {
  const tile = el('div', undefined, 'attachment-tile');
  tile.dataset.attachmentId = String(attachment.id);
  tile.dataset.renderSignature = JSON.stringify({ attachment, metadata });
  tile.append(attachmentTileLink(item, attachment, base, metadata));
  if (onRemove) {
    const actions = el('details', undefined, 'attachment-actions');
    actions.dataset.stateKey = `attachment:${attachment.id}:actions`;
    const toggle = el('summary', '⋯', 'attachment-actions-toggle');
    toggle.setAttribute('aria-label', `Attachment actions for ${attachment.name}`);
    toggle.title = 'Attachment actions';
    const menu = el('div', undefined, 'attachment-actions-menu');
    menu.setAttribute('role', 'menu');
    const remove = button('Remove attachment', onRemove, 'attachment-remove');
    remove.setAttribute('role', 'menuitem');
    remove.dataset.write = 'true';
    menu.append(remove);
    actions.append(toggle, menu);
    tile.append(actions);
  }
  return tile;
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
export function renderItemAttachments(fields, item, readOnly) {
  const currentRoot = state.root;
  const section = el('section', undefined, 'item-attachments');
  section.setAttribute('aria-label', 'Attachments');
  const heading = el('div', undefined, 'section-head');
  const headingTitle = el('div', undefined, 'attachment-heading');
  const count = el('span', '0', 'attachment-count');
  count.setAttribute('aria-hidden', 'true');
  headingTitle.append(attachmentPaperclip(), el('h3', 'Attachments'), count);
  const status = statusLine();
  const list = el('div', undefined, 'attachment-grid');
  let attachmentBusy = false;
  const setStatus = (text, error = false) => setStatusText(status, text, error);
  const onAttachmentsLoaded = (id) => {
    if (id !== item.id) return;
    if (!section.isConnected) {
      attachmentListeners.delete(onAttachmentsLoaded);
      return;
    }
    renderList();
  };
  attachmentListeners.add(onAttachmentsLoaded);
  function renderList() {
    count.textContent = String(attachmentCount(item));
    if (!attachmentsLoaded(item)) {
      list.replaceChildren(emptyState('Loading attachments…'));
      void ensureAttachments(item);
      return;
    }
    const attachments = item.attachments;
    if (!attachments.length) {
      list.replaceChildren(emptyState('No attachments yet.'));
      return;
    }
    const next = attachments.map((attachment) =>
      attachmentTile(
        item,
        attachment,
        currentRoot,
        `${attachmentSize(attachment.size)} · ${memberName(attachment.uploader)}`,
        readOnly ? undefined : () => removeAttachment(attachment),
      ),
    );
    reconcileKeyedChildren(list, next, (node) => `attachment:${node.dataset.attachmentId}`);
  }
  async function removeAttachment(attachment) {
    if (attachmentBusy || !writable()) return;
    attachmentBusy = true;
    setStatus(`Removing ${attachment.name}…`);
    try {
      await api(attachmentHref(item, attachment, currentRoot), {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': state.session.csrf },
      });
      if (state.root !== currentRoot || !section.isConnected) return;
      setItemAttachments(
        item,
        (item.attachments || []).filter((value) => value.id !== attachment.id),
      );
      renderList();
      hooks.renderContent();
      setStatus(item.attachments.length ? 'Attachment removed.' : 'No attachments yet.');
    } catch (error) {
      if (section.isConnected) setStatus(error.message, true);
    } finally {
      attachmentBusy = false;
      if (section.isConnected) renderControls();
    }
  }
  if (!readOnly) {
    const upload = el('div', undefined, 'attachment-upload');
    const hint = el('span', 'Drop files here', 'attachment-drop-hint');
    hint.hidden = true;
    const progress = el('progress', undefined, 'attachment-progress');
    progress.max = 1;
    progress.hidden = true;
    progress.setAttribute('aria-label', 'Upload progress');
    const showProgress = (fraction) => {
      if (fraction === undefined) {
        progress.removeAttribute('value');
      } else {
        progress.value = fraction;
      }
      progress.hidden = false;
    };
    const hideProgress = () => {
      progress.hidden = true;
      progress.value = 0;
    };
    const input = el('input');
    input.type = 'file';
    input.className = 'attachment-file-input';
    input.id = `attachment-file-${requestKey()}`;
    input.tabIndex = -1;
    input.setAttribute('aria-label', 'Attachment file');
    const add = button('Add attachment', () => input.click(), 'attachment-add');
    add.dataset.write = 'true';
    add.setAttribute('aria-controls', input.id);
    add.title = 'Choose a file to attach';
    upload.append(add, hint, progress, input);
    heading.append(headingTitle, upload);
    async function uploadFile(file) {
      add.focus();
      if (attachmentBusy || state.uploadBusy || !writable()) return false;
      const rejection = attachmentRejection(item, file);
      if (rejection) {
        setStatus(rejection, true);
        return false;
      }
      attachmentBusy = true;
      state.uploadBusy = true;
      add.disabled = true;
      setStatus(`Uploading ${file.name}…`);
      showProgress(0);
      let uploaded = false;
      try {
        await uploadItemFile(item, file, (fraction) => {
          if (!section.isConnected) return;
          showProgress(fraction);
          if (fraction !== undefined)
            setStatus(`Uploading ${file.name} · ${Math.round(fraction * 100)}%`);
        });
        if (state.root !== currentRoot || !section.isConnected) return false;
        renderList();
        hooks.renderContent();
        setStatus('Attachment uploaded.');
        uploaded = true;
      } catch (error) {
        if (section.isConnected) setStatus(error.message, true);
      } finally {
        attachmentBusy = false;
        state.uploadBusy = false;
        hideProgress();
        if (section.isConnected) {
          add.disabled = !writable();
          renderControls();
          if (!add.disabled) add.focus();
        }
      }
      return uploaded;
    }
    async function uploadFiles(files) {
      if (attachmentBusy || state.uploadBusy || !writable()) return;
      const selected = Array.from(files || []).filter(Boolean);
      input.value = '';
      if (!selected.length) {
        setStatus('Choose a file first.', true);
        add.focus();
        return;
      }
      let uploaded = 0;
      for (const file of selected) {
        if (!(await uploadFile(file))) break;
        uploaded++;
      }
      if (uploaded > 1 && section.isConnected) setStatus(`${uploaded} attachments uploaded.`);
    }
    input.addEventListener('change', () => {
      void uploadFiles(input.files ? [input.files[0]] : []);
    });
    input.addEventListener('cancel', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (section.isConnected) add.focus();
    });
    const clearAttachmentDrop = () => {
      section.classList.remove('attachment-drop-active');
      hint.hidden = true;
    };
    const showAttachmentDrop = (event) => {
      if (!isFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      if (writable() && !attachmentBusy && !state.uploadBusy) {
        event.dataTransfer.dropEffect = 'copy';
        section.classList.add('attachment-drop-active');
        hint.hidden = false;
      } else {
        event.dataTransfer.dropEffect = 'none';
        clearAttachmentDrop();
      }
    };
    section.addEventListener('dragenter', showAttachmentDrop);
    section.addEventListener('dragover', showAttachmentDrop);
    section.addEventListener('dragleave', (event) => {
      if (
        !event.relatedTarget ||
        !(event.relatedTarget instanceof Node) ||
        !section.contains(event.relatedTarget)
      )
        clearAttachmentDrop();
    });
    section.addEventListener('drop', (event) => {
      if (!isFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      clearAttachmentDrop();
      if (writable() && !attachmentBusy && !state.uploadBusy)
        void uploadFiles(event.dataTransfer.files);
    });
  } else heading.append(headingTitle);
  section.append(heading, status, list);
  fields.append(section);
  renderList();
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
