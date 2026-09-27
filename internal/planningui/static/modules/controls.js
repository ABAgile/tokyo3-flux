// Permission updates for the modal editor while its native fields keep a stable lifetime.
import { $ } from './dom.js';
import { state } from './state.js';
import { writable, adminWritable, gitLabWritable, canComment } from './permissions.js';

function syncEditorControls(root) {
  if (!root) return;
  root.querySelectorAll('[data-write]').forEach((control) => {
    control.disabled = !writable() || state.integrationFormOpen;
  });
  root.querySelectorAll('[data-admin-write]').forEach((control) => {
    control.disabled = !adminWritable() || state.integrationFormOpen;
  });
  root.querySelectorAll('[data-gitlab-write]').forEach((control) => {
    control.disabled = !gitLabWritable();
  });
  root.querySelectorAll('[data-comment-write]').forEach((control) => {
    control.disabled = !canComment();
  });
}

export function renderControls() {
  syncEditorControls($('editor'));
}
