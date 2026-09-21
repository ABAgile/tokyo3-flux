// Shared serialization for the modal and persistent item editors.
function itemPayloadFromForm(data, item) {
 return {...item, project_id:undefined, title:String(data.get('title') || '').trim(), description:data.get('description'), column_id:data.get('column_id'), project_ids:data.getAll('project_id').filter(Boolean), sprint_ids:data.getAll('sprint_ids'), assignee:data.get('assignee'), labels:data.getAll('labels'), dependencies:data.getAll('dependencies')};
}

export {itemPayloadFromForm};
