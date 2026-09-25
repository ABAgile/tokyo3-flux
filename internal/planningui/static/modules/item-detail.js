// The List detail pane for the selected work item.
import { el, button } from './dom.js';
import { requestKey } from './api.js';
import { itemPayloadFromForm } from './item-command.js';
import { errorLine, setErrorText } from './layout.js';
import { state } from './state.js';
import { notice } from './notices.js';
import { renderControls } from './controls.js';
import { receiptRevision, change } from './commands.js';
import { setSharedItem } from './url-state.js';
import { reconcileItemLinks } from './item-links.js';
import {
  itemEditorDraft,
  refreshItemStatusSummary,
  refreshEditorDueBadge,
  buildItemEditor,
} from './item-editor.js';

export function createDetailPane() {
  const pane = el('aside', undefined, 'item-detail-pane');
  pane.hidden = true;
  pane.setAttribute('aria-label', 'Selected work item');
  state.detailPane = pane;
  return pane;
}
export function syncListSelection() {
  document.querySelectorAll('.list-row').forEach((row) => {
    const selected = row.dataset.item === state.selectedItemID;
    row.classList.toggle('is-selected', selected);
    if (selected) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  });
}
export function updateDetailPaneVisibility() {
  if (!state.detailPane) return;
  const open =
    !!state.detailState &&
    state.detailState.pane === state.detailPane &&
    !!state.selectedItemID &&
    state.detailState.form?.isConnected;
  state.detailPane.hidden = !open;
  state.detailPane.parentElement?.classList.toggle('has-detail', open);
  syncListSelection();
}
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
    updateDetailPaneVisibility();
    return true;
  }
  if (!force && !detailDiscardAllowed()) return false;
  const detail = state.detailState;
  state.detailState = undefined;
  state.selectedItemID = '';
  setSharedItem('');
  if (detail.pane) {
    detail.pane.hidden = true;
    detail.pane.replaceChildren();
    detail.pane.parentElement?.classList.remove('has-detail');
  }
  syncListSelection();
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
  if (title?.firstChild) title.firstChild.nodeValue = item.title;
  const help = title?.querySelector('.help-popover-content');
  if (help) help.textContent = `Card ID: ${item.id}\nRevision: ${item.revision}`;
}
export function openItemDetail(item, draft, origin) {
  if (!state.detailPane) return;
  const readOnly = state.board.role === 'viewer' || item.archived;
  const form = el('form', undefined, 'item-detail-form');
  const heading = el('div', undefined, 'item-detail-head');
  const title = el('h2', item.title, 'item-detail-title');
  const actions = el('div', undefined, 'item-detail-head-actions');
  const close = button('×', () => closeDetail(), 'item-detail-close');
  close.setAttribute('aria-label', 'Close item details');
  actions.append(close);
  heading.append(title, actions);
  const fields = el('div', undefined, 'item-detail-fields');
  const error = errorLine('', 'item-detail-error');
  const footer = el('div', undefined, 'item-detail-footer');
  const cancel = button('Cancel', () => closeDetail(), 'detail-cancel');
  const save = button('Save changes', undefined, 'primary');
  save.type = 'submit';
  save.dataset.write = 'true';
  footer.append(cancel, save);
  form.append(heading, fields, error, footer);
  state.detailPane.replaceChildren(form);
  state.detailPane.hidden = false;
  const context = { mode: 'detail', form, footer, origin };
  buildItemEditor(fields, item, draft, readOnly, context, title);
  if (readOnly) {
    fields
      .querySelectorAll(
        'input:not([data-comment-control]),textarea:not([data-comment-control]),select:not([data-comment-control])',
      )
      .forEach((input) => {
        input.disabled = true;
      });
    fields.querySelectorAll('[data-multi-edit],[data-multi-remove]').forEach((input) => {
      input.disabled = true;
    });
  }
  save.hidden = readOnly;
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
  updateDetailPaneVisibility();
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
      refreshItemStatusSummary(form, latest);
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
  const titleInput = form.querySelector('[name="title"]');
  if (titleInput) titleInput.focus({ preventScroll: true });
}
