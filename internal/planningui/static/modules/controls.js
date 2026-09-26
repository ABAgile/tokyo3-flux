// Enables and disables shell controls to match permissions and busy state.
import { $ } from './dom.js';
import { state } from './state.js';
import { writable, adminWritable, gitLabWritable, canComment } from './permissions.js';
import { findItem } from './items.js';

export function renderControls() {
  document.querySelectorAll('[data-write]').forEach((b) => {
    b.disabled = !writable() || state.integrationFormOpen;
  });
  document.querySelectorAll('[data-admin-write]').forEach((b) => {
    b.disabled = !adminWritable() || state.integrationFormOpen;
  });
  document.querySelectorAll('[data-gitlab-write]').forEach((b) => {
    b.disabled = !gitLabWritable();
  });
  document.querySelectorAll('[data-comment-write]').forEach((b) => {
    b.disabled = !canComment();
  });
  document.querySelectorAll('[data-drag-type]').forEach((e) => {
    const item = e.dataset.dragType === 'card' ? findItem(e.dataset.item) : undefined;
    e.draggable = writable() && !item?.archived;
  });
  $('presentation-toggle').hidden = !state.board || state.view !== 'board';
  $('presentation-board').disabled =
    !state.board || state.busy || state.loading || state.integrationFormOpen;
  $('presentation-list').disabled =
    !state.board || state.busy || state.loading || state.integrationFormOpen;
  $('presentation-board').setAttribute('aria-pressed', String(state.presentation === 'board'));
  $('presentation-list').setAttribute('aria-pressed', String(state.presentation === 'list'));
  $('planning-filters').hidden = !state.board;
  $('project').disabled = !state.board || state.busy || state.loading;
  $('assignee').disabled = !state.board || state.busy || state.loading;
  $('label').disabled = !state.board || state.busy || state.loading;
  $('undo').disabled = !writable();
  document.querySelectorAll('.list-row-select').forEach((input) => {
    input.disabled = state.busy || state.loading;
  });
}
