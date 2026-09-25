// Keyboard shortcuts and Escape handling.
import { $ } from './dom.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { notice } from './notices.js';
import { closeDetail } from './item-detail.js';

// Global shortcuts never fire while typing, while a dialog is open, or with
// Alt/Control/Meta held, so they cannot shadow browser or assistive-technology
// keys. Letters are matched case-insensitively and Shift is allowed, so Caps
// Lock or a shifted key still activates them.
const VIEW_SHORTCUTS = Object.freeze({
  b: 'board',
  s: 'sprints',
  p: 'projects',
  m: 'members',
  l: 'labels',
  a: 'archive',
  h: 'history',
});
const SHORTCUT_CHORD_MS = 2500;
function typingTarget(target) {
  return (
    target instanceof Element &&
    target.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"]') !== null
  );
}
export function goToView(next) {
  const control = document.querySelector(`[data-view="${next}"]`);
  if (control && !control.disabled) control.click();
}
function shortcutKey(event) {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}
// Registers the keyboard listeners in their original order (the detail pane
// handles Escape first); app.js calls this once at startup.
export function initShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (
      event.key !== 'Escape' ||
      !state.detailState?.pane?.contains(event.target) ||
      $('editor').open
    )
      return;
    const menu = event.target.closest?.('.multi-select-menu');
    if (menu && !menu.hidden) return;
    if (closeDetail()) event.preventDefault();
    event.stopImmediatePropagation();
  });
  // Escape leaves a page-level control so shortcuts become available without
  // reaching for the pointer. Focus moves to the main region rather than being
  // dropped, and contexts that already own Escape — dialogs, the detail pane and
  // open selection menus — keep their existing close behavior.
  document.addEventListener('keydown', (event) => {
    if (
      event.key !== 'Escape' ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !(event.target instanceof Element)
    )
      return;
    const control = event.target.closest(
      'input,textarea,select,[contenteditable=""],[contenteditable="true"]',
    );
    if (
      !control ||
      control.closest('dialog') ||
      control.closest('.multi-select-menu') ||
      state.detailState?.pane?.contains(control)
    )
      return;
    event.preventDefault();
    control.blur();
    $('main').focus({ preventScroll: true });
  });
  document.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    if ($('shortcuts').open) {
      if (event.key === 'Escape') $('shortcuts').close();
      return;
    }
    if (typingTarget(event.target) || $('editor').open) return;
    // A modifier or lock key pressed on its own must not consume a pending chord,
    // so holding Shift between `g` and the view key still navigates.
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return;
    const key = shortcutKey(event);
    const chord = state.shortcutChord && Date.now() - state.shortcutChord < SHORTCUT_CHORD_MS;
    state.shortcutChord = 0;
    if (chord) {
      if (VIEW_SHORTCUTS[key]) {
        event.preventDefault();
        goToView(VIEW_SHORTCUTS[key]);
        return;
      }
      if (key !== 'g') {
        notice('No view for that key. Press g then b, s, p, m, l, a or h.');
        return;
      }
    }
    if (event.key === '?' || (event.shiftKey && key === '/')) {
      event.preventDefault();
      $('shortcuts').showModal();
      return;
    }
    if (key === '/') {
      event.preventDefault();
      if (!$('search-filter').hidden && !$('planning-filters').hidden) {
        $('search').focus();
        $('search').select();
      }
      return;
    }
    if (key === 'g') {
      state.shortcutChord = Date.now();
      notice('Go to… press b, s, p, m, l, a or h.');
      return;
    }
    if (key === 'n') {
      if (!$('new-item').disabled && !document.querySelector('.heading .actions').hidden) {
        event.preventDefault();
        $('new-item').click();
      }
      return;
    }
    if (key === 'r') {
      if (!$('refresh').disabled) {
        event.preventDefault();
        void hooks.refresh();
      }
    }
  });
}
