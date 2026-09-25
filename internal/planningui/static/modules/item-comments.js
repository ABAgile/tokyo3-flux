// Item comments: list, paging and composer.
import { el, button } from './dom.js';
import { api, requestKey } from './api.js';
import { initials } from './format.js';
import { renderMarkdown, markdownEditor } from './markdown.js';
import { panelHead, helpText, statusLine, setStatusText } from './layout.js';
import { state } from './state.js';
import { canComment } from './permissions.js';
import { renderControls } from './controls.js';
import { memberInfo } from './people.js';
import { reconcileKeyedChildren } from './reconcile.js';

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
function commentNode(comment) {
  const row = el('article', undefined, 'comment');
  row.dataset.commentId = String(comment.id);
  row.dataset.renderSignature = JSON.stringify({ comment, member: memberInfo(comment.author) });
  const info = memberInfo(comment.author);
  const avatar = el('span', undefined, 'avatar comment-avatar');
  avatar.setAttribute('aria-hidden', 'true');
  avatar.append(el('span', initials(info.name), 'avatar-fallback'));
  if (info.avatarURL) {
    const image = el('img');
    image.src = info.avatarURL;
    image.alt = '';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.onerror = () => image.remove();
    avatar.append(image);
  }
  const content = el('div', undefined, 'comment-content');
  const header = el('div', undefined, 'comment-head');
  const author = el('strong', info.name);
  author.title = comment.author;
  const time = commentTime(comment.created_at);
  const created = el('time', time.label, 'muted');
  if (time.dateTime) created.dateTime = time.dateTime;
  header.append(author, created);
  const body = el('div', undefined, 'comment-body');
  renderMarkdown(body, comment.body);
  content.append(header, body);
  row.append(avatar, content);
  return row;
}
function renderCommentList(list, comments) {
  const next = comments.map(commentNode);
  if (!next.length) {
    list.replaceChildren();
    return;
  }
  reconcileKeyedChildren(list, next, (node) => `comment:${node.dataset.commentId}`);
}
export function renderItemComments(fields, item) {
  const currentRoot = state.root;
  const section = el('section', undefined, 'item-comments');
  const heading = panelHead('Comments');
  const status = statusLine();
  const older = button('Load older comments');
  older.className = 'comment-load-older';
  older.hidden = true;
  const list = el('div', undefined, 'comment-list');
  let comments = [],
    nextBefore = 0,
    commentBusy = false,
    commentLoad = 0,
    pendingCommentBody = '',
    pendingCommentKey = '';
  let addButton, textarea, refreshCommentPreview;
  const setStatus = (text, error = false) => setStatusText(status, text, error);
  setStatus('Loading comments…');
  section.append(heading, status, older, list);
  if (state.board.role !== 'member' && state.board.role !== 'admin')
    section.append(helpText('Viewers can read comments; members and admins can add them.'));
  else {
    const composer = el('div', undefined, 'comment-composer');
    const editor = markdownEditor(composer, 'comment_body', 'Add a comment', '', 4000);
    textarea = editor.input;
    textarea.dataset.commentControl = 'true';
    refreshCommentPreview = editor.refresh;
    addButton = button('Add comment', addComment, 'primary');
    addButton.dataset.commentWrite = 'true';
    addButton.disabled = !canComment();
    composer.append(addButton);
    section.append(composer);
  }
  fields.append(section);
  async function loadComments(before = 0, append = false) {
    const loadID = ++commentLoad;
    setStatus('Loading comments…');
    older.disabled = true;
    try {
      const query = new URLSearchParams({ limit: String(COMMENT_PAGE_LIMIT) });
      if (before) query.set('before', String(before));
      const page = await api(
        currentRoot + '/items/' + encodeURIComponent(item.id) + '/comments?' + query,
      );
      if (loadID !== commentLoad || state.root !== currentRoot || !section.isConnected)
        return false;
      if (!validCommentPage(page))
        throw new Error('Comments are invalid. Reopen the item to retry.');
      comments = append ? [...page.comments, ...comments] : page.comments;
      nextBefore = page.next_before || 0;
      older.hidden = !nextBefore;
      older.disabled = false;
      renderCommentList(list, comments);
      setStatus(
        comments.length
          ? `${comments.length}${nextBefore ? '+' : ''} comment${comments.length === 1 ? '' : 's'} loaded.`
          : 'No comments yet.',
      );
      return true;
    } catch (error) {
      if (loadID === commentLoad && state.root === currentRoot && section.isConnected) {
        older.hidden = !nextBefore;
        older.disabled = false;
        setStatus(error.message, true);
      }
      return false;
    }
  }
  older.onclick = () => {
    if (nextBefore && !commentBusy) void loadComments(nextBefore, true);
  };
  async function addComment() {
    if (!addButton || commentBusy || !canComment()) return;
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
    commentBusy = true;
    commentLoad++;
    addButton.disabled = true;
    setStatus('Adding comment…');
    try {
      await api(currentRoot + '/items/' + encodeURIComponent(item.id) + '/comments', {
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
      refreshCommentPreview();
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await loadComments();
    } catch (error) {
      if (state.root === currentRoot && section.isConnected) setStatus(error.message, true);
    } finally {
      commentBusy = false;
      if (addButton && section.isConnected) {
        addButton.disabled = !canComment();
        renderControls();
      }
    }
  }
  void loadComments();
}
