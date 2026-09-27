// Adding and reconciling GitLab links on a work item.
import { uid } from './dom.js';
import { errorLineTemplate, fieldTemplate, helpTextTemplate } from './layout.js';
import { html } from './vdom.js';
import { useRef, useState } from './vendor-preact.js';
import { state, useStore } from './state.js';
import { workspaceSignal } from './workspace-session.js';
import { gitLabWritable, usePermissions } from './permissions.js';
import { notice } from './notices.js';
import { helpPopoverTemplate, MultiSelect } from './multi-select.js';
import {
  loadGitLabProjects,
  loadGitLabMergeRequests,
  approvedGitLabProjectEntries,
  mergeRequestEntries,
} from './gitlab-catalog.js';
import { change } from './commands.js';
import { closeEditor, openDialog } from './dialog-state.js';
import { CommandDialog } from './dialog.js';
import { reopenItemEditor } from './actions.js';
import { useDebouncedValue, useMutation, useRequest } from './ui-hooks.js';

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
function itemLinkIDs(board, itemID) {
  return board.links.filter((value) => value.items.includes(itemID)).map((value) => value.id);
}
// Reopens the card in the surface it came from with the draft it had, plus any
// link the workspace gained for it meanwhile. `root` is the workspace the
// card was edited in; nothing reopens once another workspace is shown.
function returnToCard({ item, draft, mode, originFocusKey, previousLinkIDs, root }) {
  if (state.root !== root || !state.board) return;
  const latest = state.board.items.find((value) => value.id === item.id);
  if (!latest) return;
  const previous = new Set(previousLinkIDs);
  const added = itemLinkIDs(state.board, item.id).filter((id) => !previous.has(id));
  const returnDraft = draft
    ? { ...draft, link_ids: [...new Set([...draft.link_ids, ...added])] }
    : undefined;
  reopenItemEditor(latest, returnDraft, mode, originFocusKey);
}
// `origin` is { mode, draft, originFocusKey } of the editor the link came from.
// The write outlives the editor it started in, so it belongs to the workspace
// session and nothing is reopened after that session ended.
async function attachItemGitLabLink(item, link, origin) {
  const currentBoard = state.board,
    signal = workspaceSignal();
  const context = { item, ...origin, root: state.root };
  const previousLinkIDs = itemLinkIDs(currentBoard, item.id);
  if (origin.mode === 'modal') closeEditor();
  try {
    await change({
      revision: currentBoard.workspace.revision,
      kind: 'link.attach',
      target: item.id,
      link,
    });
  } catch (error) {
    if (!signal.aborted && state.board) {
      const latest = state.board.items.find((value) => value.id === item.id);
      if (latest && origin.draft)
        reopenItemEditor(latest, origin.draft, origin.mode, origin.originFocusKey);
      notice(error.message, true);
    }
    return;
  }
  if (!signal.aborted) returnToCard({ ...context, previousLinkIDs });
}
// The paste-an-MR-URL row under the GitLab links picker. `getDraft` reads the
// enclosing editor's current input, so a reopened card keeps it. Keyed by
// workspace root, so a switch remounts it and aborts a pending resolve.
function GitLabPasteRow({ root, item, readOnly, mode, getDraft, originFocusKey }) {
  const [inputID] = useState(() => uid('gitlab-mr-url'));
  const [status, setStatus] = useState({ text: '', error: false });
  const input = useRef(null);
  const writes = useMutation();
  const { gitlab } = usePermissions();
  async function resolve() {
    const field = input.current;
    if (writes.pending || readOnly || !gitLabWritable() || !field) return;
    const raw = field.value.trim();
    if (!raw) {
      setStatus({ text: 'Paste a GitLab merge-request URL first.', error: true });
      field.focus();
      return;
    }
    await writes.run(async (signal) => {
      setStatus({ text: 'Resolving GitLab merge request…', error: false });
      try {
        const projects = await loadGitLabProjects(root, signal);
        if (signal.aborted || !state.board) return;
        const link = resolveGitLabMRURL(raw, state.board, projects);
        await attachItemGitLabLink(item, link, { mode, draft: getDraft?.(), originFocusKey });
      } catch (error) {
        if (signal.aborted) return;
        setStatus({ text: error.message, error: true });
        input.current?.focus();
      }
    });
  }
  return html`<div class="gitlab-paste-row">
      <input
        id=${inputID}
        type="text"
        inputmode="url"
        placeholder="Paste GitLab MR URL, then press Enter or click Get"
        maxlength="2048"
        aria-label="GitLab MR URL"
        autocomplete="off"
        ref=${input}
        onKeydown=${(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          void resolve();
        }}
      /><button
        type="button"
        class="primary"
        data-gitlab-write="true"
        disabled=${readOnly || writes.pending || !gitlab}
        onClick=${() => void resolve()}
      >Get</button>
    </div>
    <p
      class=${status.error ? 'help error' : 'help'}
      data-status-class="help"
      hidden=${!status.text}
      role=${status.error ? 'alert' : 'status'}
      aria-live="polite"
    >${status.text}</p>`;
}
function selectRoot(current) {
  return current.root;
}
export function GitLabPaste(props) {
  const root = useStore(selectRoot);
  return html`<${GitLabPasteRow} key=${root} root=${root} ...${props} />`;
}
// Opens the Add link dialog for a card edited in `origin.mode`.
export function addGitLabLink(item, origin) {
  if (origin.mode === 'modal') closeEditor();
  openDialog('link.add', {
    item,
    draft: origin.draft,
    mode: origin.mode,
    originFocusKey: origin.originFocusKey,
    previousLinkIDs: itemLinkIDs(state.board, item.id),
    root: state.root,
  });
}
// The merge-request picker owns its search: one request per project, quick
// scope and debounced query once its menu has opened. It is keyed by project and
// scope, so a change starts a fresh picker and cancels pending results.
function GitLabLinkPicker({ root, project, scope, value, onChange }) {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  const search = useDebouncedValue(query, 250);
  const result = useRequest(
    (signal) =>
      opened && project
        ? loadGitLabMergeRequests(root, { project, scope, search }, signal)
        : Promise.resolve(undefined),
    [root, project, scope, search, opened],
  );
  const status = !project
    ? 'Select an approved project first.'
    : result.loading
      ? 'Searching GitLab…'
      : result.error
        ? result.error.message
        : result.data
          ? result.data.length
            ? ''
            : 'No matching merge requests.'
          : 'Open the merge-request picker to load results.';
  return html`<${MultiSelect}
    name="merge_request"
    title="Merge request"
    entries=${mergeRequestEntries(result.data || [], value)}
    value=${value}
    status=${status}
    single=${true}
    filterMaxLength=${120}
    helpText="After trying a quick scope, search by title or IID. Results are ordered by GitLab update time; selecting one stores only its project-scoped IID."
    onChange=${onChange}
    onQuery=${setQuery}
    onOpenChange=${(next) => {
      if (next) setOpened(true);
    }}
  />`;
}
export function AddLinkDialog({ item, root }) {
  const catalog = useRequest((signal) => loadGitLabProjects(root, signal), [root]);
  const [project, setProject] = useState('');
  const [scope, setScope] = useState('recent');
  const [mergeRequest, setMergeRequest] = useState([]);
  const [manualIID, setManualIID] = useState('');
  const projects = catalog.data || [];
  const catalogError = catalog.error?.message || '';
  return html`<${CommandDialog}
    title="Add link"
    titleExtra=${html` ${helpPopoverTemplate(
      'Choose an approved project and use a quick scope or merge-request search. Enter an MR IID only as a final fallback. Flux retrieves the latest pipeline status from the linked MR.',
      'GitLab links',
    )}`}
    command=${(data) => {
      const rawProject = String(data.get('project') || '');
      const selectedMR = String(data.get('merge_request') || '');
      const manual = String(data.get('manual_mr_iid') || '');
      const rawNumber = selectedMR || manual;
      if (!/^[1-9][0-9]*$/.test(rawProject) || !Number.isSafeInteger(Number(rawProject)))
        throw new Error('Choose an approved GitLab project.');
      if (selectedMR && manual)
        throw new Error('Select a merge request or enter its IID manually, not both.');
      if (!/^[1-9][0-9]*$/.test(rawNumber) || !Number.isSafeInteger(Number(rawNumber)))
        throw new Error('Select a merge request or enter a positive MR IID.');
      return {
        kind: 'link.attach',
        target: item.id,
        link: { project: Number(rawProject), kind: 'mr', number: Number(rawNumber) },
      };
    }}
  >
    ${
      catalogError
        ? errorLineTemplate(
            `Could not load the GitLab project list. ${catalogError} Approved project IDs remain available so this link is not blocked by a temporary catalog failure.`,
          )
        : null
    }
    <${MultiSelect}
      name="project"
      title="Approved GitLab project"
      entries=${approvedGitLabProjectEntries(projects)}
      single=${true}
      helpText="Choose one approved project. The project list is provided by the configured GitLab connector and is searchable."
      onChange=${(values) => {
        setProject(values[0] || '');
        setMergeRequest([]);
        setManualIID('');
      }}
    />
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
        onChange: (event) => {
          setScope(event.currentTarget.value);
          setMergeRequest([]);
        },
      },
    )}
    <${GitLabLinkPicker}
      key=${`${project}\u0000${scope}`}
      root=${root}
      project=${project}
      scope=${scope}
      value=${mergeRequest}
      onChange=${(values) => {
        setMergeRequest(values);
        if (values.length) setManualIID('');
      }}
    />
    <label
      >MR IID (optional fallback)<input
        name="manual_mr_iid"
        type="number"
        autocomplete="off"
        min="1"
        max=${Number.MAX_SAFE_INTEGER}
        step="1"
        value=${manualIID}
        onInput=${(event) => setManualIID(event.currentTarget.value)}
    /></label>
    ${
      !projects.length &&
      !catalogError &&
      !catalog.loading &&
      !state.board.integration.projects.length
        ? helpTextTemplate('No approved GitLab projects are available for linking.')
        : null
    }
  </${CommandDialog}>`;
}
AddLinkDialog.onClose = returnToCard;
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
