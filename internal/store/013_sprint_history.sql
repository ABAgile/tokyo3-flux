-- Preserve the facts known at sprint closure so historical summaries do not
-- change as cards are edited, restored, or moved after the sprint ends.
ALTER TABLE sprints DROP CONSTRAINT IF EXISTS sprints_state_check;
ALTER TABLE sprints ADD CONSTRAINT sprints_state_check CHECK (state IN ('planned','active','closed','archived'));

CREATE TABLE sprint_closures (
 workspace_id text NOT NULL,
 sprint_id text NOT NULL,
 closed_at timestamptz NOT NULL,
 scope_count integer NOT NULL CHECK (scope_count >= 0),
 completed_count integer NOT NULL CHECK (completed_count >= 0 AND completed_count <= scope_count),
 carry_over_count integer NOT NULL CHECK (carry_over_count >= 0 AND carry_over_count <= scope_count),
 PRIMARY KEY(workspace_id,sprint_id),
 FOREIGN KEY(workspace_id,sprint_id) REFERENCES sprints(workspace_id,id)
);
CREATE INDEX sprint_closures_history ON sprint_closures(workspace_id,closed_at DESC,sprint_id);

-- Existing closed sprints predate immutable summaries. Backfill the scope and
-- completion facts available in the old schema; future closes write all facts
-- atomically with the command.
INSERT INTO sprint_closures(workspace_id,sprint_id,closed_at,scope_count,completed_count,carry_over_count)
SELECT s.workspace_id,
       s.id,
       COALESCE((SELECT max(e.at) FROM work_item_events e
                 WHERE e.workspace_id=s.workspace_id AND e.action='sprint.close' AND e.target=s.id), now()),
       count(css.item_id)::integer,
       count(css.item_id) FILTER (WHERE c.category='done')::integer,
       0
FROM sprints s
LEFT JOIN closed_sprint_scope css ON css.workspace_id=s.workspace_id AND css.sprint_id=s.id
LEFT JOIN work_items i ON i.workspace_id=css.workspace_id AND i.id=css.item_id
LEFT JOIN board_columns c ON c.workspace_id=i.workspace_id AND c.id=i.column_id
WHERE s.state='closed'
GROUP BY s.workspace_id,s.id;

ALTER TABLE flux_schema DROP CONSTRAINT flux_schema_version_check;
UPDATE flux_schema SET version=13;
ALTER TABLE flux_schema ADD CHECK(version=13);
