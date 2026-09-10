CREATE TABLE proposals (
 workspace_id text NOT NULL REFERENCES workspaces(id),
 id text NOT NULL,
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 state text NOT NULL CHECK(state IN ('draft','accepted','rejected')),
 imported_by text NOT NULL,
 reviewed_by text NOT NULL DEFAULT '',
 review_reason text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 document jsonb NOT NULL,
 accepted_preview jsonb,
 native_ids text[] NOT NULL,
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE imported_items (
 workspace_id text NOT NULL,
 source text NOT NULL,
 item_id text NOT NULL,
 proposal_id text NOT NULL,
 PRIMARY KEY(workspace_id,source),
 FOREIGN KEY(workspace_id,item_id) REFERENCES work_items(workspace_id,id),
 FOREIGN KEY(workspace_id,proposal_id) REFERENCES proposals(workspace_id,id)
);
CREATE INDEX proposals_workspace_sequence ON proposals(workspace_id,sequence DESC);
ALTER TABLE flux_schema DROP CONSTRAINT flux_schema_version_check;
UPDATE flux_schema SET version=6;
ALTER TABLE flux_schema ADD CONSTRAINT flux_schema_version_check CHECK(version=6);
