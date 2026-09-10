CREATE TABLE workspace_integrations (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id),
 instance text NOT NULL
);
CREATE TABLE approved_gitlab_projects (
 workspace_id text NOT NULL REFERENCES workspace_integrations(workspace_id),
 project_id bigint NOT NULL CHECK(project_id > 0 AND project_id <= 9007199254740991),
 PRIMARY KEY(workspace_id,project_id)
);
CREATE TABLE external_links (
 workspace_id text NOT NULL,
 id text NOT NULL,
 project_id bigint NOT NULL,
 kind text NOT NULL CHECK(kind IN ('mr','pipeline')),
 number bigint NOT NULL CHECK(number > 0 AND number <= 9007199254740991),
 observation jsonb,
 last_success timestamptz,
 last_attempt timestamptz,
 outcome text NOT NULL DEFAULT 'unobserved',
 next_refresh timestamptz,
 run_id bigint,
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,project_id,kind,number),
 FOREIGN KEY(workspace_id,project_id) REFERENCES approved_gitlab_projects(workspace_id,project_id)
);
CREATE TABLE item_external_links (
 workspace_id text NOT NULL,
 item_id text NOT NULL,
 link_id text NOT NULL,
 PRIMARY KEY(workspace_id,item_id,link_id),
 FOREIGN KEY(workspace_id,item_id) REFERENCES work_items(workspace_id,id),
 FOREIGN KEY(workspace_id,link_id) REFERENCES external_links(workspace_id,id)
);
-- Attempts survive unlinking/config revocation. No provider bodies or secrets.
CREATE TABLE integration_runs (
 id bigserial PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id),
 actor text NOT NULL,
 key text NOT NULL,
 digest text NOT NULL,
 link_id text NOT NULL,
 revision bigint NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 outcome text NOT NULL DEFAULT 'pending',
 UNIQUE(workspace_id,actor,key)
);
ALTER TABLE flux_schema DROP CONSTRAINT flux_schema_version_check;
UPDATE flux_schema SET version=4;
ALTER TABLE flux_schema ADD CHECK(version=4);
