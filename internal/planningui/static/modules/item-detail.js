// The List detail pane for the selected work item.
import { html } from './vdom.js';
import { useId, useLayoutEffect, useRef } from './vendor-preact.js';
import { requestKey } from './api.js';
import { itemPayloadFromForm } from './item-command.js';
import { state, setState, useStore } from './state.js';
import { notice } from './notices.js';
import { change } from './commands.js';
import { reconcileItemLinks } from './item-links.js';
import {
  ItemEditorFields,
  ItemFooterActions,
  itemEditorDraft,
  itemEditorTitleExtrasTemplate,
} from './item-editor.js';
import { EditorDueBadge } from './due-dates.js';
import { closeDetail, setDetailDirty } from './actions.js';

function draftSignature(form) {
  try {
    return JSON.stringify(itemEditorDraft(form));
  } catch {
    return '';
  }
}
function selectBusy(current) {
  return current.busy;
}
function selectDetailError(current) {
  return current.detailError;
}
function selectRole(current) {
  return current.board?.role;
}
// One form lifetime per opened card: the pane is keyed by the detail's form
// key, so native drafts and widget state survive unrelated renders. Its input
// and change handlers report whether the draft differs from what was opened.
export function ItemDetailPane({ detail }) {
  const form = useRef(null);
  const title = useRef(null);
  const initial = useRef('');
  const pending = useRef({ serialized: '', key: '' });
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
    const comment = String(new FormData(node).get('comment_body') || '').trim();
    setDetailDirty(detail.formKey, draftSignature(node) !== initial.current || !!comment);
  };
  const getDraft = () => (form.current ? itemEditorDraft(form.current) : undefined);
  async function onSubmit(event) {
    event.preventDefault();
    const node = form.current;
    if (readOnly || state.busy || state.detail?.formKey !== detail.formKey || !node) return;
    setState({ detailError: '' });
    const data = new FormData(node);
    const desiredLinkIDs = data.getAll('link_ids');
    const command = {
      revision: state.board.workspace.revision,
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
      const latest = state.board.items.find((value) => value.id === item.id);
      if (!latest) {
        closeDetail({ force: true });
        return;
      }
      initial.current = draftSignature(node);
      setState({
        detail: {
          ...current,
          item: latest,
          itemRevision: latest.revision,
          draft: undefined,
          dirty: false,
        },
        detailError: '',
      });
      notice('Changes saved.');
    } catch (submitError) {
      const current = state.detail;
      if (current?.formKey === detail.formKey)
        setState({
          detail: { ...current, dirty: true },
          detailError: `${submitError.message} Your input is retained. For a revision conflict, copy your changes, close, refresh, and reopen before retrying.`,
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
