-- Upgrade native planning v1 -> v2, in the migrator's single transaction.
-- Stop old application instances before migrating. No records or audit JSON are
-- discarded. Former project columns remain distinct (including their WIP policy).
LOCK TABLE workspaces, memberships, projects, board_columns, sprints, work_items,
 item_labels, dependencies, closed_sprint_scope, work_item_events, audit_events,
 idempotency_keys IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
 IF EXISTS (SELECT workspace_id FROM work_items GROUP BY workspace_id HAVING count(*) > 1000)
 OR EXISTS (SELECT p.workspace_id FROM sprints s JOIN projects p ON p.id=s.project_id GROUP BY p.workspace_id HAVING count(*) > 200)
 OR EXISTS (SELECT workspace_id FROM projects GROUP BY workspace_id HAVING count(*) > 100) THEN
  RAISE EXCEPTION 'workspace exceeds v2 limits (1000 items, 200 sprints, 100 projects); migration rolled back';
 END IF;
END $$;

ALTER TABLE workspaces ADD COLUMN revision bigint NOT NULL DEFAULT 1;
UPDATE workspaces w SET revision=coalesce((SELECT max(revision)+1 FROM projects p WHERE p.workspace_id=w.id),1);

-- Remove only the relationships being re-scoped; rebuild same-workspace FKs.
DO $$ DECLARE constraint_row record; BEGIN
 FOR constraint_row IN SELECT conrelid::regclass AS relation, conname FROM pg_constraint
 WHERE contype='f' AND conrelid IN ('board_columns'::regclass,'sprints'::regclass,
 'work_items'::regclass,'item_labels'::regclass,'dependencies'::regclass,'closed_sprint_scope'::regclass)
 LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',constraint_row.relation,constraint_row.conname); END LOOP;
END $$;

ALTER TABLE board_columns ADD COLUMN workspace_id text;
UPDATE board_columns c SET workspace_id=p.workspace_id FROM projects p WHERE p.id=c.project_id;
-- Preserve column IDs and policy; disambiguate names only when merging boards.
UPDATE board_columns c SET name=left(p.name,35)||' / '||left(c.name,42)
 FROM projects p WHERE p.id=c.project_id AND (SELECT count(*) FROM projects q WHERE q.workspace_id=p.workspace_id)>1;
WITH positions AS (SELECT project_id,id,row_number() OVER(PARTITION BY workspace_id ORDER BY project_id,position,id)-1 AS rank FROM board_columns)
 UPDATE board_columns c SET position=p.rank FROM positions p WHERE p.project_id=c.project_id AND p.id=c.id;
ALTER TABLE board_columns DROP CONSTRAINT board_columns_pkey;
ALTER TABLE board_columns DROP COLUMN project_id;
ALTER TABLE board_columns ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE board_columns ADD PRIMARY KEY(workspace_id,id), ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id);
-- A legacy workspace without projects still needs a usable shared board.
INSERT INTO board_columns(workspace_id,id,name,category,position,wip)
 SELECT w.id,md5(w.id||':v2-default:'||v.name),v.name,v.category,v.position,v.wip
 FROM workspaces w CROSS JOIN (VALUES ('Ready','todo',0,0),('In progress','doing',1,3),('In review','doing',2,3),('Done','done',3,0)) AS v(name,category,position,wip)
 WHERE NOT EXISTS (SELECT 1 FROM board_columns c WHERE c.workspace_id=w.id);

ALTER TABLE sprints ADD COLUMN workspace_id text;
UPDATE sprints s SET workspace_id=p.workspace_id FROM projects p WHERE p.id=s.project_id;
DROP INDEX one_active_sprint;
ALTER TABLE sprints DROP CONSTRAINT sprints_pkey;
ALTER TABLE sprints DROP COLUMN project_id;
ALTER TABLE sprints ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE sprints ADD PRIMARY KEY(workspace_id,id), ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id);

ALTER TABLE work_items DROP CONSTRAINT work_items_pkey;
ALTER TABLE work_items ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE work_items ADD PRIMARY KEY(workspace_id,id),
 ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
 ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id),
 ADD FOREIGN KEY(workspace_id,column_id) REFERENCES board_columns(workspace_id,id),
 ADD FOREIGN KEY(workspace_id,assignee) REFERENCES memberships(workspace_id,subject);
