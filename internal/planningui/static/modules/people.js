// Member names, avatars and the participant stack.
import { el } from './dom.js';
import { initials } from './format.js';
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
export function avatarView(name, avatarURL) {
  const avatar = el('span', undefined, 'avatar');
  avatar.setAttribute('aria-hidden', 'true');
  avatar.append(el('span', initials(name), 'avatar-fallback'));
  if (avatarURL) {
    const image = el('img');
    image.src = avatarURL;
    image.alt = '';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.onerror = () => image.remove();
    avatar.append(image);
  }
  return avatar;
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
export function participantStack(item) {
  const participants = itemParticipants(item);
  const stack = el('div', undefined, 'participant-stack');
  stack.dataset.cardSection = 'participants';
  if (!participants.length) {
    stack.append(el('span', 'Unassigned', 'participant-empty'));
    stack.setAttribute('aria-label', 'No participants \u00b7 unassigned');
    return stack;
  }
  stack.setAttribute('role', 'group');
  stack.setAttribute(
    'aria-label',
    `Participants: ${participants.map(participantDescription).join('; ')}`,
  );
  participants.slice(0, PARTICIPANT_STACK_LIMIT).forEach((participant) => {
    const info = participantInfo(participant);
    const description = participantDescription(participant);
    const avatar = avatarView(info.name, info.avatarURL);
    avatar.classList.add('participant-avatar');
    // The assignee keeps a static accent ring so the planning owner is legible
    // without colour alone and without motion.
    if (info.assignee) {
      avatar.classList.add('is-assignee');
      avatar.dataset.participantRole = 'assignee';
    }
    avatar.title = description;
    avatar.removeAttribute('aria-hidden');
    avatar.setAttribute('role', 'img');
    avatar.setAttribute('aria-label', description);
    stack.append(avatar);
  });
  const overflow = participants.length - PARTICIPANT_STACK_LIMIT;
  if (overflow > 0) {
    const more = el('span', `+${overflow}`, 'participant-more');
    const rest = participants.slice(PARTICIPANT_STACK_LIMIT).map(participantDescription).join('; ');
    more.title = rest;
    more.setAttribute('role', 'img');
    more.setAttribute('aria-label', `${overflow} more: ${rest}`);
    stack.append(more);
  }
  return stack;
}
