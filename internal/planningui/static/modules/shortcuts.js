// Keyboard shortcuts, the shortcut list and Escape handling for page controls.
import { html } from './vdom.js';
import { useRef } from './vendor-preact.js';
import { setState, state, useStore } from './state.js';
import { notice } from './notices.js';
import { canWrite } from './permissions.js';
import { isEditorOpen } from './dialog-state.js';
import { Modal } from './dialog.js';
import { useEventListener } from './ui-hooks.js';
import { searchInputRef } from './planning-filters.js';
import { interactionBlocked, navigate, newItem, refreshWorkspace } from './actions.js';

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
const TYPING = 'input,textarea,select,[contenteditable=""],[contenteditable="true"]';
function typingTarget(target) {
  return target instanceof Element && target.closest(TYPING) !== null;
}
function shortcutKey(event) {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}
// The search field is shown for the planning views and Sprints.
function searchAvailable(current) {
  return !!current.board && !['history', 'projects', 'labels', 'members'].includes(current.view);
}
function openShortcuts() {
  setState({ shortcutsOpen: true });
}
function closeShortcuts() {
  setState({ shortcutsOpen: false });
}
// Installs the document keyboard listeners for the App's lifetime. The List
// detail pane and open menus handle their own Escape before it reaches here.
// `mainRef` is the main region that receives focus when Escape leaves a control.
export function useGlobalShortcuts(mainRef) {
  const chord = useRef(0);
  // Escape leaves a page-level control so shortcuts become available without
  // reaching for the pointer. Focus moves to the main region rather than being
  // dropped, and contexts that already own Escape — dialogs, the detail pane and
  // open selection menus — keep their existing close behavior.
  useEventListener(document, 'keydown', (event) => {
    if (
      event.key !== 'Escape' ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !(event.target instanceof Element)
    )
      return;
    const control = event.target.closest(TYPING);
    if (!control || control.closest('dialog') || control.closest('.multi-select-menu')) return;
    event.preventDefault();
    control.blur();
    mainRef.current?.focus({ preventScroll: true });
  });
  useEventListener(document, 'keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    if (state.shortcutsOpen) {
      if (event.key === 'Escape') closeShortcuts();
      return;
    }
    if (typingTarget(event.target) || isEditorOpen()) return;
    // A modifier or lock key pressed on its own must not consume a pending chord,
    // so holding Shift between `g` and the view key still navigates.
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return;
    const key = shortcutKey(event);
    const pending = chord.current && Date.now() - chord.current < SHORTCUT_CHORD_MS;
    chord.current = 0;
    if (pending) {
      if (VIEW_SHORTCUTS[key]) {
        event.preventDefault();
        void navigate(VIEW_SHORTCUTS[key]);
        return;
      }
      if (key !== 'g') {
        notice('No view for that key. Press g then b, s, p, m, l, a or h.');
        return;
      }
    }
    if (event.key === '?' || (event.shiftKey && key === '/')) {
      event.preventDefault();
      openShortcuts();
      return;
    }
    if (key === '/') {
      event.preventDefault();
      if (searchAvailable(state)) {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
      return;
    }
    if (key === 'g') {
      chord.current = Date.now();
      notice('Go to… press b, s, p, m, l, a or h.');
      return;
    }
    if (key === 'n') {
      if (canWrite(state) && !state.integrationFormOpen) {
        event.preventDefault();
        newItem();
      }
      return;
    }
    if (key === 'r') {
      if (!interactionBlocked()) {
        event.preventDefault();
        void refreshWorkspace();
      }
    }
  });
}
function selectShortcutsOpen(current) {
  return current.shortcutsOpen;
}
export function ShortcutsDialog() {
  const open = useStore(selectShortcutsOpen);
  return html`<${Modal}
    id="shortcuts"
    labelledBy="shortcuts-title"
    open=${open}
    onClosed=${closeShortcuts}
  >
    <div class="dialog-panel">
      <div class="dialog-head">
        <h2 id="shortcuts-title">Keyboard shortcuts</h2>
        <button type="button" id="shortcuts-dismiss" aria-label="Close keyboard shortcuts" onClick=${closeShortcuts}>×</button>
      </div>
      <dl class="shortcut-list">
        <dt><kbd>/</kbd></dt><dd>Focus the work search</dd>
        <dt><kbd>n</kbd></dt><dd>Create a work item</dd>
        <dt><kbd>r</kbd></dt><dd>Refresh the workspace</dd>
        <dt><kbd>g</kbd> <kbd>b</kbd></dt><dd>Go to the Kanban board</dd>
        <dt><kbd>g</kbd> <kbd>s</kbd></dt><dd>Go to Sprints</dd>
        <dt><kbd>g</kbd> <kbd>p</kbd></dt><dd>Go to Projects</dd>
        <dt><kbd>g</kbd> <kbd>m</kbd></dt><dd>Go to Members</dd>
        <dt><kbd>g</kbd> <kbd>l</kbd></dt><dd>Go to Labels</dd>
        <dt><kbd>g</kbd> <kbd>a</kbd></dt><dd>Go to Archive</dd>
        <dt><kbd>g</kbd> <kbd>h</kbd></dt><dd>Go to History</dd>
        <dt><kbd>Esc</kbd></dt><dd>Leave the focused control, or close the open dialog or detail pane</dd>
        <dt><kbd>?</kbd></dt><dd>Show this list</dd>
      </dl>
      <div class="dialog-foot"><button type="button" id="shortcuts-close" class="primary" onClick=${closeShortcuts}>Close</button></div>
    </div>
  </${Modal}>`;
}
