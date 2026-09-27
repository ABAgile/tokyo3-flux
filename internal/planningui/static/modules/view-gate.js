// The first-run checklist shown on a brand-new board.
import { html } from './vdom.js';
import { FirstRunChecklist } from './gate-components.js';
import { navigate, newItem } from './actions.js';

// A brand-new board shows a short setup path instead of empty columns, so the
// workspace-creation momentum carries into the first sprint and card.
export function FirstRunPage({ board, disabled }) {
  const steps = [
    {
      done: board.projects.length > 0,
      title: 'Create a project',
      help: 'Projects classify work items; they are optional but make filtering and the project lens useful.',
      action: 'Open Projects',
      run: () => navigate('projects'),
    },
    {
      done: board.sprints.length > 0,
      title: 'Create and start a sprint',
      help: 'Give the sprint a goal and a time box, then start it so the board can show active scope.',
      action: 'Open Sprints',
      run: () => navigate('sprints'),
    },
    {
      done: board.items.length > 0,
      title: 'Add your first work item',
      help: 'Every card belongs to a board column; sprints and projects can be added at any time.',
      action: '＋ New item',
      run: newItem,
    },
  ];
  return html`<section class="panel first-run" data-content-view="first-run" aria-labelledby="first-run-heading">
    <${FirstRunChecklist} steps=${steps} disabled=${disabled} />
  </section>`;
}
export function showFirstRun(current, view = current.view) {
  return (
    view === 'board' &&
    current.board.role !== 'viewer' &&
    !current.board.items.length &&
    !current.board.sprints.length &&
    !current.searchQuery
  );
}
