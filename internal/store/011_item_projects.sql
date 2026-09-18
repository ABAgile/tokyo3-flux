-- Allow one native work item to be classified by multiple workspace projects.
-- Keep work_items.project_id as a compatibility mirror for older readers.
CREATE TABLE item_projects (
 workspace_id text NOT NULL,
 item_id text NOT NULL,
 project_id text NOT NULL,
 PRIMARY KEY(workspace_id,item_id,project_id),
 FOREIGN KEY(workspace_id,item_id) REFERENCES work_items(workspace_id,id),
 FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id)
);
INSERT INTO item_projects(workspace_id,item_id,project_id)
 SELECT workspace_id,id,project_id FROM work_items WHERE project_id IS NOT NULL;
CREATE INDEX item_projects_project ON item_projects(workspace_id,project_id,item_id);
ALTER TABLE flux_schema DROP CONSTRAINT flux_schema_version_check;
UPDATE flux_schema SET version=11;
ALTER TABLE flux_schema ADD CHECK(version=11);
