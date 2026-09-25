// Planning changes: posting, optimistic apply, undo and sequences.
import { $ } from './dom.js';
import { api, requestKey } from './api.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { writable } from './permissions.js';
import { notice } from './notices.js';
import { findItem } from './items.js';
import { renderControls } from './controls.js';

// minimal skips the committed board in the receipt. A batch only needs the
// board once, so every command but the last asks for a minimal receipt and the
// whole sequence costs one board read instead of one per command.
function postChange(command, key = requestKey(), minimal = false) {
  const headers = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': state.session.csrf,
    'Idempotency-Key': key,
  };
  if (minimal) headers.Prefer = 'return=minimal';
  return api(state.root + '/changes', { method: 'POST', headers, body: JSON.stringify(command) });
}
function preloadedBoard(receipt) {
  return receipt?.board && typeof receipt.board_etag === 'string' && receipt.board_etag
    ? { board: receipt.board, etag: receipt.board_etag }
    : undefined;
}
// The receipt board is read after the commit, so a concurrent change can carry
// it past the revision this command produced. Its own revision is the one the
// next command in a batch must present, or the batch conflicts on a value the
// server has already moved beyond.
export function receiptRevision(receipt, fallback) {
  const board = preloadedBoard(receipt)?.board.workspace?.revision;
  if (Number.isSafeInteger(board)) return board;
  return Number.isSafeInteger(receipt?.revision) ? receipt.revision : fallback;
}
export async function change(command, key = requestKey()) {
  if (!writable()) throw new Error('Planning is read-only or a request is in progress.');
  state.busy = true;
  renderControls();
  notice('Saving changes…');
  let receipt;
  try {
    receipt = await postChange(command, key);
  } catch (error) {
    // The save is over; callers report the failure in the error bar.
    notice('');
    throw error;
  } finally {
    state.busy = false;
    renderControls();
  }
  const refreshed = await hooks.refresh(preloadedBoard(receipt));
  notice(
    refreshed
      ? 'Changes saved.'
      : 'Changes saved, but refreshing failed. Use Refresh before continuing.',
    !refreshed,
  );
  return { receipt, refreshed };
}
// Card placement and archive state are reordered locally before the write is
// acknowledged so a drag feels immediate. The command still carries the board
// revision, the save is still announced, and a rejected write is rolled back to
// the exact previous placement rather than left silently applied.
const OPTIMISTIC_KINDS = new Set(['item.move', 'item.rank', 'item.archive', 'item.restore']);
function optimisticApply(command) {
  if (!state.board || !OPTIMISTIC_KINDS.has(command.kind)) return undefined;
  if (command.kind === 'item.archive' || command.kind === 'item.restore') {
    const source = command.kind === 'item.archive' ? state.board.items : state.archiveItems;
    const index = source.findIndex((value) => value.id === command.target);
    if (index < 0) return undefined;
    const [removed] = source.splice(index, 1);
    return () => {
      if (source !== (command.kind === 'item.archive' ? state.board?.items : state.archiveItems))
        return;
      source.splice(index, 0, removed);
    };
  }
  const items = state.board.items;
  const index = items.findIndex((value) => value.id === command.target);
  if (index < 0) return undefined;
  const item = items[index];
  const column = item.column_id;
  const ranks = items.map((value) => value.rank);
  if (
    command.kind === 'item.move' &&
    !state.board.columns.some((value) => value.id === command.destination)
  )
    return undefined;
  items.splice(index, 1);
  let at = items.length;
  if (command.before) {
    at = items.findIndex((value) => value.id === command.before);
    if (at < 0) {
      items.splice(index, 0, item);
      return undefined;
    }
  }
  items.splice(at, 0, item);
  if (command.kind === 'item.move') item.column_id = command.destination;
  items.forEach((value, rank) => {
    value.rank = rank;
  });
  return () => {
    if (items !== state.board?.items) return;
    items.splice(at, 1);
    items.splice(index, 0, item);
    item.column_id = column;
    items.forEach((value, position) => {
      value.rank = ranks[position];
    });
  };
}
export const UNDO_TTL = 10000;
export function clearUndo() {
  if (state.undoTimer) clearTimeout(state.undoTimer);
  state.undoTimer = undefined;
  state.undoOffer = undefined;
  $('undo-bar').hidden = true;
  $('undo-text').textContent = '';
}
export function offerUndo(text, commands) {
  const list = (Array.isArray(commands) ? commands : [commands]).filter(Boolean);
  clearUndo();
  if (!list.length) return;
  state.undoOffer = list;
  $('undo-text').textContent = text;
  $('undo').disabled = !writable();
  $('undo-bar').hidden = false;
  state.undoTimer = setTimeout(clearUndo, UNDO_TTL);
}
function itemTitle(id) {
  return findItem(id)?.title || 'work item';
}
// The inverse must be read before the command is applied, because a move undo
// is expressed as the anchor the card currently sits in front of.
function undoableInverse(command) {
  switch (command.kind) {
    case 'item.archive': {
      const item = findItem(command.target);
      return {
        text: `Archived “${itemTitle(command.target)}”`,
        commands: [
          {
            kind: 'item.restore',
            target: command.target,
            restore_sprint_ids: [...(item?.sprint_ids || [])],
          },
        ],
      };
    }
    case 'item.restore':
      return {
        text: `Restored “${itemTitle(command.target)}”`,
        commands: [{ kind: 'item.archive', target: command.target }],
      };
    case 'item.move':
    case 'item.rank': {
      const index = state.board.items.findIndex((value) => value.id === command.target);
      if (index < 0) return undefined;
      const item = state.board.items[index];
      return {
        text: `Moved “${item.title}”`,
        commands: [
          {
            kind: 'item.move',
            target: item.id,
            destination: item.column_id,
            before: state.board.items[index + 1]?.id || '',
          },
        ],
      };
    }
    default:
      return undefined;
  }
}
export async function quick(command) {
  const full = { revision: state.board.workspace.revision, ...command };
  const allowed = writable();
  const undo = allowed ? undoableInverse(full) : undefined;
  const currentBoard = state.board;
  const rollback = allowed ? optimisticApply(full) : undefined;
  if (rollback) hooks.render();
  try {
    await change(full);
    if (undo)
      offerUndo(`${undo.text} · undo is available for ${UNDO_TTL / 1000} seconds`, undo.commands);
  } catch (e) {
    if (rollback && state.board === currentBoard) rollback();
    notice(e.message, true);
    hooks.render();
  }
}
// Bulk edits are separate revision-checked commands applied in order. The
// revision from each receipt seeds the next command, so one board read settles
// the whole batch and a mid-batch conflict stops rather than skips ahead. Only
// the final command asks for the committed board; the rest take a minimal
// receipt so the batch does not pay for a board read it discards.
export async function runSequence(label, commands) {
  if (!writable()) {
    notice('Planning is read-only or a request is in progress.', true);
    return false;
  }
  if (!commands.length) {
    notice('Nothing to apply for the current selection.');
    return true;
  }
  let revision = state.board.workspace.revision,
    receipt,
    applied = 0,
    failure = '';
  state.busy = true;
  renderControls();
  try {
    for (const [index, command] of commands.entries()) {
      notice(`${label} · ${applied}/${commands.length}…`);
      try {
        receipt = await postChange(
          { ...command, revision },
          requestKey(),
          index < commands.length - 1,
        );
        revision = receiptRevision(receipt, revision + 1);
        applied++;
      } catch (error) {
        failure = error.message;
        break;
      }
    }
  } finally {
    state.busy = false;
    renderControls();
  }
  const refreshed = await hooks.refresh(preloadedBoard(receipt));
  if (!refreshed) hooks.render();
  notice(
    failure
      ? `${label}: applied ${applied} of ${commands.length}. ${failure}`
      : `${label}: applied ${applied} of ${commands.length}.`,
    !!failure,
  );
  return !failure;
}
