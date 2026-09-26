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
  document.querySelectorAll('[data-view]').forEach((b) => {
    b.disabled = state.busy || state.loading || state.integrationFormOpen;
  });
  $('presentation-toggle').hidden = !state.board || state.view !== 'board';
  $('presentation-board').disabled =
    !state.board || state.busy || state.loading || state.integrationFormOpen;
  $('presentation-list').disabled =
    !state.board || state.busy || state.loading || state.integrationFormOpen;
  $('presentation-board').setAttribute('aria-pressed', String(state.presentation === 'board'));
  $('presentation-list').setAttribute('aria-pressed', String(state.presentation === 'list'));
  $('refresh').disabled = state.busy || state.loading || state.integrationFormOpen;
  $('new-workspace').disabled =
    !state.session || state.busy || state.loading || state.integrationFormOpen;
  $('workspace-field').hidden = !state.board && state.workspaceGate !== 'loading';
  $('workspace').disabled =
    !state.board || state.busy || state.loading || state.integrationFormOpen;
  document.querySelector('nav').hidden = !state.board;
  document.querySelector('.heading .actions').hidden = !state.board;
  $('planning-filters').hidden = !state.board;
  $('project').disabled = !state.board || state.busy || state.loading;
  $('assignee').disabled = !state.board || state.busy || state.loading;
  $('label').disabled = !state.board || state.busy || state.loading;
  $('undo').disabled = !writable();
  document.querySelectorAll('.list-row-select').forEach((input) => {
    input.disabled = state.busy || state.loading;
  });
}
