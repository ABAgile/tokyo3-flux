// The List detail pane for the selected work item.
import { html, nodeOf, replaceContent, unmountIsland } from './preact.js';
import { helpPopover } from './multi-select.js';
import { requestKey } from './api.js';
import { itemPayloadFromForm } from './item-command.js';
import { setErrorText } from './layout.js';
import { state } from './state.js';
import { notice } from './notices.js';
import { renderControls } from './controls.js';
import { receiptRevision, change } from './commands.js';
import { setSharedItem } from './url-state.js';
import { reconcileItemLinks } from './item-links.js';
import { itemEditorDraft, refreshEditorDueBadge, buildItemEditor } from './item-editor.js';

function detailDraftIsDirty(state) {
  if (!state?.form?.isConnected) return false;
  let current;
  try {
    current = itemEditorDraft(state.form);
  } catch {
    return true;
  }
  return (
    JSON.stringify(current) !== JSON.stringify(state.initialDraft) ||
    [...state.form.querySelectorAll('[data-comment-control]')].some((input) =>
      String(input.value || '').trim(),
    )
  );
}
function detailDiscardAllowed() {
  return (
    !state.detailState?.dirty ||
    window.confirm(`Discard unsaved changes to “${state.detailState.item?.title || 'this item'}”?`)
  );
}
export function closeDetail({ force = false, focus = true } = {}) {
  if (state.busy) return false;
  if (!state.detailState) {
    state.selectedItemID = '';
    state.detailPane?.removeAttribute('data-item');
    return true;
  }
  if (!force && !detailDiscardAllowed()) return false;
  const detail = state.detailState;
  state.detailState = undefined;
  state.selectedItemID = '';
  setSharedItem('');
  if (detail.pane) replaceContent(detail.pane);
  if (focus) {
    const target = detail.origin?.isConnected
      ? detail.origin
      : [...document.querySelectorAll('.list-row')].find(
          (row) => row.dataset.item === detail.itemID,
        );
    if (target) target.focus({ preventScroll: true });
  }
  return true;
}
export function selectItem(itemID, origin) {
  if (!state.board || state.view !== 'board' || state.presentation !== 'list') return false;
  if (state.detailState?.itemID === itemID) {
    if (origin) state.detailState.origin = origin;
    state.detailState.form?.querySelector('[name="title"]')?.focus({ preventScroll: true });
    return true;
  }
  if (!closeDetail({ focus: false })) return false;
  const item = state.board.items.find((value) => value.id === itemID);
  if (!item) return false;
  state.selectedItemID = itemID;
  openItemDetail(item, undefined, origin);
  return true;
}
function updateDetailHeader(item) {
  if (!state.detailState?.form || !item) return;
  state.detailState.item = item;
  const title = state.detailState.form.querySelector('.item-detail-title');
  const text = [...(title?.childNodes || [])].find((node) => node.nodeType === Node.TEXT_NODE);
  if (text) text.nodeValue = item.title;
  // The popover is a widget with fixed text, so a new revision gets a new one.
  const previous = title?.querySelector('.help-popover');
  previous?.replaceWith(
    helpPopover(`Card ID: ${item.id}\nRevision: ${item.revision}`, 'Work item details'),
  );
  // nodeOf roots can remove their own host during disposal. Replace the node
  // first, while it still has a parent, then release its controller.
  unmountIsland(previous);
}
// The form skeleton is rendered once per opened item and is then plain DOM:
// the title text, the head's due badge, the footer's item actions and the
// error line are written directly. The fields inside are a Preact template
// (buildItemEditor).
function detailFormTemplate(item, readOnly) {
  return html`<form class="item-detail-form">
    <div class="item-detail-head">
      <h2 class="item-detail-title">${item.title}</h2>
      <div class="item-detail-head-actions">
        <button
          type="button"
          class="item-detail-close"
          aria-label="Close item details"
          onClick=${() => closeDetail()}
        >×</button>
      </div>
    </div>
    <div class="item-detail-fields"></div>
    <p class="item-detail-error" role="alert" hidden></p>
    <div class="item-detail-footer">
      <button type="button" class="detail-cancel" onClick=${() => closeDetail()}>Cancel</button>
      <button type="submit" class="primary" data-write="true" hidden=${readOnly}>Save changes</button>
    </div>
  </form>`;
}
export function openItemDetail(item, draft, origin) {
  if (!state.detailPane) return;
  const readOnly = state.board.role === 'viewer' || item.archived;
  const form = nodeOf(detailFormTemplate(item, readOnly));
  const title = form.querySelector('.item-detail-title');
  const close = form.querySelector('.item-detail-close');
  const fields = form.querySelector('.item-detail-fields');
  const error = form.querySelector('.item-detail-error');
  const footer = form.querySelector('.item-detail-footer');
  const cancel = footer.querySelector('.detail-cancel');
  const save = footer.querySelector('[type="submit"]');
  replaceContent(state.detailPane, form);
  const context = { mode: 'detail', form, footer, origin };
  const refreshEditor = buildItemEditor(fields, item, draft, readOnly, context, title);
  let revision = state.board.workspace.revision;
  let pending, key;
  state.detailState = {
    itemID: item.id,
    item,
    itemRevision: item.revision,
    form,
    pane: state.detailPane,
    origin,
    dirty: false,
    focusOnOpen: true,
    initialDraft: null,
  };
  const detail = state.detailState;
  setSharedItem(item.id);
  const updateDirty = () => {
    if (state.detailState === detail) detail.dirty = detailDraftIsDirty(detail);
  };
  form.addEventListener('input', updateDirty);
  form.addEventListener('change', updateDirty);
  detail.initialDraft = itemEditorDraft(form);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (readOnly || state.busy || state.detailState !== detail) return;
    setErrorText(error, '');
    save.disabled = true;
    cancel.disabled = true;
    close.disabled = true;
    revision = state.board.workspace.revision;
    const data = new FormData(form);
    const desired = data.getAll('link_ids');
    detail.desiredLinkIDs = desired;
    const command = {
      revision,
      kind: 'item.update',
      target: item.id,
      item: { ...itemPayloadFromForm(data, detail.item), revision: detail.itemRevision },
    };
    const serialized = JSON.stringify(command);
    if (pending !== serialized) {
      key = requestKey();
      pending = serialized;
    }
    try {
      const result = await change(command, key);
      if (!result.refreshed)
        throw new Error(
          'Changes were saved, but the board could not be refreshed. Refresh before continuing.',
        );
      revision = receiptRevision(result.receipt, revision + 1);
      await reconcileItemLinks(item.id, detail.desiredLinkIDs || []);
      if (state.detailState !== detail || !state.board) return;
      const latest = state.board.items.find((value) => value.id === item.id);
      if (!latest) {
        closeDetail({ force: true });
        return;
      }
      detail.item = latest;
      detail.itemRevision = latest.revision;
      revision = state.board.workspace.revision;
      detail.initialDraft = itemEditorDraft(form);
      detail.dirty = false;
      updateDetailHeader(latest);
      refreshEditor(latest);
      refreshEditorDueBadge(form, latest);
      notice('Changes saved.');
    } catch (err) {
      if (state.detailState === detail) {
        detail.dirty = true;
        setErrorText(
          error,
          `${err.message} Your input is retained. For a revision conflict, copy your changes, close, refresh, and reopen before retrying.`,
        );
      }
    } finally {
      if (state.detailState === detail && form.isConnected) {
        save.disabled = false;
        cancel.disabled = false;
        close.disabled = false;
        renderControls();
      }
    }
  });
}
