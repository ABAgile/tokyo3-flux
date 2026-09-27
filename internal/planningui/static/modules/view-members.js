// The Members page and member dialogs.
import {
  fieldTemplate,
  sectionHeadTemplate,
  helpTextTemplate,
  emptyStateTemplate,
  maintenanceListTemplate,
  maintenanceRowTemplate,
} from './layout.js';
import { html } from './vdom.js';
import { useRef, useState } from './vendor-preact.js';

import { state, useStore } from './state.js';
import { adminIconTemplate, adminWritable, accessButtonTemplate } from './permissions.js';
import { memberListingInfo, avatarTemplate } from './people.js';
import { MultiSelect } from './multi-select.js';
import { memberUserEntries, loadGitLabUsers } from './gitlab-catalog.js';
import { openDialog } from './dialog-state.js';
import { CommandDialog } from './dialog.js';
import { useDebouncedValue, useRequest } from './ui-hooks.js';

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
function memberIdentityTemplate(member, session) {
  const info = memberListingInfo(member, session);
  const username = String(member.username || '').trim();
  return html`<div class="member-identity">
    ${avatarTemplate(info.name, info.avatarURL)}
    <div class="member-identity-copy">
      <strong>${info.name}</strong>
      <div class="member-identity-meta">
        ${username ? html`<small class="muted">${`@${username}`}</small>` : null}
        ${memberRoleChipTemplate(member.role)}
      </div>
    </div>
  </div>`;
}
export function MemberDialog({ member }) {
  return html`<${CommandDialog}
    title="Edit workspace member"
    saveText="Save member"
    command=${(data) => ({
      kind: 'member.save',
      target: member.subject,
      member: { subject: member.subject, name: data.get('name').trim(), role: data.get('role') },
    })}
  >
    ${fieldTemplate('subject', 'GitLab subject', member.subject, 'text', undefined, {
      readOnly: true,
    })}
    ${fieldTemplate('name', 'Workspace name', member.name || '', 'text', undefined, {
      maxLength: 120,
      placeholder: 'Optional admin-maintained name',
    })}
    ${fieldTemplate('role', 'Workspace role', member.role, 'text', MEMBER_ROLE_ENTRIES)}
    ${helpTextTemplate('Leave the workspace name blank to use the available GitLab profile name.')}
  </${CommandDialog}>`;
}
function editMember(member) {
  if (adminWritable()) openDialog('member.edit', { member });
}
function selectSession(current) {
  return current.session;
}
export function RemoveMemberDialog({ member, assigned }) {
  const session = useStore(selectSession);
  return html`<${CommandDialog}
    title="Remove workspace member"
    saveText="Remove member"
    command=${() => ({ kind: 'member.delete', target: member.subject })}
  >
    ${memberIdentityTemplate(member, session)}
    <p>${`Remove ${memberListingInfo(member, session).name} from this workspace? Workspace history is retained.`}</p>
    ${
      assigned
        ? helpTextTemplate(
            `This member is assigned to ${assigned} card${assigned === 1 ? '' : 's'}. Reassign those cards before removing the member.`,
          )
        : null
    }
  </${CommandDialog}>`;
}
function removeMember(member) {
  if (!adminWritable()) return;
  const assigned = state.board.items.filter((item) => item.assignee === member.subject).length;
  openDialog('member.remove', { member, assigned });
}
// The GitLab user picker searches while its menu is open; the typed query is
// debounced, the first open is immediate. Choosing a user fills the subject
// and, until the admin edits it, the workspace name.
export function AddMemberDialog({ root, connector }) {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState([]);
  const [name, setName] = useState('');
  const nameEdited = useRef(false);
  const users = useRef(new Map());
  const search = useDebouncedValue(query, query ? 250 : 0);
  // Results stay once loaded, so the chosen user keeps its label after the menu closes.
  const result = useRequest(
    (signal) => (opened ? loadGitLabUsers(root, search, signal) : Promise.resolve(undefined)),
    [root, search, opened],
  );
  for (const user of result.data || []) users.current.set(String(user.id), user);
  const entries = memberUserEntries(result.data || [], selected);
  const status = result.loading
    ? search
      ? 'Searching GitLab…'
      : 'Loading GitLab users…'
    : result.error
      ? result.error.message || String(result.error)
      : result.data && !entries.length
        ? 'No available GitLab users match this search.'
        : '';
  const subject = selected[0] || '';
  return html`<${CommandDialog}
    title="Add workspace member"
    saveText="Add member"
    command=${(data) => {
      const value = String(data.get('gitlab_user') || '').trim();
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new Error('Select an available GitLab user.');
      return {
        kind: 'member.save',
        member: {
          subject: value,
          role: data.get('role'),
          name: String(data.get('name') || '').trim(),
        },
      };
    }}
  >
    ${helpTextTemplate(
      'Search active users from the configured GitLab instance. Adding a user grants access to this workspace only; it does not change GitLab permissions.',
    )}
    <${MultiSelect}
      name="gitlab_user"
      title="GitLab user"
      entries=${entries}
      value=${selected}
      status=${status}
      single=${true}
      helpText="Only users returned by the configured server-side GitLab connector can be added. Existing workspace members are omitted."
      onQuery=${setQuery}
      onOpenChange=${(next) => {
        if (next) setOpened(true);
      }}
      onChange=${(values) => {
        setSelected(values);
        if (!nameEdited.current) setName(users.current.get(String(values[0] || ''))?.name || '');
      }}
    />
    <label
      >GitLab subject<input
        name="subject"
        type="text"
        autocomplete="off"
        required
        readonly
        aria-readonly="true"
        placeholder="Select a GitLab user"
        value=${subject}
    /></label>
    <label
      >Workspace name<input
        name="name"
        type="text"
        autocomplete="off"
        maxlength="120"
        placeholder="Defaults to the GitLab profile name"
        value=${name}
        onInput=${(event) => {
          nameEdited.current = true;
          setName(event.currentTarget.value);
        }}
    /></label>
    ${fieldTemplate('role', 'Workspace role', 'member', 'text', MEMBER_ROLE_ENTRIES)}
    ${
      connector
        ? null
        : helpTextTemplate(
            'A GitLab read connector is not configured. Ask the operator to set FLUX_GITLAB_URL and FLUX_GITLAB_SERVICE_TOKEN.',
          )
    }
  </${CommandDialog}>`;
}
function addMember() {
  if (!adminWritable()) return;
  openDialog('member.add', { root: state.root, connector: !!state.board.connector_instance });
}
const EMPTY_MEMBERS = [];
function selectMembersPage(current) {
  return {
    members: current.board?.members || EMPTY_MEMBERS,
    role: current.board?.role,
    session: current.session,
    busy: current.busy,
    loading: current.loading,
    integrationFormOpen: current.integrationFormOpen,
  };
}
function sameMembersPage(left, right) {
  return (
    left.members === right.members &&
    left.role === right.role &&
    left.session === right.session &&
    left.busy === right.busy &&
    left.loading === right.loading &&
    left.integrationFormOpen === right.integrationFormOpen
  );
}
export function MembersPage() {
  const { members, role, session } = useStore(selectMembersPage, sameMembersPage);
  const admin = role === 'admin';
  const rows = members.map((member) =>
    maintenanceRowTemplate({
      key: member.subject,
      content: [memberIdentityTemplate(member, session)],
      actions: admin
        ? [
            adminIconTemplate('Edit member', '✎', () => editMember(member)),
            adminIconTemplate('Remove member', '−', () => removeMember(member), 'danger'),
          ]
        : [],
    }),
  );
  return html`${sectionHeadTemplate(
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
    ${members.length ? maintenanceListTemplate('', rows) : emptyStateTemplate('No workspace members yet.')}`;
}
