// Member names, avatars and the participant stack.
import { initials } from './format.js';
import { classMap, html, keyed, nodeOf, nothing } from './lit.js';
import { state } from './state.js';

export function memberInfo(subject) {
  const member = state.board.members.find((m) => m.subject === subject);
  const name =
    member?.name ||
    (subject === state.session?.subject && state.session.name) ||
    (subject ? `Unnamed member (${subject})` : 'Unassigned');
  return {
    name,
    avatarURL:
      member?.avatar_url || (subject === state.session?.subject && state.session.avatar_url) || '',
  };
}
export function memberName(subject) {
  return memberInfo(subject).name;
}
export function memberListingInfo(member) {
  const name =
    String(member.name || '').trim() ||
    (member.subject === state.session?.subject && String(state.session.name || '').trim()) ||
    String(member.username || '').trim() ||
    'Unnamed member';
  return {
    name,
    avatarURL:
      member.avatar_url ||
      (member.subject === state.session?.subject && state.session.avatar_url) ||
      '',
  };
}
function removeImage(event) {
  event.currentTarget.remove();
}
// A failed image removes itself so the initials show; `keyed` gives a changed
// URL a fresh <img> instead of reusing the removed one.
function avatarImageTemplate(avatarURL) {
  if (!avatarURL) return nothing;
  return keyed(
    avatarURL,
    html`<img src=${avatarURL} alt="" decoding="async" referrerpolicy="no-referrer" @error=${removeImage}>`,
  );
}
export function avatarTemplate(name, avatarURL) {
  return html`<span class="avatar" aria-hidden="true">
    <span class="avatar-fallback">${initials(name)}</span>
    ${avatarImageTemplate(avatarURL)}
  </span>`;
}
// Participants are derived server-side from assignment, cached reviewers and
// comment authors, so a card states who is involved without one request per
// card. A reviewer who is not a workspace member carries its own provider
// identity; everyone else resolves against the workspace roster.
const PARTICIPANT_ROLE_LABELS = Object.freeze({
  assignee: 'Assignee',
  reviewer: 'Reviewer',
  commenter: 'Commenter',
});
const PARTICIPANT_STACK_LIMIT = 4;
export function itemParticipants(item) {
  return (state.board.participants || []).filter((participant) => participant.item_id === item.id);
}
export function participantInfo(participant) {
  const member = state.board.members.find((value) => value.subject === participant.subject);
  // An admin-maintained workspace name wins over the provider's, so a card and
  // the roster never disagree about the same person.
  const name =
    member?.name ||
    String(participant.name || '').trim() ||
    (participant.subject === state.session?.subject && state.session.name) ||
    (participant.username ? `@${participant.username}` : `Unnamed member (${participant.subject})`);
  const roles = (participant.roles || []).map((role) => PARTICIPANT_ROLE_LABELS[role] || role);
  return {
    name,
    roles,
    avatarURL:
      participant.avatar_url ||
      member?.avatar_url ||
      (participant.subject === state.session?.subject && state.session.avatar_url) ||
      '',
    assignee: (participant.roles || []).includes('assignee'),
  };
}
function participantDescription(participant) {
  const info = participantInfo(participant);
  return info.roles.length ? `${info.name} \u00b7 ${info.roles.join(', ')}` : info.name;
}
function participantAvatarTemplate(participant) {
  const info = participantInfo(participant);
  const description = participantDescription(participant);
  // The assignee keeps a static accent ring so the planning owner is legible
  // without colour alone and without motion.
  const classes = { avatar: true, 'participant-avatar': true, 'is-assignee': info.assignee };
  return html`<span
    class=${classMap(classes)}
    data-participant-role=${info.assignee ? 'assignee' : nothing}
    title=${description}
    role="img"
    aria-label=${description}
  >
    <span class="avatar-fallback">${initials(info.name)}</span>
    ${avatarImageTemplate(info.avatarURL)}
  </span>`;
}
export function participantStackTemplate(item) {
  const participants = itemParticipants(item);
  if (!participants.length)
    return html`<div class="participant-stack" data-card-section="participants" aria-label="No participants · unassigned">
      <span class="participant-empty">Unassigned</span>
    </div>`;
  const label = `Participants: ${participants.map(participantDescription).join('; ')}`;
  const overflow = participants.length - PARTICIPANT_STACK_LIMIT;
  const rest = participants.slice(PARTICIPANT_STACK_LIMIT).map(participantDescription).join('; ');
  return html`<div class="participant-stack" data-card-section="participants" role="group" aria-label=${label}>
    ${participants.slice(0, PARTICIPANT_STACK_LIMIT).map(participantAvatarTemplate)}
    ${
      overflow > 0
        ? html`<span class="participant-more" title=${rest} role="img" aria-label=${`${overflow} more: ${rest}`}>${`+${overflow}`}</span>`
        : nothing
    }
  </div>`;
}
export function participantStack(item) {
  return nodeOf(participantStackTemplate(item));
}
