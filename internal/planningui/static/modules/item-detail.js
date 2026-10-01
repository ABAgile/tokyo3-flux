// The List detail pane for the selected work item.
import { html } from './vdom.js';
import { useId, useLayoutEffect, useRef } from './vendor-preact.js';
import { errorMessage, requestKey } from './api.js';
import { itemPayloadFromForm } from './item-command.js';
import { state, setState, useStore, requireBoard } from './state.js';
import { notice } from './notices.js';
import { change } from './commands.js';
import { reconcileItemLinks } from './item-links.js';
import {
  ItemEditorFields,
  ItemFooterActions,
  confirmSaveBeforeClose,
  draftSignature,
  editorDirty,
  itemEditorDraft,
  itemEditorTitleExtrasTemplate,
} from './item-editor.js';
import { EditorDueBadge } from './due-dates.js';
import { closeDetail, setDetailDirty } from './actions.js';
import { useEventListener } from './ui-hooks.js';

/** @param {Flux.State} current */
function selectBusy(current) {
  return current.busy;
}
/** @param {Flux.State} current */
function selectDetailError(current) {
  return current.detailError;
}
/** @param {Flux.State} current */
function selectRole(current) {
  return current.board?.role;
}
// Controls and rows own their clicks (list rows select their card, which asks
// before discarding), and a dialog opened from the pane is not "outside".
const OWN_CLICK = 'a,button,input,select,textarea,summary,label,dialog,.list-row';
// One form lifetime per opened card: the pane is keyed by the detail's form
// key, so native drafts and widget state survive unrelated renders. Its input
// and change handlers report whether the draft differs from what was opened.
/** @param {{ detail: Flux.Detail }} props */
export function ItemDetailPane({ detail }) {
  const form = useRef(/** @type {HTMLFormElement | null} */ (null));
  const title = useRef(/** @type {HTMLInputElement | null} */ (null));
  const initial = useRef('');
  const pending = useRef({ serialized: '', key: '' });
  const pressedOutside = useRef(false);
  const busy = useStore(selectBusy);
  const error = useStore(selectDetailError);
  const role = useStore(selectRole);
  const dueBadgeID = `item-title-overdue-${useId()}`;
  const item = detail.item;
  const readOnly = !role || role === 'viewer' || !!item.archived;
  useLayoutEffect(() => {
    initial.current = draftSignature(form.current);
  }, []);
  useLayoutEffect(() => {
    if (detail.focusNonce) title.current?.focus({ preventScroll: true });
  }, [detail.focusNonce]);
  const checkDirty = () => {
    const node = form.current;
    if (!node) return;
    setDetailDirty(detail.formKey, editorDirty(node, initial.current));
  };
  const getDraft = () => (form.current ? itemEditorDraft(form.current) : undefined);
  // A press and click that both land outside the pane close it; unsaved input
  // is saved first, after the user agrees.
  useEventListener(document, 'pointerdown', (event) => {
    pressedOutside.current = !form.current?.contains(/** @type {Node | null} */ (event.target));
  });
  useEventListener(document, 'click', (event) => {
    const node = form.current;
    const target = /** @type {Element | null} */ (event.target);
    if (!node || !pressedOutside.current || state.busy || !target?.isConnected) return;
    if (node.contains(target) || target.closest?.(OWN_CLICK)) return;
    if (!detail.dirty) closeDetail();
    else if (!readOnly && confirmSaveBeforeClose(node, item.title)) node.requestSubmit();
  });
  async function onSubmit(/** @type {SubmitEvent} */ event) {
    event.preventDefault();
    const node = form.current;
    if (readOnly || state.busy || state.detail?.formKey !== detail.formKey || !node) return;
    setState({ detailError: '' });
    const data = new FormData(node);
    const desiredLinkIDs = data.getAll('link_ids');
    const command = {
      revision: requireBoard().workspace.revision,
      kind: 'item.update',
      target: item.id,
      item: { ...itemPayloadFromForm(data, item), revision: detail.itemRevision },
    };
    const serialized = JSON.stringify(command);
    if (pending.current.serialized !== serialized)
      pending.current = { serialized, key: requestKey() };
    try {
      const result = await change(command, pending.current.key);
      if (!result.refreshed)
        throw new Error(
          'Changes were saved, but the board could not be refreshed. Refresh before continuing.',
        );
      await reconcileItemLinks(item.id, desiredLinkIDs);
      const current = state.detail;
      if (current?.formKey !== detail.formKey || !state.board) return;
      notice('Changes saved.');
      closeDetail({ force: true });
    } catch (submitError) {
      const current = state.detail;
      if (current?.formKey === detail.formKey)
        setState({
          detail: { ...current, dirty: true },
          detailError: `${errorMessage(submitError)} Your input is retained. For a revision conflict, copy your changes, close, refresh, and reopen before retrying.`,
        });
    }
  }
  return html`<form
    class="item-detail-form"
    ref=${form}
    onInput=${checkDirty}
    onChange=${checkDirty}
    onSubmit=${onSubmit}
  >
    <div class="item-detail-head">
      <h2 class="item-detail-title">${item.title}${itemEditorTitleExtrasTemplate(item, detail.itemRevision)}</h2>
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
    <div class="item-detail-fields"><${ItemEditorFields}
      item=${item}
      draft=${detail.draft}
      readOnly=${readOnly}
      mode="detail"
      dueBadgeID=${dueBadgeID}
      titleRef=${title}
      getDraft=${getDraft}
      originFocusKey=${detail.originFocusKey}
      onChange=${checkDirty}
    /></div>
    <p class="item-detail-error" role="alert" hidden=${!error}>${error}</p>
    <div class="item-detail-footer">
      <${ItemFooterActions} item=${item} readOnly=${readOnly} mode="detail" />
      <button type="button" class="detail-cancel" disabled=${busy} onClick=${() => closeDetail()}>Cancel</button>
      ${!readOnly ? html`<button type="submit" class="primary" data-write="true" disabled=${busy}>Save changes</button>` : null}
    </div>
  </form>`;
}
