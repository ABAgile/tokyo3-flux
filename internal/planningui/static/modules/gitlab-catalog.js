// Server-side GitLab catalogs: projects, users and merge requests.
import { api } from './api.js';
import { state } from './state.js';

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
    existing = new Set(state.board.members.map((member) => member.subject)),
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
export async function loadGitLabUsers(currentRoot, search = '') {
  const params = new URLSearchParams({ search });
  const data = await api(currentRoot + '/gitlab/users?' + params);
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
export async function loadGitLabProjects(currentRoot) {
  const data = await api(currentRoot + '/gitlab/projects');
  if (!validGitLabProjectCatalog(data))
    throw new Error('GitLab project catalog is invalid. Refresh to retry.');
  return data;
}
export function approvedGitLabProjectEntries(projects) {
  const approved = new Set(state.board.integration.projects.map(String));
  return integrationProjectEntries(
    projects.filter((project) => approved.has(String(project.id))),
    state.board.integration.projects.map(String),
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
export function validGitLabMergeRequestCatalog(data) {
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
