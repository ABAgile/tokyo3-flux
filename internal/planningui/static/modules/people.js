// Member names, avatars and the participant stack. Helpers take the board
// lookups (`boardLookups`) or the session they read.
import { initials } from './format.js';
import { classNames } from './dom.js';
import { html } from './vdom.js';
import { useState } from './vendor-preact.js';

/** @type {readonly never[]} */
const NO_PARTICIPANTS = Object.freeze([]);

/**
 * @param {Flux.Lookups} lookups
 * @param {string} subject
 * @returns {{ name: string, avatarURL: string }}
 */
export function memberInfo(lookups, subject) {
  const { session } = lookups;
  const member = lookups.membersBySubject.get(subject);
  const name =
    member?.name ||
    (subject === session?.subject && session.name) ||
    (subject ? `Unnamed member (${subject})` : 'Unassigned');
  return {
    name,
    avatarURL: member?.avatar_url || (subject === session?.subject && session.avatar_url) || '',
  };
}
/**
 * @param {Flux.Lookups} lookups
 * @param {string} subject
 */
export function memberName(lookups, subject) {
  return memberInfo(lookups, subject).name;
}
/**
 * @param {Flux.Member} member
 * @param {Flux.Session | undefined} session
 * @returns {{ name: string, avatarURL: string }}
 */
export function memberListingInfo(member, session) {
  const name =
    String(member.name || '').trim() ||
    (member.subject === session?.subject && String(session.name || '').trim()) ||
    String(member.username || '').trim() ||
    'Unnamed member';
  return {
    name,
    avatarURL:
      member.avatar_url || (member.subject === session?.subject && session.avatar_url) || '',
  };
}
function AvatarImage({ url }) {
  const [failed, setFailed] = useState(false);
  return failed
    ? null
    : html`<img src=${url} alt="" decoding="async" referrerpolicy="no-referrer" onError=${() => setFailed(true)} />`;
}
// Failure is component state, never removal of a Preact-owned DOM node.
// A changed URL gets a fresh component and can retry independently.
export function avatarImageTemplate(avatarURL) {
  return avatarURL ? html`<${AvatarImage} key=${avatarURL} url=${avatarURL} />` : null;
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
/**
 * @param {Flux.Lookups} lookups
 * @param {Flux.Item} item
 * @returns {readonly Flux.Participant[]}
 */
export function itemParticipants(lookups, item) {
  return lookups.participantsByItem.get(item.id) || NO_PARTICIPANTS;
}
/**
 * @param {Flux.Lookups} lookups
 * @param {Flux.Participant} participant
 */
export function participantInfo(lookups, participant) {
  const { session } = lookups;
  const member = lookups.membersBySubject.get(participant.subject);
  // An admin-maintained workspace name wins over the provider's, so a card and
  // the roster never disagree about the same person.
  const name =
    member?.name ||
    String(participant.name || '').trim() ||
    (participant.subject === session?.subject && session.name) ||
    (participant.username ? `@${participant.username}` : `Unnamed member (${participant.subject})`);
  const roles = (participant.roles || []).map((role) => PARTICIPANT_ROLE_LABELS[role] || role);
  return {
    name,
    roles,
    avatarURL:
      participant.avatar_url ||
      member?.avatar_url ||
      (participant.subject === session?.subject && session.avatar_url) ||
      '',
    assignee: (participant.roles || []).includes('assignee'),
  };
}
function participantDescription(lookups, participant) {
  const info = participantInfo(lookups, participant);
  return info.roles.length ? `${info.name} \u00b7 ${info.roles.join(', ')}` : info.name;
}
function participantAvatarTemplate(lookups, participant) {
  const info = participantInfo(lookups, participant);
  const description = participantDescription(lookups, participant);
  // The assignee keeps a static accent ring so the planning owner is legible
  // without colour alone and without motion.
  const classes = { avatar: true, 'participant-avatar': true, 'is-assignee': info.assignee };
  return html`<span
    class=${classNames(classes)}
    data-participant-role=${info.assignee ? 'assignee' : null}
    title=${description}
    role="img"
    aria-label=${description}
  >
    <span class="avatar-fallback">${initials(info.name)}</span>
    ${avatarImageTemplate(info.avatarURL)}
  </span>`;
}
/**
 * @param {Flux.Lookups} lookups
 * @param {Flux.Item} item
 */
export function participantStackTemplate(lookups, item) {
  const participants = itemParticipants(lookups, item);
  const describe = (participant) => participantDescription(lookups, participant);
  if (!participants.length)
    return html`<div class="participant-stack" data-card-section="participants" aria-label="No participants · unassigned">
      <span class="participant-empty">Unassigned</span>
    </div>`;
  const label = `Participants: ${participants.map(describe).join('; ')}`;
  const overflow = participants.length - PARTICIPANT_STACK_LIMIT;
  const rest = participants.slice(PARTICIPANT_STACK_LIMIT).map(describe).join('; ');
  return html`<div class="participant-stack" data-card-section="participants" role="group" aria-label=${label}>
    ${participants
      .slice(0, PARTICIPANT_STACK_LIMIT)
      .map((participant) => participantAvatarTemplate(lookups, participant))}
    ${
      overflow > 0
        ? html`<span class="participant-more" title=${rest} role="img" aria-label=${`${overflow} more: ${rest}`}>${`+${overflow}`}</span>`
        : null
    }
  </div>`;
}
