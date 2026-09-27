// Item comments: list, paging and composer.
import { api, requestKey } from './api.js';
import { initials } from './format.js';
import { markdownTemplate, markdownEditorTemplate } from './markdown.js';
import { panelHeadTemplate, helpTextTemplate } from './layout.js';
import { html } from './vdom.js';
import { useEffect, useReducer, useRef, useState } from './vendor-preact.js';

import { state, useStore } from './state.js';
import { selectLookups } from './lookups.js';
import { canComment, usePermissions } from './permissions.js';
import { memberInfo, avatarImageTemplate } from './people.js';
import { useCommittedChange, useMutation, useRequest } from './ui-hooks.js';

function commentTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { label: 'Unknown time', dateTime: '' };
  return { label: date.toLocaleString(), dateTime: date.toISOString() };
}
const COMMENT_PAGE_LIMIT = 100;
function validComment(comment) {
  return (
    comment &&
    Number.isSafeInteger(comment.id) &&
    comment.id > 0 &&
    typeof comment.item_id === 'string' &&
    typeof comment.author === 'string' &&
    comment.author &&
    typeof comment.body === 'string' &&
    comment.body &&
    typeof comment.created_at === 'string' &&
    !Number.isNaN(Date.parse(comment.created_at))
  );
}
function validCommentPage(data) {
  return (
    data &&
    Array.isArray(data.comments) &&
    data.comments.every(validComment) &&
    (data.next_before === undefined ||
      (Number.isSafeInteger(data.next_before) && data.next_before >= 0))
  );
}
function commentTemplate(lookups, comment) {
  const info = memberInfo(lookups, comment.author);
  const time = commentTime(comment.created_at);
  return html`<article class="comment" data-comment-id=${String(comment.id)}>
    <span class="avatar comment-avatar" aria-hidden="true">
      <span class="avatar-fallback">${initials(info.name)}</span>
      ${avatarImageTemplate(info.avatarURL)}
    </span>
    <div class="comment-content">
      <div class="comment-head">
        <strong title=${comment.author}>${info.name}</strong>
        <time class="muted" datetime=${time.dateTime || null}>${time.label}</time>
      </div>
      <div class="comment-body">${markdownTemplate(comment.body)}</div>
    </div>
  </article>`;
}
function CommentItem({ lookups, comment }) {
  return commentTemplate(lookups, comment);
}
function commentsReducer(current, action) {
  switch (action.type) {
    case 'loading':
      return { ...current, olderDisabled: true, status: 'Loading comments…', error: false };
    case 'loaded': {
      const comments = action.append ? [...action.comments, ...current.comments] : action.comments;
      const nextBefore = action.nextBefore || 0;
      return {
        ...current,
        comments,
        nextBefore,
        olderDisabled: false,
        status: comments.length
          ? `${comments.length}${nextBefore ? '+' : ''} comment${comments.length === 1 ? '' : 's'} loaded.`
          : 'No comments yet.',
        error: false,
      };
    }
    case 'failed':
      return { ...current, olderDisabled: false, status: action.message, error: true };
    case 'status':
      return { ...current, status: action.text || '', error: !!action.error };
    case 'draft':
      return { ...current, draft: action.draft };
    default:
      return current;
  }
}
async function commentPage(root, itemID, before, signal) {
  const query = new URLSearchParams({ limit: String(COMMENT_PAGE_LIMIT) });
  if (before) query.set('before', String(before));
  const page = await api(`${root}/items/${encodeURIComponent(itemID)}/comments?${query}`, {
    signal,
  });
  if (!validCommentPage(page)) throw new Error('Comments are invalid. Reopen the item to retry.');
  return page;
}
// The component owns comment paging, status and the controlled composer. It is
// keyed by workspace root and item, so a switch remounts it and every pending
// read or write is aborted rather than applied to another context.
function ItemComments({ item, onDraftChange }) {
  const [currentRoot] = useState(() => state.root);
  const [local, dispatch] = useReducer(commentsReducer, {
    comments: [],
    nextBefore: 0,
    olderDisabled: true,
    status: 'Loading comments…',
    error: false,
    draft: '',
  });
  const [reload, setReload] = useState(0);
  const [before, setBefore] = useState(0);
  const pending = useRef({ body: '', key: '' });
  const composer = useRef(null);
  const writes = useMutation();
  const { comment: allowed } = usePermissions();
  const lookups = useStore(selectLookups);
  // The enclosing editor counts an unsent comment as unsaved input.
  useCommittedChange(local.draft, onDraftChange);
  const writer = state.board.role === 'member' || state.board.role === 'admin';
  // One request per page. Loading older comments appends; a reload after a new
  // comment replaces the list.
  const page = useRequest(
    (signal) => {
      dispatch({ type: 'loading' });
      return commentPage(currentRoot, item.id, before, signal);
    },
    [currentRoot, item.id, before, reload],
  );
  useEffect(() => {
    if (page.data)
      dispatch({
        type: 'loaded',
        comments: page.data.comments,
        nextBefore: page.data.next_before,
        append: before > 0,
      });
    else if (page.error) dispatch({ type: 'failed', message: page.error.message });
  }, [page.data, page.error]);
  async function addComment() {
    if (!canComment()) return;
    const body = local.draft.trim();
    if (!body) {
      dispatch({ type: 'status', text: 'Comment cannot be empty.', error: true });
      composer.current?.focus();
      return;
    }
    if (body !== pending.current.body) pending.current = { body, key: requestKey() };
    await writes.run(async (signal) => {
      dispatch({ type: 'status', text: 'Adding comment…' });
      try {
        await api(`${currentRoot}/items/${encodeURIComponent(item.id)}/comments`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': state.session.csrf,
            'Idempotency-Key': pending.current.key,
          },
          body: JSON.stringify({ body }),
          signal,
        });
        if (signal.aborted) return;
        pending.current = { body: '', key: '' };
        dispatch({ type: 'draft', draft: '' });
        setBefore(0);
        setReload((value) => value + 1);
      } catch (error) {
        if (!signal.aborted) dispatch({ type: 'status', text: error.message, error: true });
      }
    });
  }
  const { comments, nextBefore, status, error, olderDisabled, draft } = local;
  return html`<section class="item-comments">
    ${panelHeadTemplate('Comments')}
    <p
      class=${error ? 'help error' : 'help'}
      data-status-class="help"
      hidden=${!status}
      role=${error ? 'alert' : 'status'}
      aria-live="polite"
    >${status}</p>
    <button
      type="button"
      class="comment-load-older"
      hidden=${!nextBefore}
      disabled=${olderDisabled}
      onClick=${() => {
        if (nextBefore && !writes.pending) setBefore(nextBefore);
      }}
    >Load older comments</button>
    <div class="comment-list">${comments.map((comment) => html`<${CommentItem} key=${comment.id} lookups=${lookups} comment=${comment} />`)}</div>
    ${
      writer
        ? html`<div class="comment-composer">
            ${markdownEditorTemplate('comment_body', 'Add a comment', draft, 4000, false, false, {
              commentControl: true,
              inputRef: composer,
              onValueChange: (value) => dispatch({ type: 'draft', draft: value }),
            })}
            <button
              type="button"
              class="primary"
              data-comment-write="true"
              disabled=${writes.pending || !allowed}
              onClick=${addComment}
            >Add comment</button>
          </div>`
        : helpTextTemplate('Viewers can read comments; members and admins can add them.')
    }
  </section>`;
}
export function itemCommentsTemplate(item, onDraftChange) {
  return html`<${ItemComments}
    key=${`${state.root}:${item.id}`}
    item=${item}
    onDraftChange=${onDraftChange}
  />`;
}
