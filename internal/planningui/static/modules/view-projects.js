// The Projects page and project dialogs.
import {
  panelTemplate,
  sectionHeadTemplate,
  fieldTemplate,
  helpTextTemplate,
  emptyStateTemplate,
  filterBarTemplate,
  filterControlID,
  filterSelectTemplate,
  filterSearchTemplate,
  filterChipRowTemplate,
  filterSlotTemplate,
  maintenanceListTemplate,
  maintenanceRowTemplate,
} from './layout.js';
import { html, shallowEqual } from './vdom.js';
import { useId, useReducer } from './vendor-preact.js';

import { setState, useStore } from './state.js';
import { actionIconTemplate, writeIconTemplate, accessButtonTemplate } from './permissions.js';
import { itemProjectIDs } from './items.js';
import { memberName } from './people.js';
import { selectLookups } from './lookups.js';
import { gitlabProjectLabel, loadGitLabProjects } from './gitlab-catalog.js';
import { PROJECT_FILTER_NAMES, withFilterValue, matchesFilter, FilterChips } from './filters.js';
import { openDialog } from './dialog-state.js';
import { CommandDialog } from './dialog.js';
import { openProject } from './actions.js';
import { editIntegration, IntegrationForm } from './view-integration.js';
import { useRequest } from './ui-hooks.js';

