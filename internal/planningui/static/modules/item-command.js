// Shared serialization for the modal and persistent item editors.
/**
 * @param {FormData} data
 * @param {Partial<Flux.Item>} item
 */
function itemPayloadFromForm(data, item) {
  return {
    ...item,
    project_id: undefined,
    title: String(data.get('title') || '').trim(),
    description: String(data.get('description') || ''),
    start_date: String(data.get('start_date') || ''),
    end_date: String(data.get('end_date') || ''),
    due_date: String(data.get('due_date') || ''),
    column_id: String(data.get('column_id') || ''),
    project_ids: data.getAll('project_id').filter(Boolean).map(String),
    sprint_ids: data.getAll('sprint_ids').map(String),
    assignee: String(data.get('assignee') || ''),
    labels: data.getAll('labels').map(String),
    dependencies: data.getAll('dependencies').map(String),
  };
}

export { itemPayloadFromForm };
