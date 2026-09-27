// Server-side GitLab catalogs: projects, users and merge requests.
import { api } from './api.js';
import { requireBoard } from './state.js';

export function gitlabProjectLabel(project) {
  const name = String(project.name || '').trim();
  const path = String(project.path_with_namespace || '').trim();
  return `${name}${path && path !== name ? ` · ${path}` : ''} (#${project.id})`;
}
export function integrationProjectEntries(projects, selected) {
  const entries = [];
  const seen = new Set();
  projects.forEach((project) => {
    if (
      !Number.isSafeInteger(project.id) ||
      project.id <= 0 ||
      typeof project.name !== 'string' ||
      !project.name.trim()
    )
      return;
    const value = String(project.id);
    if (seen.has(value)) return;
    seen.add(value);
    entries.push([value, gitlabProjectLabel(project)]);
  });
  selected.forEach((value) => {
    if (!seen.has(value)) entries.push([value, `Project ${value} (currently approved)`]);
  });
  return entries;
}
function gitLabUserLabel(user) {
  const name =
    String(user.name || '').trim() ||
    String(user.username || '').trim() ||
    `GitLab user ${user.id}`;
  const username = String(user.username || '').trim();
  return `${name}${username && username !== name ? ` · @${username}` : ''} (#${user.id})`;
}
function validGitLabUserCatalog(data) {
  return (
    Array.isArray(data) &&
    data.every(
      (user) =>
        user &&
        Number.isSafeInteger(user.id) &&
        user.id > 0 &&
        typeof user.username === 'string' &&
        user.username.trim() &&
        typeof user.name === 'string' &&
        user.name.trim() &&
        (user.avatar_url === undefined || typeof user.avatar_url === 'string'),
    )
  );
}
export function memberUserEntries(users, selected = []) {
  const entries = [],
    seen = new Set(),
    existing = new Set(requireBoard().members.map((member) => member.subject)),
    selectedSet = new Set(selected.map(String));
  users.forEach((user) => {
    const value = String(user.id);
    if (seen.has(value) || (existing.has(value) && !selectedSet.has(value))) return;
    seen.add(value);
    entries.push([value, gitLabUserLabel(user)]);
  });
  selected.forEach((value) => {
    value = String(value);
    if (seen.has(value)) return;
    seen.add(value);
    entries.push([value, `GitLab user #${value} (currently selected)`]);
  });
  return entries;
}
export async function loadGitLabUsers(currentRoot, search = '', signal) {
  const params = new URLSearchParams({ search });
  const data = await api(currentRoot + '/gitlab/users?' + params, { signal });
  if (!validGitLabUserCatalog(data))
    throw new Error('GitLab user results are invalid. Refresh to retry.');
  return data;
}
function validGitLabProjectCatalog(data) {
  return (
    Array.isArray(data) &&
    data.every(
      (project) =>
        project &&
        Number.isSafeInteger(project.id) &&
        project.id > 0 &&
        typeof project.name === 'string' &&
        project.name.trim(),
    )
  );
}
export async function loadGitLabProjects(currentRoot, signal) {
  const data = await api(currentRoot + '/gitlab/projects', { signal });
  if (!validGitLabProjectCatalog(data))
    throw new Error('GitLab project catalog is invalid. Refresh to retry.');
  return data;
}
export async function loadGitLabMergeRequests(currentRoot, { project, scope, search }, signal) {
  const params = new URLSearchParams({ project, scope: scope || 'recent', search });
  const data = await api(`${currentRoot}/gitlab/merge-requests?${params}`, { signal });
  if (!validGitLabMergeRequestCatalog(data))
    throw new Error('GitLab merge-request results are invalid. Refresh to retry.');
  return data;
}
export function approvedGitLabProjectEntries(projects) {
  const approved = new Set(requireBoard().integration.projects.map(String));
  return integrationProjectEntries(
    projects.filter((project) => approved.has(String(project.id))),
    requireBoard().integration.projects.map(String),
  );
}
function mergeRequestLabel(mergeRequest) {
  const title = String(mergeRequest.title || '').trim();
  const state = String(mergeRequest.state || '').trim();
  const timestamp =
    typeof mergeRequest.updated_at === 'string' ? Date.parse(mergeRequest.updated_at) : NaN;
  const updated = Number.isNaN(timestamp)
    ? ''
    : ` · updated ${new Date(timestamp).toLocaleDateString()}`;
  return `MR !${mergeRequest.iid} · ${title}${state ? ` · ${state}` : ''}${mergeRequest.draft ? ' · Draft' : ''}${updated}`;
}
function validGitLabMergeRequestCatalog(data) {
  return (
    Array.isArray(data) &&
    data.every(
      (mergeRequest) =>
        mergeRequest &&
        Number.isSafeInteger(mergeRequest.iid) &&
        mergeRequest.iid > 0 &&
        typeof mergeRequest.title === 'string' &&
        mergeRequest.title.trim(),
    )
  );
}
export function mergeRequestEntries(mergeRequests, selected) {
  const entries = [];
  const seen = new Set();
  mergeRequests.forEach((mergeRequest) => {
    if (
      !Number.isSafeInteger(mergeRequest.iid) ||
      mergeRequest.iid <= 0 ||
      typeof mergeRequest.title !== 'string' ||
      !mergeRequest.title.trim()
    )
      return;
    const value = String(mergeRequest.iid);
    if (seen.has(value)) return;
    seen.add(value);
    entries.push([value, mergeRequestLabel(mergeRequest)]);
  });
  selected.forEach((value) => {
    if (!seen.has(value)) entries.push([value, `MR !${value} (currently selected)`]);
  });
  return entries;
}
// Link identity and cached observations, compared when the idle poll reloads them.
export function linkIdentitySignature(link) {
  return JSON.stringify({
    id: link.id,
    project: link.project,
    kind: link.kind,
    number: link.number,
    items: [...(link.items || [])].sort(),
  });
}
function observationSignature(link) {
  return JSON.stringify({
    observation: link.observation || null,
    last_success: link.last_success || null,
    last_attempt: link.last_attempt || null,
    outcome: link.outcome || '',
    next_refresh: link.next_refresh || null,
    refresh_pending: !!link.refresh_pending,
  });
}
export function observationsChanged(previousLinks, nextLinks) {
  const previous = new Map(previousLinks.map((link) => [link.id, link]));
  return nextLinks.some(
    (link) =>
      previous.has(link.id) &&
      observationSignature(previous.get(link.id)) !== observationSignature(link),
  );
}
