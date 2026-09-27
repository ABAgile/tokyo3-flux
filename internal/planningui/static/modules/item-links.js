// Adding and reconciling GitLab links on a work item.
import { $, uid } from './dom.js';
import { api } from './api.js';
import { errorLineTemplate, fieldTemplate, helpTextTemplate } from './layout.js';
import { html, nothing, syncDisabled } from './preact.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { gitLabWritable } from './permissions.js';
import { notice } from './notices.js';
import { helpPopover, multiSelectTemplate } from './multi-select.js';
import {
  loadGitLabProjects,
  approvedGitLabProjectEntries,
  validGitLabMergeRequestCatalog,
  mergeRequestEntries,
} from './gitlab-catalog.js';
import { change } from './commands.js';
import { closeEditor, openEditor } from './dialog.js';

function resolveGitLabMRURL(value, currentBoard, projects) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Paste a GitLab merge-request URL first.');
  if (
    !currentBoard.connector_instance ||
    currentBoard.connector_instance !== currentBoard.integration.instance
  )
    throw new Error('GitLab link creation is not configured for this workspace.');
  if (!currentBoard.integration.projects.length)
    throw new Error('No approved GitLab projects are available for linking.');
  let target, instance, projectPath;
  try {
    target = new URL(raw);
    instance = new URL(currentBoard.connector_instance);
    projectPath = decodeURIComponent(target.pathname);
  } catch {
    throw new Error('Enter a valid GitLab merge-request URL.');
  }
  if (
    raw.length > 2048 ||
    /[\r\n]/.test(raw) ||
    target.origin !== instance.origin ||
    target.username ||
    target.password
  )
    throw new Error('Use a URL from the configured GitLab instance.');
  const basePath = instance.pathname.replace(/\/+$/, '');
  const prefix = basePath ? basePath + '/' : '/';
  if (!target.pathname.startsWith(prefix))
    throw new Error('That URL is outside the configured GitLab instance.');
  const tail = projectPath.slice(prefix.length);
  const marker = '/-/merge_requests/';
  const markerAt = tail.lastIndexOf(marker);
  const iid = markerAt < 0 ? '' : tail.slice(markerAt + marker.length);
  projectPath = markerAt > 0 ? projectPath.slice(prefix.length, prefix.length + markerAt) : '';
  if (markerAt <= 0 || !/^[1-9][0-9]*$/.test(iid) || !Number.isSafeInteger(Number(iid)))
    throw new Error('Use a canonical GitLab merge-request URL.');
  const approved = new Set(currentBoard.integration.projects.map(String));
  const project = projects.find(
    (value) =>
      approved.has(String(value.id)) &&
      typeof value.path_with_namespace === 'string' &&
      value.path_with_namespace.trim() === projectPath,
  );
  if (!project)
    throw new Error('That merge-request project is not in the approved GitLab project catalog.');
  return { project: Number(project.id), kind: 'mr', number: Number(iid) };
}
async function attachItemGitLabLink(item, link, context) {
  const currentBoard = state.board,
    currentRoot = state.root;
  const form = context?.form || ($('editor').open ? $('editor-form') : undefined);
  const draft = form ? hooks.itemEditorDraft(form) : undefined;
  const mode =
    context?.mode ||
    ($('editor').open
      ? 'modal'
      : state.view === 'board' && state.presentation === 'list'
        ? 'detail'
        : 'modal');
  const origin = context?.origin;
  const previous = new Set(
    currentBoard.links.filter((value) => value.items.includes(item.id)).map((value) => value.id),
  );
  if (mode === 'modal') closeEditor();
  try {
    await change({
      revision: currentBoard.workspace.revision,
      kind: 'link.attach',
      target: item.id,
      link,
    });
  } catch (error) {
    if (state.root === currentRoot && state.board) {
      const latest = state.board.items.find((value) => value.id === item.id);
      if (latest && draft) hooks.reopenItemEditor(latest, draft, mode, origin);
      notice(error.message, true);
    }
    return;
  }
  if (state.root !== currentRoot || !state.board) return;
  const latest = state.board.items.find((value) => value.id === item.id);
  if (!latest) return;
  const added = state.board.links
    .filter((value) => value.items.includes(item.id) && !previous.has(value.id))
    .map((value) => value.id);
  hooks.reopenItemEditor(
    latest,
    draft ? { ...draft, link_ids: [...new Set([...draft.link_ids, ...added])] } : undefined,
    mode,
    origin,
  );
}
// The paste-an-MR-URL row under the GitLab links picker. It is rendered as the
// picker's footer, so it keeps its state here and asks the picker to re-render.
export function gitLabPaste(item, readOnly, context) {
  const currentBoard = state.board,
    currentRoot = state.root;
  const local = { status: '', error: false, pending: false };
  const inputID = uid('gitlab-mr-url');
  let update = () => {};
  const setStatus = (text, error = false) => {
    local.status = text || '';
    local.error = error;
    update();
  };
  async function resolve(input) {
    if (local.pending || readOnly || !gitLabWritable()) return;
    const raw = input.value.trim();
    if (!raw) {
      setStatus('Paste a GitLab merge-request URL first.', true);
      input.focus();
      return;
    }
    local.pending = true;
    setStatus('Resolving GitLab merge request…');
    try {
      const projects = await loadGitLabProjects(currentRoot);
      if (!input.isConnected || state.board !== currentBoard || state.root !== currentRoot) return;
      const link = resolveGitLabMRURL(raw, currentBoard, projects);
      await attachItemGitLabLink(item, link, context);
    } catch (error) {
      if (input.isConnected) {
        setStatus(error.message, true);
        input.focus();
      }
    } finally {
      local.pending = false;
      if (input.isConnected) update();
    }
  }
  return {
    bind(picker) {
      update = picker.update;
    },
    template: () => html`<div class="gitlab-paste-row">
        <input
          id=${inputID}
          type="text"
          inputmode="url"
          placeholder="Paste GitLab MR URL, then press Enter or click Get"
          maxlength="2048"
          aria-label="GitLab MR URL"
          autocomplete="off"
          onKeydown=${(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            resolve(event.currentTarget);
          }}
        /><button
          type="button"
          class="primary"
          data-gitlab-write="true"
          ref=${syncDisabled(readOnly || local.pending || !gitLabWritable())}
          onClick=${(event) => resolve(event.currentTarget.previousElementSibling)}
        >Get</button>
      </div>
      <p
        class=${local.error ? 'help error' : 'help'}
        data-status-class="help"
        hidden=${!local.status}
        role=${local.error ? 'alert' : 'status'}
        aria-live="polite"
      >${local.status}</p>`,
  };
}
export async function addGitLabLink(item, context) {
  const currentBoard = state.board,
    currentRoot = state.root;
  const form = context?.form || ($('editor').open ? $('editor-form') : undefined);
  const draft = form ? hooks.itemEditorDraft(form) : undefined;
  const mode =
    context?.mode ||
    ($('editor').open
      ? 'modal'
      : state.view === 'board' && state.presentation === 'list'
        ? 'detail'
        : 'modal');
  const origin = context?.origin;
  if (mode === 'modal') closeEditor();
  let projects = [],
    catalogError = '';
  const returnToCard = () => {
    if (state.root !== currentRoot || !state.board) return;
    const latest = state.board.items.find((value) => value.id === item.id);
    if (!latest) return;
    const previous = new Set(
      currentBoard.links.filter((value) => value.items.includes(item.id)).map((value) => value.id),
    );
    const added = state.board.links
      .filter((value) => value.items.includes(item.id) && !previous.has(value.id))
      .map((value) => value.id);
    const returnDraft = draft
      ? { ...draft, link_ids: [...new Set([...draft.link_ids, ...added])] }
      : undefined;
    hooks.reopenItemEditor(latest, returnDraft, mode, origin);
  };
  try {
    projects = await loadGitLabProjects(currentRoot);
  } catch (e) {
    catalogError = e.message;
  }
  if (state.board !== currentBoard || state.root !== currentRoot) return;
  let projectPicker, mrPicker;
  let searchTimer;
  let searchGeneration = 0;
  const editorForm = () => $('editor-form');
  const pickerStatus = () =>
    projectPicker.selected().length
      ? 'Open the merge-request picker to load results.'
      : 'Select an approved project first.';
  const resetMergeRequests = () => {
    searchGeneration++;
    if (searchTimer) clearTimeout(searchTimer);
    mrPicker.filter.value = '';
    mrPicker.setEntries([], []);
  };
  const queueMergeRequestSearch = (query, controls) => {
    if (searchTimer) clearTimeout(searchTimer);
    const generation = ++searchGeneration;
    const project = projectPicker.selected()[0];
    if (!project) {
      controls.setEntries([], []);
      controls.setStatus('Select an approved project first.');
      return;
    }
    controls.setStatus('Searching GitLab…');
    searchTimer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          project,
          scope: editorForm().elements.scope.value || 'recent',
          search: query,
        });
        const data = await api(`${currentRoot}/gitlab/merge-requests?${params}`);
        if (
          generation !== searchGeneration ||
          state.board !== currentBoard ||
          state.root !== currentRoot
        )
          return;
        if (!validGitLabMergeRequestCatalog(data))
          throw new Error('GitLab merge-request results are invalid. Refresh to retry.');
        const selected = controls.selected();
        controls.setEntries(mergeRequestEntries(data, selected), selected);
        controls.setStatus(data.length ? '' : 'No matching merge requests.');
      } catch (e) {
        if (
          generation === searchGeneration &&
          state.board === currentBoard &&
          state.root === currentRoot
        )
          controls.setStatus(e.message);
      }
    }, 250);
  };
  openEditor(
    'Add link',
    () => html`${
      catalogError
        ? errorLineTemplate(
            `Could not load the GitLab project list. ${catalogError} Approved project IDs remain available so this link is not blocked by a temporary catalog failure.`,
          )
        : nothing
    }
        ${multiSelectTemplate(
          'project',
          'Approved GitLab project',
          approvedGitLabProjectEntries(projects),
          [],
          undefined,
          'Choose one approved project. The project list is provided by the configured GitLab connector and is searchable.',
          {
            single: true,
            onReady: (controls) => {
              projectPicker = controls;
            },
            onChange: () => {
              if (!mrPicker) return;
              resetMergeRequests();
              editorForm().elements.manual_mr_iid.value = '';
              mrPicker.setStatus(pickerStatus());
            },
          },
        )}
        ${fieldTemplate(
          'scope',
          'Quick scope',
          'recent',
          'text',
          [
            ['recent', 'Recent merge requests'],
            ['assigned_to_me', 'Assigned to me'],
            ['board_members', 'Assigned to board members'],
          ],
          {
            onChange: () => {
              const wasOpen = mrPicker.isOpen();
              resetMergeRequests();
              mrPicker.setStatus(pickerStatus());
              if (wasOpen) queueMergeRequestSearch('', mrPicker);
            },
          },
        )}
        ${multiSelectTemplate(
          'merge_request',
          'Merge request',
          [],
          [],
          undefined,
          'After trying a quick scope, search by title or IID. Results are ordered by GitLab update time; selecting one stores only its project-scoped IID.',
          {
            single: true,
            onFilter: queueMergeRequestSearch,
            onOpen: queueMergeRequestSearch,
            onReady: (controls) => {
              mrPicker = controls;
              controls.filter.maxLength = 120;
            },
            onChange: (values) => {
              if (values.length) editorForm().elements.manual_mr_iid.value = '';
            },
          },
        )}
        ${fieldTemplate('manual_mr_iid', 'MR IID (optional fallback)', '', 'number', undefined, {
          min: 1,
          max: Number.MAX_SAFE_INTEGER,
          step: 1,
        })}
        ${
          !projects.length && !catalogError && !state.board.integration.projects.length
            ? helpTextTemplate('No approved GitLab projects are available for linking.')
            : nothing
        }`,
    (data) => {
      const rawProject = String(data.get('project') || '');
      const selectedMR = String(data.get('merge_request') || '');
      const manualIID = String(data.get('manual_mr_iid') || '');
      const rawNumber = selectedMR || manualIID;
      if (!/^[1-9][0-9]*$/.test(rawProject) || !Number.isSafeInteger(Number(rawProject)))
        throw new Error('Choose an approved GitLab project.');
      if (selectedMR && manualIID)
        throw new Error('Select a merge request or enter its IID manually, not both.');
      if (!/^[1-9][0-9]*$/.test(rawNumber) || !Number.isSafeInteger(Number(rawNumber)))
        throw new Error('Select a merge request or enter a positive MR IID.');
      return {
        kind: 'link.attach',
        target: item.id,
        link: { project: Number(rawProject), kind: 'mr', number: Number(rawNumber) },
      };
    },
    false,
    undefined,
    returnToCard,
    {
      onOpen: () =>
        $('editor-title-extra').append(
          ' ',
          helpPopover(
            'Choose an approved project and use a quick scope or merge-request search. Enter an MR IID only as a final fallback. Flux retrieves the latest pipeline status from the linked MR.',
            'GitLab links',
          ),
        ),
    },
  );
}
export async function reconcileItemLinks(itemID, desiredIDs) {
  const desired = new Set(desiredIDs);
  for (const link of state.board.links.filter(
    (link) => link.items.includes(itemID) && !desired.has(link.id),
  )) {
    await change({
      revision: state.board.workspace.revision,
      kind: 'link.detach',
      target: itemID,
      destination: link.id,
    });
  }
  for (const linkID of desired) {
    if (state.board.links.some((link) => link.id === linkID && link.items.includes(itemID)))
      continue;
    const link = state.board.links.find((value) => value.id === linkID);
    if (!link)
      throw new Error(
        'A selected GitLab link is no longer available. Refresh and reopen the card.',
      );
    await change({
      revision: state.board.workspace.revision,
      kind: 'link.attach',
      target: itemID,
      link: { project: link.project, kind: link.kind, number: link.number },
    });
  }
}
