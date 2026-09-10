-- Add user-selected label colors and replace legacy priorities with scoped labels.
ALTER TABLE workspace_labels ADD COLUMN color text NOT NULL DEFAULT '#dcefe4'
 CHECK (color ~ '^#[0-9A-Fa-f]{6}$');
INSERT INTO workspace_labels(workspace_id,name)
 SELECT DISTINCT workspace_id,'priority::'||priority FROM work_items
 ON CONFLICT (workspace_id,name) DO NOTHING;
INSERT INTO item_labels(workspace_id,item_id,label)
 SELECT workspace_id,id,'priority::'||priority FROM work_items
 ON CONFLICT (workspace_id,item_id,label) DO NOTHING;
ALTER TABLE work_items DROP COLUMN IF EXISTS priority;
ALTER TABLE flux_schema DROP CONSTRAINT flux_schema_version_check;
UPDATE flux_schema SET version=7;
ALTER TABLE flux_schema ADD CHECK(version=7);
