// The List detail pane for the selected work item.
import { html } from './vdom.js';
import { useLayoutEffect, useMemo, useRef, useState } from './vendor-preact.js';
import { requestKey } from './api.js';
import { itemPayloadFromForm } from './item-command.js';
import { state, setState, useStore } from './state.js';
import { uid } from './dom.js';
import { hooks } from './hooks.js';
import { notice } from './notices.js';
import { change } from './commands.js';
import { setSharedItem } from './url-state.js';
import { reconcileItemLinks } from './item-links.js';
import {
  itemEditorDraft,
  itemEditorTemplate,
  itemEditorTitleExtrasTemplate,
  itemEditorFooterActionsTemplate,
} from './item-editor.js';
import { EditorDueBadge } from './due-dates.js';

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
    setState({ selectedItemID: '', detailError: '' });
    return true;
  }
  if (!force && !detailDiscardAllowed()) return false;
  const detail = state.detailState;
  setState({ detailState: undefined, selectedItemID: '', detailError: '' });
  setSharedItem('');
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
function selectDetailBusy(current) {
  return current.busy;
}
function selectDetailError(current) {
  return current.detailError;
}
// The form tree is a stable Preact snapshot for each form lifetime. Reuse the
// editor VNodes across unrelated shell updates so uncontrolled drafts and local
// field widgets keep their state.
export function ItemDetailPane({ detail }) {
  const formRef = useRef();
  const pending = useRef({ serialized: '', key: '' });
  const busy = useStore(selectDetailBusy);
  const error = useStore(selectDetailError);
  const [dueBadgeID] = useState(() => uid('item-title-overdue'));
  const context = useMemo(
    () => ({
      mode: 'detail',
      get form() {
        return formRef.current;
      },
      get origin() {
        return state.detailState?.origin;
      },
    }),
    [detail?.formKey],
  );
  const item = detail?.item;
  const readOnly = !item || !state.board || state.board.role === 'viewer' || item.archived;
  const editor = useMemo(
    () =>
      item && state.board
        ? itemEditorTemplate(item, detail.draft, readOnly, context, dueBadgeID)
        : null,
    [detail?.formKey, item, detail?.itemRevision, detail?.draft, readOnly, context, dueBadgeID],
  );
  const titleExtras = useMemo(
    () => (item?.id ? itemEditorTitleExtrasTemplate(item, detail.itemRevision) : null),
    [detail?.formKey, item, detail?.itemRevision],
  );
  const footerAction = useMemo(
    () => (item ? itemEditorFooterActionsTemplate(item, readOnly, context) : null),
    [detail?.formKey, item, readOnly, context, state.board],
  );
  useLayoutEffect(() => {
    const form = formRef.current;
    if (!detail || !form || state.detailState !== detail) return;
    detail.form = form;
    detail.initialDraft = itemEditorDraft(form);
    if (detail.focusOnOpen) {
      detail.focusOnOpen = false;
      form.querySelector('[name="title"]')?.focus({ preventScroll: true });
    }
  }, [detail?.formKey]);
  if (!detail || !item || !state.board) return null;
  const updateDirty = () => {
    if (state.detailState === detail) detail.dirty = detailDraftIsDirty(detail);
  };
  async function onSubmit(event) {
    event.preventDefault();
    const form = formRef.current;
    if (readOnly || state.busy || state.detailState !== detail || !form) return;
    setState({ detailError: '' });
    const revision = state.board.workspace.revision;
    const data = new FormData(form);
    detail.desiredLinkIDs = data.getAll('link_ids');
    const command = {
      revision,
      kind: 'item.update',
      target: item.id,
      item: { ...itemPayloadFromForm(data, detail.item), revision: detail.itemRevision },
    };
    const serialized = JSON.stringify(command);
    if (pending.current.serialized !== serialized) {
      pending.current = { serialized, key: requestKey() };
    }
    try {
      const result = await change(command, pending.current.key);
      if (!result.refreshed)
        throw new Error(
          'Changes were saved, but the board could not be refreshed. Refresh before continuing.',
        );
      await reconcileItemLinks(item.id, detail.desiredLinkIDs || []);
      if (state.detailState !== detail || !state.board) return;
      const latest = state.board.items.find((value) => value.id === item.id);
      if (!latest) {
        closeDetail({ force: true });
        return;
      }
      detail.item = latest;
      detail.itemRevision = latest.revision;
      detail.draft = undefined;
      detail.initialDraft = itemEditorDraft(form);
      detail.dirty = false;
      setState({ detailError: '' });
      hooks.render();
      notice('Changes saved.');
    } catch (submitError) {
      if (state.detailState === detail) {
        detail.dirty = true;
        setState({
          detailError: `${submitError.message} Your input is retained. For a revision conflict, copy your changes, close, refresh, and reopen before retrying.`,
        });
      }
    }
  }
  return html`<form
    class="item-detail-form"
    ref=${formRef}
    onInput=${updateDirty}
    onChange=${updateDirty}
    onSubmit=${onSubmit}
  >
    <div class="item-detail-head">
      <h2 class="item-detail-title">${item.title}${titleExtras}</h2>
      <${EditorDueBadge} item=${item} id=${dueBadgeID} />
      <div class="item-detail-head-actions">
        <button
          type="button"
          class="item-detail-close"
          aria-label="Close item details"
          disabled=${busy}
          onClick=${() => closeDetail()}
        >×</button>
      </div>
    </div>
    <div class="item-detail-fields">${editor}</div>
    <p class="item-detail-error" role="alert" hidden=${!error}>${error}</p>
    <div class="item-detail-footer">
      ${footerAction}
      <button type="button" class="detail-cancel" disabled=${busy} onClick=${() => closeDetail()}>Cancel</button>
      ${!readOnly ? html`<button type="submit" class="primary" data-write="true" disabled=${busy}>Save changes</button>` : null}
    </div>
  </form>`;
}
export function openItemDetail(item, draft, origin) {
  if (!state.detailPane || !state.board) return;
  setState({
    selectedItemID: item.id,
    detailError: '',
    detailState: {
      itemID: item.id,
      formKey: requestKey(),
      item,
      itemRevision: item.revision,
      draft,
      pane: state.detailPane,
      origin,
      dirty: false,
      focusOnOpen: true,
      initialDraft: null,
    },
  });
  setSharedItem(item.id);
}
