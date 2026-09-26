// The Projects page and project dialogs.
import { $ } from './dom.js';
import {
  renderPage,
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
import { html, withKey, nothing, keyedList, useMemo, useRef } from './preact.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { actionIconTemplate, writeIconTemplate, accessButtonTemplate } from './permissions.js';
import { itemProjectIDs } from './items.js';
import { memberName } from './people.js';
import { gitlabProjectLabel } from './gitlab-catalog.js';
import {
  PROJECT_FILTER_NAMES,
  projectFilters,
  addFilterValue,
  setFilterValues,
  matchesFilter,
  filterChipTemplates,
  resetSearch,
} from './filters.js';
import { openEditor } from './dialog.js';
import { persistPlanningURL } from './url-state.js';
import { closeDetail } from './item-detail.js';
import {
  editIntegration,
  loadIntegrationCatalog,
  integrationFormTemplate,
} from './view-integration.js';

function editProject(project) {
  $('editor').close();
  openEditor(
    project ? 'Edit project' : 'Create project',
    () => html`${fieldTemplate('name', 'Project name', project?.name || '', 'text', undefined, {
      required: true,
      maxLength: 120,
    })}
      ${helpTextTemplate(
        'Projects classify work in this workspace. Boards, sprint scope, WIP and permissions stay workspace-wide.',
      )}`,
    (data) => ({
      kind: 'project.save',
      target: project?.id || '',
      project: { ...(project || {}), name: data.get('name').trim() },
    }),
  );
}
function openProject(project) {
  if (!state.board || !project || state.busy || state.loading || state.integrationFormOpen) return;
  if (state.detailState && !closeDetail({ focus: false })) return;
  state.view = 'board';
  state.presentation = 'list';
  setFilterValues('project', [project.id]);
  setFilterValues('assignee', []);
  setFilterValues('label', []);
  $('scope').value = 'all';
  resetSearch();
  hooks.render();
  persistPlanningURL();
}
function projectMatchesFilters(project) {
  if (!projectFilters.assignee.size && !projectFilters.label.size) return true;
  return state.board.items.some((item) =>
    item.archived
      ? false
      : itemProjectIDs(item).includes(project.id) &&
        matchesFilter('assignee', item.assignee ? [item.assignee] : [], projectFilters) &&
        matchesFilter('label', item.labels || [], projectFilters),
  );
}
function integrationProjectChipsTemplate(projectIDs) {
  const catalog = new Map(state.integrationCatalog.map((project) => [String(project.id), project]));
  return html`<div class="tags integration-project-chips" aria-label="Approved GitLab projects">
    ${projectIDs.map((id) => {
      const project = catalog.get(String(id));
      const label = project ? gitlabProjectLabel(project) : `GitLab project #${id}`;
      return html`<span class="badge integration-project-chip" title=${label}>${label}</span>`;
    })}
  </div>`;
}
function IntegrationEditor({ board, catalog, loading, error }) {
  const generation = useRef(0);
  return useMemo(
    () => withKey(++generation.current, integrationFormTemplate()),
    [board, catalog, loading, error],
  );
}
function integrationTemplate(approvedIDs) {
  const head = (...actions) => sectionHeadTemplate('GitLab integration', ...actions);
  // Reset the form only when its catalog or board inputs change, not when
  // the surrounding Projects page re-renders for search or filter changes.
  if (state.integrationFormOpen) {
    return panelTemplate(
      'maintenance-section',
      html`${head()}<${IntegrationEditor} board=${state.board} catalog=${state.integrationCatalog} loading=${state.integrationCatalogLoading} error=${state.integrationCatalogError} />`,
    );
  }
  const configured = state.board.connector_instance || 'Not configured';
  const approved = approvedIDs.length;
  return panelTemplate(
    'maintenance-section',
    html`${head(accessButtonTemplate('Edit integration', editIntegration))}
    ${helpTextTemplate(`Operator-configured GitLab instance: ${configured}`)}
    ${helpTextTemplate(`${approved} approved GitLab project${approved === 1 ? '' : 's'}.`)}
    ${approved ? integrationProjectChipsTemplate(approvedIDs) : nothing}
    ${state.integrationCatalogLoading ? helpTextTemplate('Loading approved GitLab project names…') : nothing}
    ${
      state.integrationCatalogError
        ? helpTextTemplate(
            `Project names are unavailable; approved IDs remain visible. ${state.integrationCatalogError}`,
          )
        : nothing
    }
    ${
      state.board.connector_instance
        ? nothing
        : helpTextTemplate(
            'Ask the operator to set FLUX_GITLAB_URL and FLUX_GITLAB_SERVICE_TOKEN to enable the connector.',
          )
    }`,
  );
}
function projectRowsTemplate(matches, filtered, search) {
  if (!matches.length) {
    const narrowed = filtered.length !== state.board.projects.length;
    const message = !state.board.projects.length
      ? 'No projects yet. Items can remain unclassified.'
      : search && narrowed
        ? `No projects match \u201c${search}\u201d and the current filters.`
        : search
          ? `No projects match \u201c${search}\u201d.`
          : 'No projects hold work matching the current filters.';
    return emptyStateTemplate(message);
  }
  const openDisabled = state.busy || state.loading || state.integrationFormOpen;
  return keyedList(
    matches,
    (project) => project.id,
    (project) =>
      maintenanceRowTemplate({
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
function rerenderProjects() {
  hooks.renderContent();
}
function projectsTemplate() {
  const search = state.projectSearch.trim();
  const query = search.toLowerCase();
  const filtered = state.board.projects.filter(projectMatchesFilters);
  const matches = filtered.filter((project) => project.name.toLowerCase().includes(query));
  // Filter controls keep one generated id each for the life of the session.
  state.projectFilterIDs ||= {
    assignee: filterControlID('Assignee'),
    label: filterControlID('Label'),
    search: filterControlID('Search'),
  };
  const ids = state.projectFilterIDs;
  const addFilter = (name) => (event) => {
    addFilterValue(name, event.currentTarget.value, projectFilters);
    event.currentTarget.value = 'all';
    rerenderProjects();
  };
  const controls = html`${filterSelectTemplate(
    'Assignee',
    [
      ['all', 'Any assignee'],
      ['none', 'Unassigned'],
      ...state.board.members.map((member) => [member.subject, memberName(member.subject)]),
    ],
    ids.assignee,
    addFilter('assignee'),
  )}${filterSelectTemplate(
    'Label',
    [
      ['all', 'Any label'],
      ['none', 'No labels'],
      ...state.board.labels.map((label) => [label.name, label.name]),
    ],
    ids.label,
    addFilter('label'),
  )}${filterSearchTemplate(
    'Search',
    ids.search,
    { value: state.projectSearch, placeholder: 'Find projects…', maxLength: 120 },
    (event) => {
      state.projectSearch = event.currentTarget.value;
      rerenderProjects();
    },
  )}`;
  const chips = filterChipTemplates(projectFilters, PROJECT_FILTER_NAMES, rerenderProjects, {
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
    ${maintenanceListTemplate('', projectRowsTemplate(matches, filtered, search))}
  </section>`;
}
export function renderProjects(content) {
  const approvedIDs = state.board.integration?.projects || [];
  if (
    !state.integrationFormOpen &&
    state.board.connector_instance &&
    approvedIDs.length &&
    !state.integrationCatalogLoaded &&
    !state.integrationCatalogLoading
  )
    void loadIntegrationCatalog();
  renderPage(content, 'projects', html`${integrationTemplate(approvedIDs)}${projectsTemplate()}`);
}
