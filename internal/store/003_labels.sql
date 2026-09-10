-- Preserve all existing label assignments, including archived work.
CREATE TABLE workspace_labels (
 workspace_id text NOT NULL REFERENCES workspaces(id),
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
 PRIMARY KEY(workspace_id,name)
);
INSERT INTO workspace_labels SELECT DISTINCT workspace_id,label FROM item_labels;
ALTER TABLE item_labels ADD CONSTRAINT item_labels_catalog_fk
 FOREIGN KEY(workspace_id,label) REFERENCES workspace_labels(workspace_id,name);
ALTER TABLE memberships ADD COLUMN name text NOT NULL DEFAULT '' CHECK (length(name) <= 120);
ALTER TABLE flux_schema DROP CONSTRAINT flux_schema_version_check;
UPDATE flux_schema SET version=3;
ALTER TABLE flux_schema ADD CHECK(version=3);
