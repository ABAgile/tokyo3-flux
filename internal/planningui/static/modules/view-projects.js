// The Projects page and project dialogs.
import { $, el, field } from './dom.js';
import {
  pageStack,
  panel,
  sectionHead,
  helpText,
  emptyState,
  filterBar,
  filterSelect,
  filterSearch,
  filterChipRow,
  filterSlot,
  maintenanceList,
  maintenanceRow,
} from './layout.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { actionIconButton, writeIconButton, writeButton } from './permissions.js';
import { itemProjectIDs } from './items.js';
import { memberName } from './people.js';
import { gitlabProjectLabel } from './gitlab-catalog.js';
import {
  PROJECT_FILTER_NAMES,
  projectFilters,
  addFilterValue,
  setFilterValues,
  matchesFilter,
  filterChipNodes,
  resetSearch,
} from './filters.js';
import { openEditor } from './dialog.js';
import { persistPlanningURL } from './url-state.js';
import { closeDetail } from './item-detail.js';
import {
  editIntegration,
  loadIntegrationCatalog,
  renderIntegrationForm,
} from './view-integration.js';

function editProject(project) {
  $('editor').close();
  openEditor(
    project ? 'Edit project' : 'Create project',
    (fields) => {
      const name = field(fields, 'name', 'Project name', project?.name || '');
      name.required = true;
      name.maxLength = 120;
      fields.append(
        helpText(
          'Projects classify work in this workspace. Boards, sprint scope, WIP and permissions stay workspace-wide.',
        ),
      );
    },
    (data) => ({
      kind: 'project.save',
      target: project?.id || '',
      project: { ...(project || {}), name: data.get('name').trim() },
    }),
  );
}
function integrationProjectChips(projectIDs) {
  const catalog = new Map(state.integrationCatalog.map((project) => [String(project.id), project]));
  const chips = el('div', undefined, 'tags integration-project-chips');
  chips.setAttribute('aria-label', 'Approved GitLab projects');
  projectIDs.forEach((id) => {
    const project = catalog.get(String(id));
    const label = project ? gitlabProjectLabel(project) : `GitLab project #${id}`;
    const chip = el('span', label, 'badge integration-project-chip');
    chip.title = label;
    chips.append(chip);
  });
  return chips;
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
function renderProjectFilterChips(host, list, count) {
  const chips = filterChipNodes(
    projectFilters,
    PROJECT_FILTER_NAMES,
    () => renderProjectRows(list, count, host),
    { clearLabel: 'Clear project filters' },
  );
  host.hidden = !chips.length;
  host.replaceChildren(...chips);
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
function renderProjectRows(list, count, chips) {
  const search = state.projectSearch.trim();
  const query = search.toLowerCase();
  const filtered = state.board.projects.filter(projectMatchesFilters);
  const matches = filtered.filter((project) => project.name.toLowerCase().includes(query));
  if (count) count.textContent = `${matches.length} project${matches.length === 1 ? '' : 's'}`;
  if (chips) renderProjectFilterChips(chips, list, count);
  list.replaceChildren();
  if (!matches.length) {
    const narrowed = filtered.length !== state.board.projects.length;
    const message = !state.board.projects.length
      ? 'No projects yet. Items can remain unclassified.'
      : query && narrowed
        ? `No projects match \u201c${search}\u201d and the current filters.`
        : query
          ? `No projects match \u201c${search}\u201d.`
          : 'No projects hold work matching the current filters.';
    list.append(emptyState(message));
    return;
  }
  matches.forEach((project) => {
    const open = actionIconButton('View scope', '◎', () => openProject(project));
    open.disabled = state.busy || state.loading || state.integrationFormOpen;
    list.append(
      maintenanceRow({
        content: [el('strong', project.name)],
        actions: [open, writeIconButton('Edit project', '✎', () => editProject(project))],
      }),
    );
  });
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
  const sections = pageStack('projects');
  const integration = panel('maintenance-section');
  const integrationHead = sectionHead('GitLab integration');
  if (state.integrationFormOpen) {
    integration.append(integrationHead, renderIntegrationForm());
  } else {
    const edit = writeButton('Edit integration', editIntegration);
    edit.dataset.write = 'true';
    integrationHead.append(edit);
    const configured = state.board.connector_instance || 'Not configured';
    const approved = approvedIDs.length;
    integration.append(
      integrationHead,
      helpText(`Operator-configured GitLab instance: ${configured}`),
      helpText(`${approved} approved GitLab project${approved === 1 ? '' : 's'}.`),
    );
    if (approved) integration.append(integrationProjectChips(approvedIDs));
    if (state.integrationCatalogLoading)
      integration.append(helpText('Loading approved GitLab project names…'));
    if (state.integrationCatalogError)
      integration.append(
        helpText(
          `Project names are unavailable; approved IDs remain visible. ${state.integrationCatalogError}`,
        ),
      );
    if (!state.board.connector_instance)
      integration.append(
        helpText(
          'Ask the operator to set FLUX_GITLAB_URL and FLUX_GITLAB_SERVICE_TOKEN to enable the connector.',
        ),
      );
  }
  const projects = el('section', undefined, 'workspace-projects');
  const newProject = writeButton('＋ New project', () => editProject(), 'primary');
  newProject.dataset.write = 'true';
  // Each select adds one value and resets, exactly like the planning bar.
  const { bar, controls, count: projectCount } = filterBar();
  const assigneeFilter = filterSelect('Assignee', [
    ['all', 'Any assignee'],
    ['none', 'Unassigned'],
    ...state.board.members.map((member) => [member.subject, memberName(member.subject)]),
  ]);
  const labelFilter = filterSelect('Label', [
    ['all', 'Any label'],
    ['none', 'No labels'],
    ...state.board.labels.map((label) => [label.name, label.name]),
  ]);
  const search = filterSearch('Search', {
    value: state.projectSearch,
    placeholder: 'Find projects…',
    maxLength: 120,
  });
  controls.append(assigneeFilter.label, labelFilter.label, search.label);
  const projectChips = filterChipRow('Active project filters');
  projects.append(
    sectionHead('Workspace projects', newProject),
    filterSlot('', bar, projectChips),
    helpText(
      'Projects classify work in this workspace. Boards, sprint scope, WIP and permissions stay workspace-wide. Assignee and Label filters list projects with current non-archived work matching every active filter; Unassigned and No labels match empty values.',
    ),
  );
  const list = maintenanceList();
  renderProjectRows(list, projectCount, projectChips);
  search.input.addEventListener('input', () => {
    state.projectSearch = search.input.value;
    renderProjectRows(list, projectCount, projectChips);
  });
  PROJECT_FILTER_NAMES.forEach((name, index) => {
    const select = index === 0 ? assigneeFilter.select : labelFilter.select;
    select.addEventListener('change', () => {
      addFilterValue(name, select.value, projectFilters);
      select.value = 'all';
      renderProjectRows(list, projectCount, projectChips);
    });
  });
  projects.append(list);

  sections.append(integration, projects);
  content.append(sections);
}
