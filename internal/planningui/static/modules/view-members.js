// The Members page and member dialogs.
import { $, el, field } from './dom.js';
import {
  renderPage,
  sectionHeadTemplate,
  helpText,
  helpTextTemplate,
  emptyStateTemplate,
  maintenanceListTemplate,
  maintenanceRowTemplate,
} from './layout.js';
import { html, nodeOf, nothing, repeat } from './lit.js';
import { state } from './state.js';
import { adminIconTemplate, adminWritable, accessButtonTemplate } from './permissions.js';
import { memberListingInfo, avatarTemplate } from './people.js';
import { multiSelect } from './multi-select.js';
import { memberUserEntries, loadGitLabUsers } from './gitlab-catalog.js';
import { openEditor } from './dialog.js';

const MEMBER_ROLE_ENTRIES = [
  ['viewer', 'Viewer'],
  ['member', 'Member'],
  ['admin', 'Admin'],
];
function memberRoleLabel(role) {
  return MEMBER_ROLE_ENTRIES.find(([value]) => value === role)?.[1] || role;
}
function memberRoleChipTemplate(role) {
  const roleClass = MEMBER_ROLE_ENTRIES.some(([value]) => value === role) ? role : 'unknown';
  return html`<span
    class=${`badge member-role member-role-${roleClass}`}
    aria-label=${`Role: ${memberRoleLabel(role)}`}
  >${memberRoleLabel(role)}</span>`;
}
function memberIdentityTemplate(member) {
  const info = memberListingInfo(member);
  const username = String(member.username || '').trim();
  return html`<div class="member-identity">
    ${avatarTemplate(info.name, info.avatarURL)}
    <div class="member-identity-copy">
      <strong>${info.name}</strong>
      <div class="member-identity-meta">
        ${username ? html`<small class="muted">${`@${username}`}</small>` : nothing}
        ${memberRoleChipTemplate(member.role)}
      </div>
    </div>
  </div>`;
}
function memberIdentityView(member) {
  return nodeOf(memberIdentityTemplate(member));
}
function editMember(member) {
  if (!adminWritable()) return;
  $('editor').close();
  openEditor(
    'Edit workspace member',
    (fields) => {
      const subject = field(fields, 'subject', 'GitLab subject', member.subject);
      subject.readOnly = true;
      subject.setAttribute('aria-readonly', 'true');
      const name = field(fields, 'name', 'Workspace name', member.name || '');
      name.maxLength = 120;
      name.placeholder = 'Optional admin-maintained name';
      field(fields, 'role', 'Workspace role', member.role, 'text', MEMBER_ROLE_ENTRIES);
      fields.append(
        helpText('Leave the workspace name blank to use the available GitLab profile name.'),
      );
    },
    (data) => ({
      kind: 'member.save',
      target: member.subject,
      member: { subject: member.subject, name: data.get('name').trim(), role: data.get('role') },
    }),
  );
  $('save').textContent = 'Save member';
}
function removeMember(member) {
  if (!adminWritable()) return;
  const assigned = state.board.items.filter((item) => item.assignee === member.subject).length;
  $('editor').close();
  openEditor(
    'Remove workspace member',
    (fields) => {
      fields.append(
        memberIdentityView(member),
        el(
          'p',
          `Remove ${memberListingInfo(member).name} from this workspace? Workspace history is retained.`,
        ),
      );
      if (assigned)
        fields.append(
          helpText(
            `This member is assigned to ${assigned} card${assigned === 1 ? '' : 's'}. Reassign those cards before removing the member.`,
          ),
        );
    },
    () => ({ kind: 'member.delete', target: member.subject }),
  );
  $('save').textContent = 'Remove member';
}
function addMember() {
  if (!adminWritable()) return;
  const currentBoard = state.board,
    currentRoot = state.root;
  $('editor').close();
  openEditor(
    'Add workspace member',
    (fields) => {
      fields.append(
        helpText(
          'Search active users from the configured GitLab instance. Adding a user grants access to this workspace only; it does not change GitLab permissions.',
        ),
      );
      let searchTimer,
        searchGeneration = 0,
        nameEdited = false;
      const usersBySubject = new Map();
      let subjectInput, nameInput;
      const syncSelectedUser = (values) => {
        const subject = String(values[0] || '');
        subjectInput.value = subject;
        if (!nameEdited) nameInput.value = usersBySubject.get(subject)?.name || '';
      };
      const queueUsers = (query, controls) => {
        if (searchTimer) clearTimeout(searchTimer);
        const generation = ++searchGeneration;
        const search = query.trim();
        controls.setStatus(search ? 'Searching GitLab…' : 'Loading GitLab users…');
        searchTimer = setTimeout(
          async () => {
            try {
              const users = await loadGitLabUsers(currentRoot, search);
              if (
                generation !== searchGeneration ||
                state.board !== currentBoard ||
                state.root !== currentRoot
              )
                return;
              users.forEach((user) => usersBySubject.set(String(user.id), user));
              const selected = controls.selected();
              const entries = memberUserEntries(users, selected);
              controls.setEntries(entries, selected);
              controls.setStatus(
                entries.length ? '' : 'No available GitLab users match this search.',
              );
            } catch (error) {
              if (
                generation === searchGeneration &&
                state.board === currentBoard &&
                state.root === currentRoot
              )
                controls.setStatus(error.message || String(error));
            }
          },
          search ? 250 : 0,
        );
      };
      multiSelect(
        fields,
        'gitlab_user',
        'GitLab user',
        [],
        [],
        undefined,
        'Only users returned by the configured server-side GitLab connector can be added. Existing workspace members are omitted.',
        { single: true, onOpen: queueUsers, onFilter: queueUsers, onChange: syncSelectedUser },
      );
      subjectInput = field(fields, 'subject', 'GitLab subject', '');
      subjectInput.readOnly = true;
      subjectInput.required = true;
      subjectInput.placeholder = 'Select a GitLab user';
      subjectInput.setAttribute('aria-readonly', 'true');
      nameInput = field(fields, 'name', 'Workspace name', '');
      nameInput.maxLength = 120;
      nameInput.placeholder = 'Defaults to the GitLab profile name';
      nameInput.addEventListener('input', () => {
        nameEdited = true;
      });
      field(fields, 'role', 'Workspace role', 'member', 'text', MEMBER_ROLE_ENTRIES);
      if (!currentBoard.connector_instance)
        fields.append(
          helpText(
            'A GitLab read connector is not configured. Ask the operator to set FLUX_GITLAB_URL and FLUX_GITLAB_SERVICE_TOKEN.',
          ),
        );
    },
    (data) => {
      const subject = String(data.get('gitlab_user') || '').trim();
      if (!/^[1-9][0-9]*$/.test(subject) || !Number.isSafeInteger(Number(subject)))
        throw new Error('Select an available GitLab user.');
      return {
        kind: 'member.save',
        member: { subject, role: data.get('role'), name: String(data.get('name') || '').trim() },
      };
    },
  );
  $('save').textContent = 'Add member';
}
export function renderMembers(content) {
  const members = state.board.members;
  $('count').textContent = `${members.length} member${members.length === 1 ? '' : 's'}`;
  const admin = state.board.role === 'admin';
  const rows = repeat(
    members,
    (member) => member.subject,
    (member) =>
      maintenanceRowTemplate({
        content: [memberIdentityTemplate(member)],
        actions: admin
          ? [
              adminIconTemplate('Edit member', '✎', () => editMember(member)),
              adminIconTemplate('Remove member', '−', () => removeMember(member), 'danger'),
            ]
          : [],
      }),
  );
  renderPage(
    content,
    'members',
    html`${sectionHeadTemplate(
      'Workspace members',
      admin
        ? accessButtonTemplate('＋ Add member', addMember, {
            className: 'primary',
            access: 'admin',
          })
        : undefined,
    )}
    ${helpTextTemplate(
      admin
        ? 'Manage workspace access and roles. OAuth supplies the signed-in user’s GitLab profile; other numeric members need the server-side read connector for names, usernames, and avatars. Bootstrap, non-GitLab, or unavailable profiles may not have a username or avatar.'
        : 'Review workspace members and roles. Only workspace admins can add members, remove members, change roles, or maintain display names.',
    )}
    ${members.length ? maintenanceListTemplate('', rows) : emptyStateTemplate('No workspace members yet.')}`,
  );
}