/** @param {Flux.DialogProps['project.edit']} props */
export function ProjectDialog({ project }) {
  return html`<${CommandDialog}
    title=${project ? 'Edit project' : 'Create project'}
    command=${(data) => ({
      kind: 'project.save',
      target: project?.id || '',
      project: { ...(project || {}), name: data.get('name').trim() },
    })}
  >
    ${fieldTemplate('name', 'Project name', project?.name || '', 'text', undefined, {
      required: true,
      maxLength: 120,
    })}
    ${helpTextTemplate(
      'Projects classify work in this workspace. Boards, sprint scope, WIP and permissions stay workspace-wide.',
    )}
  </${CommandDialog}>`;
}
function editProject(project) {
  openDialog('project.edit', { project });
}
function projectMatchesFilters(board, project, filters) {
  if (!filters.assignee.length && !filters.label.length) return true;
  return board.items.some((item) =>
    item.archived
      ? false
      : itemProjectIDs(item).includes(project.id) &&
        matchesFilter(filters.assignee, item.assignee ? [item.assignee] : []) &&
        matchesFilter(filters.label, item.labels || []),
  );
}
function integrationProjectChipsTemplate(projectIDs, projects) {
  const catalog = new Map(projects.map((project) => [String(project.id), project]));
  return html`<div class="tags integration-project-chips" aria-label="Approved GitLab projects">
    ${projectIDs.map((id) => {
      const project = catalog.get(String(id));
      const label = project ? gitlabProjectLabel(project) : `GitLab project #${id}`;
      return html`<span key=${id} class="badge integration-project-chip" title=${label}>${label}</span>`;
    })}
  </div>`;
}
function integrationTemplate(page, approvedIDs, catalog) {
  const head = (...actions) => sectionHeadTemplate('GitLab integration', ...actions);
  const projects = catalog.data || [];
  const error = catalog.error?.message || '';
  if (page.integrationFormOpen) {
    return panelTemplate(
      'maintenance-section',
      html`${head()}<${IntegrationForm}
        board=${page.board}
        catalog=${projects}
        loading=${catalog.loading}
        error=${error}
        onRetry=${catalog.reload}
      />`,
    );
  }
  const configured = page.board.connector_instance || 'Not configured';
  const approved = approvedIDs.length;
  return panelTemplate(
    'maintenance-section',
    html`${head(accessButtonTemplate('Edit integration', editIntegration))}
    ${helpTextTemplate(`Operator-configured GitLab instance: ${configured}`)}
    ${helpTextTemplate(`${approved} approved GitLab project${approved === 1 ? '' : 's'}.`)}
    ${approved ? integrationProjectChipsTemplate(approvedIDs, projects) : null}
    ${catalog.loading ? helpTextTemplate('Loading approved GitLab project names…') : null}
    ${
      error
        ? helpTextTemplate(`Project names are unavailable; approved IDs remain visible. ${error}`)
        : null
    }
    ${
      page.board.connector_instance
        ? null
        : helpTextTemplate(
            'Ask the operator to set FLUX_GITLAB_URL and FLUX_GITLAB_SERVICE_TOKEN to enable the connector.',
          )
    }`,
  );
}
function projectRowsTemplate(page, matches, filtered, search) {
  if (!matches.length) {
    const narrowed = filtered.length !== page.board.projects.length;
    const message = !page.board.projects.length
      ? 'No projects yet. Items can remain unclassified.'
      : search && narrowed
        ? `No projects match \u201c${search}\u201d and the current filters.`
        : search
          ? `No projects match \u201c${search}\u201d.`
          : 'No projects hold work matching the current filters.';
    return emptyStateTemplate(message);
  }
  const openDisabled = page.busy || page.loading || page.integrationFormOpen;
  return matches.map((project) =>
    maintenanceRowTemplate({
      key: project.id,
      content: [html`<strong>${project.name}</strong>`],
      actions: [
        actionIconTemplate('View scope', '◎', () => openProject(project), {
          disabled: openDisabled,
        }),
        writeIconTemplate('Edit project', '✎', () => editProject(project)),
      ],
    }),
  );
}
function projectsTemplate(page, ids, rerender) {
  const search = page.projectSearch.trim();
  const query = search.toLowerCase();
  const filters = page.projectFilters;
  const filtered = page.board.projects.filter((project) =>
    projectMatchesFilters(page.board, project, filters),
  );
  const matches = filtered.filter((project) => project.name.toLowerCase().includes(query));
  // Each select adds one value and returns to its "any" entry.
  const addFilter = (name) => (event) => {
    const value = event.currentTarget.value;
    setState((current) => ({
      projectFilters: {
        ...current.projectFilters,
        [name]: withFilterValue(current.projectFilters[name], value),
      },
    }));
    rerender();
  };
  const controls = html`${filterSelectTemplate(
    'Assignee',
    [
      ['all', 'Any assignee'],
      ['none', 'Unassigned'],
      ...page.board.members.map((member) => [
        member.subject,
        memberName(page.lookups, member.subject),
      ]),
    ],
    ids.assignee,
    addFilter('assignee'),
  )}${filterSelectTemplate(
    'Label',
    [
      ['all', 'Any label'],
      ['none', 'No labels'],
      ...page.board.labels.map((label) => [label.name, label.name]),
    ],
    ids.label,
    addFilter('label'),
  )}${filterSearchTemplate(
    'Search',
    ids.search,
    { value: page.projectSearch, placeholder: 'Find projects…', maxLength: 120 },
    (event) => setState({ projectSearch: event.currentTarget.value }),
  )}`;
  const chips = FilterChips({
    group: filters,
    names: PROJECT_FILTER_NAMES,
    lookups: page.lookups,
    disabled: page.busy || page.loading,
    onChange: (next) => setState({ projectFilters: next }),
    clearLabel: 'Clear project filters',
  });
  const count = `${matches.length} project${matches.length === 1 ? '' : 's'}`;
  return html`<section class="workspace-projects">
    ${sectionHeadTemplate(
      'Workspace projects',
      accessButtonTemplate('＋ New project', () => editProject(), { className: 'primary' }),
    )}
    ${filterSlotTemplate(
      '',
      filterBarTemplate(controls, count),
      filterChipRowTemplate('Active project filters', chips),
    )}
    ${helpTextTemplate(
      'Projects classify work in this workspace. Boards, sprint scope, WIP and permissions stay workspace-wide. Assignee and Label filters list projects with current non-archived work matching every active filter; Unassigned and No labels match empty values.',
    )}
    ${maintenanceListTemplate('', projectRowsTemplate(page, matches, filtered, search))}
  </section>`;
}
const PROJECT_PAGE_KEYS = [
  'board',
  'root',
  'projectSearch',
  'projectFilters',
  'integrationFormOpen',
  'integrationSubmitting',
  'integrationFormError',
  'busy',
  'loading',
];
function selectProjectsPage(current) {
  return {
    ...Object.fromEntries(PROJECT_PAGE_KEYS.map((key) => [key, current[key]])),
    lookups: selectLookups(current),
  };
}
export function ProjectsPage() {
  const page = useStore(selectProjectsPage, shallowEqual);
  const board = page.board;
  const approvedIDs = board.integration?.projects || [];
  // Filter controls keep one generated id each for the life of the page.
  const idBase = useId();
  const ids = {
    assignee: filterControlID('Assignee', idBase),
    label: filterControlID('Label', idBase),
    search: filterControlID('Search', idBase),
  };
  // Project names come from the connector's catalog: for approved projects in
  // the summary, and for every visible project while the form is open, which
  // reloads it.
  const needed = !!board.connector_instance && (page.integrationFormOpen || approvedIDs.length > 0);
  const catalog = useRequest(
    (signal) => (needed ? loadGitLabProjects(page.root, signal) : Promise.resolve([])),
    [page.root, board.connector_instance, needed, page.integrationFormOpen],
  );
  const [, rerender] = useReducer((value) => value + 1, 0);
  const shown = { ...catalog, loading: needed && catalog.loading };
  return html`${integrationTemplate(page, approvedIDs, shown)}${projectsTemplate(page, ids, rerender)}`;
}