WITH ranks AS (SELECT workspace_id,id,row_number() OVER(PARTITION BY workspace_id ORDER BY project_id,rank,id)-1 AS rank FROM work_items)
 UPDATE work_items i SET rank=r.rank FROM ranks r WHERE r.workspace_id=i.workspace_id AND r.id=i.id;
DROP INDEX item_order;
CREATE INDEX item_order ON work_items(workspace_id,rank,id);

CREATE TABLE item_sprints (
 workspace_id text NOT NULL, item_id text NOT NULL, sprint_id text NOT NULL,
 PRIMARY KEY(workspace_id,item_id,sprint_id),
 FOREIGN KEY(workspace_id,item_id) REFERENCES work_items(workspace_id,id),
 FOREIGN KEY(workspace_id,sprint_id) REFERENCES sprints(workspace_id,id)
);
INSERT INTO item_sprints SELECT workspace_id,id,sprint_id FROM work_items WHERE sprint_id IS NOT NULL;
ALTER TABLE work_items DROP COLUMN sprint_id;

ALTER TABLE item_labels ADD COLUMN workspace_id text;
UPDATE item_labels t SET workspace_id=p.workspace_id FROM projects p WHERE p.id=t.project_id;
ALTER TABLE item_labels DROP CONSTRAINT item_labels_pkey;
ALTER TABLE item_labels DROP COLUMN project_id;
ALTER TABLE item_labels ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE item_labels ADD PRIMARY KEY(workspace_id,item_id,label), ADD FOREIGN KEY(workspace_id,item_id) REFERENCES work_items(workspace_id,id);

ALTER TABLE dependencies ADD COLUMN workspace_id text;
UPDATE dependencies t SET workspace_id=p.workspace_id FROM projects p WHERE p.id=t.project_id;
ALTER TABLE dependencies DROP CONSTRAINT dependencies_pkey;
ALTER TABLE dependencies DROP COLUMN project_id;
ALTER TABLE dependencies ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE dependencies ADD PRIMARY KEY(workspace_id,item_id,depends_on),
 ADD FOREIGN KEY(workspace_id,item_id) REFERENCES work_items(workspace_id,id),
 ADD FOREIGN KEY(workspace_id,depends_on) REFERENCES work_items(workspace_id,id);

ALTER TABLE closed_sprint_scope ADD COLUMN workspace_id text;
UPDATE closed_sprint_scope t SET workspace_id=p.workspace_id FROM projects p WHERE p.id=t.project_id;
ALTER TABLE closed_sprint_scope DROP CONSTRAINT closed_sprint_scope_pkey;
ALTER TABLE closed_sprint_scope DROP COLUMN project_id;
ALTER TABLE closed_sprint_scope ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE closed_sprint_scope ADD PRIMARY KEY(workspace_id,sprint_id,item_id),
 ADD FOREIGN KEY(workspace_id,item_id) REFERENCES work_items(workspace_id,id),
 ADD FOREIGN KEY(workspace_id,sprint_id) REFERENCES sprints(workspace_id,id);

ALTER TABLE work_item_events ADD COLUMN workspace_id text;
UPDATE work_item_events e SET workspace_id=p.workspace_id FROM projects p WHERE p.id=e.project_id;
ALTER TABLE work_item_events ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE work_item_events ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE work_item_events ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id);
DROP INDEX event_history;
CREATE INDEX event_history ON work_item_events(workspace_id,id DESC);

-- v1 receipts retain their original project/revision namespace for provenance.
-- They must not collide with, or replay as, workspace-level v2 commands.
ALTER TABLE idempotency_keys RENAME TO legacy_idempotency_keys;
CREATE TABLE idempotency_keys (
 workspace_id text NOT NULL REFERENCES workspaces(id), actor text NOT NULL,
 key text NOT NULL, digest text NOT NULL, revision bigint NOT NULL,
 CONSTRAINT workspace_idempotency_pkey PRIMARY KEY(workspace_id,actor,key)
);
ALTER TABLE flux_schema DROP CONSTRAINT flux_schema_version_check;
UPDATE flux_schema SET version=2;
ALTER TABLE flux_schema ADD CHECK(version=2);
