// Item comments: list, paging and composer.
import { api, requestKey } from './api.js';
import { syncDisabled } from './dom.js';
import { initials } from './format.js';
import { markdownTemplate, markdownEditorTemplate } from './markdown.js';
import { panelHeadTemplate, helpTextTemplate } from './layout.js';
import { html, keyedList } from './vdom.js';
import { useEffect, useLayoutEffect, useRef, useState } from './vendor-preact.js';

import { state } from './state.js';
import { canComment } from './permissions.js';
import { renderControls } from './controls.js';
import { memberInfo, avatarImageTemplate } from './people.js';

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
function commentTemplate(comment) {
  const info = memberInfo(comment.author);
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
// The component owns comment paging, status and submission state. Its request
// generation guard prevents stale pages from replacing a newer item context.
function ItemComments({ item }) {
  const [currentRoot] = useState(() => state.root);
  const [local, setLocal] = useState({
    comments: [],
    nextBefore: 0,
    olderDisabled: true,
    busy: false,
    status: 'Loading comments…',
    error: false,
  });
  // Ref updates synchronously so repeated native events cannot race a state commit.
  const localRef = useRef(local);
  localRef.current = local;
  const active = useRef(false);
  const commentLoad = useRef(0);
  const pending = useRef({ body: '', key: '' });
  const editor = useRef();
  const writer = state.board.role === 'member' || state.board.role === 'admin';
  const updateLocal = (next) => {
    const value = typeof next === 'function' ? next(localRef.current) : next;
    localRef.current = value;
    setLocal(value);
  };
  const setStatus = (text, error = false) =>
    updateLocal({ ...localRef.current, status: text || '', error });
  async function loadComments(before = 0, append = false) {
    const loadID = ++commentLoad.current;
    updateLocal({
      ...localRef.current,
      olderDisabled: true,
      status: 'Loading comments…',
      error: false,
    });
    try {
      const query = new URLSearchParams({ limit: String(COMMENT_PAGE_LIMIT) });
      if (before) query.set('before', String(before));
      const page = await api(
        `${currentRoot}/items/${encodeURIComponent(item.id)}/comments?${query}`,
      );
      if (loadID !== commentLoad.current || state.root !== currentRoot || !active.current)
        return false;
      if (!validCommentPage(page))
        throw new Error('Comments are invalid. Reopen the item to retry.');
      const comments = append ? [...page.comments, ...localRef.current.comments] : page.comments;
      const nextBefore = page.next_before || 0;
      updateLocal({
        ...localRef.current,
        comments,
        nextBefore,
        olderDisabled: false,
        status: comments.length
          ? `${comments.length}${nextBefore ? '+' : ''} comment${comments.length === 1 ? '' : 's'} loaded.`
          : 'No comments yet.',
        error: false,
      });
      return true;
    } catch (error) {
      if (loadID === commentLoad.current && state.root === currentRoot && active.current) {
        updateLocal({
          ...localRef.current,
          olderDisabled: false,
          status: error.message,
          error: true,
        });
      }
      return false;
    }
  }
  async function addComment() {
    if (localRef.current.busy || !canComment()) return;
    const textarea = editor.current?.input;
    if (!textarea) return;
    const body = textarea.value.trim();
    if (!body) {
      setStatus('Comment cannot be empty.', true);
      textarea.focus();
      return;
    }
    if (body !== pending.current.body) pending.current = { body, key: requestKey() };
    updateLocal({ ...localRef.current, busy: true, status: 'Adding comment…', error: false });
    commentLoad.current++;
    try {
      await api(`${currentRoot}/items/${encodeURIComponent(item.id)}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': state.session.csrf,
          'Idempotency-Key': pending.current.key,
        },
        body: JSON.stringify({ body }),
      });
      if (state.root !== currentRoot || !active.current) return;
      pending.current = { body: '', key: '' };
      textarea.value = '';
      editor.current.refresh();
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await loadComments();
    } catch (error) {
      if (state.root === currentRoot && active.current) setStatus(error.message, true);
    } finally {
      if (active.current) {
        updateLocal({ ...localRef.current, busy: false });
        renderControls();
      }
    }
  }
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      commentLoad.current++;
    };
  }, []);
  useEffect(() => {
    void loadComments();
  }, []);
  const { comments, nextBefore, status, error, olderDisabled, busy } = local;
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
        if (localRef.current.nextBefore && !localRef.current.busy)
          void loadComments(localRef.current.nextBefore, true);
      }}
    >Load older comments</button>
    <div class="comment-list">${keyedList(comments, (comment) => comment.id, commentTemplate)}</div>
    ${
      writer
        ? html`<div class="comment-composer">
            ${markdownEditorTemplate('comment_body', 'Add a comment', '', 4000, false, false, {
              commentControl: true,
              onReady: (ready) => {
                editor.current = ready;
              },
            })}
            <button
              type="button"
              class="primary"
              data-comment-write="true"
              ref=${syncDisabled(busy || !canComment())}
              onClick=${addComment}
            >Add comment</button>
          </div>`
        : helpTextTemplate('Viewers can read comments; members and admins can add them.')
    }
  </section>`;
}
export function itemCommentsTemplate(item) {
  return html`<${ItemComments} key=${item.id} item=${item} />`;
}
