// Item comments: list, paging and composer.
import { api, requestKey } from './api.js';
import { initials } from './format.js';
import { markdownTemplate, markdownEditorTemplate } from './markdown.js';
import { panelHeadTemplate, helpTextTemplate } from './layout.js';
import { attach, html, live, nothing, render, repeat } from './lit.js';
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
        <time class="muted" datetime=${time.dateTime || nothing}>${time.label}</time>
      </div>
      <div class="comment-body">${markdownTemplate(comment.body)}</div>
    </div>
  </article>`;
}
// Comments are a stateful widget: the list, paging and composer state live in
// a local object, and the widget renders itself with lit into its section.
function mountComments(section, item) {
  const currentRoot = state.root;
  const local = {
    comments: [],
    nextBefore: 0,
    olderDisabled: true,
    busy: false,
    status: 'Loading comments…',
    error: false,
  };
  let commentLoad = 0,
    pendingCommentBody = '',
    pendingCommentKey = '',
    editor;
  const writer = state.board.role === 'member' || state.board.role === 'admin';
  const setStatus = (text, error = false) => {
    local.status = text || '';
    local.error = error;
    update();
  };
  async function loadComments(before = 0, append = false) {
    const loadID = ++commentLoad;
    local.olderDisabled = true;
    setStatus('Loading comments…');
    try {
      const query = new URLSearchParams({ limit: String(COMMENT_PAGE_LIMIT) });
      if (before) query.set('before', String(before));
      const page = await api(
        `${currentRoot}/items/${encodeURIComponent(item.id)}/comments?${query}`,
      );
      if (loadID !== commentLoad || state.root !== currentRoot || !section.isConnected)
        return false;
      if (!validCommentPage(page))
        throw new Error('Comments are invalid. Reopen the item to retry.');
      local.comments = append ? [...page.comments, ...local.comments] : page.comments;
      local.nextBefore = page.next_before || 0;
      local.olderDisabled = false;
      const count = local.comments.length;
      setStatus(
        count
          ? `${count}${local.nextBefore ? '+' : ''} comment${count === 1 ? '' : 's'} loaded.`
          : 'No comments yet.',
      );
      return true;
    } catch (error) {
      if (loadID === commentLoad && state.root === currentRoot && section.isConnected) {
        local.olderDisabled = false;
        setStatus(error.message, true);
      }
      return false;
    }
  }
  async function addComment() {
    if (local.busy || !canComment()) return;
    const textarea = editor.input;
    const body = textarea.value.trim();
    if (!body) {
      setStatus('Comment cannot be empty.', true);
      textarea.focus();
      return;
    }
    if (body !== pendingCommentBody) {
      pendingCommentBody = body;
      pendingCommentKey = requestKey();
    }
    local.busy = true;
    commentLoad++;
    setStatus('Adding comment…');
    try {
      await api(`${currentRoot}/items/${encodeURIComponent(item.id)}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': state.session.csrf,
          'Idempotency-Key': pendingCommentKey,
        },
        body: JSON.stringify({ body }),
      });
      if (state.root !== currentRoot || !section.isConnected) return;
      pendingCommentBody = '';
      pendingCommentKey = '';
      textarea.value = '';
      editor.refresh();
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await loadComments();
    } catch (error) {
      if (state.root === currentRoot && section.isConnected) setStatus(error.message, true);
    } finally {
      local.busy = false;
      if (section.isConnected) {
        update();
        renderControls();
      }
    }
  }
  function update() {
    const { comments, nextBefore, status, error } = local;
    render(
      html`${panelHeadTemplate('Comments')}
        <p
          class=${error ? 'help error' : 'help'}
          data-status-class="help"
          ?hidden=${!status}
          role=${error ? 'alert' : 'status'}
          aria-live="polite"
        >${status}</p>
        <button
          type="button"
          class="comment-load-older"
          ?hidden=${!nextBefore}
          ?disabled=${local.olderDisabled}
          @click=${() => {
            if (local.nextBefore && !local.busy) void loadComments(local.nextBefore, true);
          }}
        >Load older comments</button>
        <div class="comment-list">
          ${repeat(comments, (comment) => comment.id, commentTemplate)}
        </div>
        ${
          writer
            ? html`<div class="comment-composer">
                ${markdownEditorTemplate('comment_body', 'Add a comment', '', 4000, false, false, {
                  commentControl: true,
                  onReady: (ready) => {
                    editor = ready;
                  },
                })}
                <button
                  type="button"
                  class="primary"
                  data-comment-write="true"
                  ?disabled=${live(local.busy || !canComment())}
                  @click=${addComment}
                >Add comment</button>
              </div>`
            : helpTextTemplate('Viewers can read comments; members and admins can add them.')
        }`,
      section,
    );
  }
  update();
  void loadComments();
}
export function itemCommentsTemplate(item) {
  return html`<section class="item-comments" ${attach(mountComments, item)}></section>`;
}
