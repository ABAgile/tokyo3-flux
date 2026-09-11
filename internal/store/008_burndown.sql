-- Bound historical burn-down reads by workspace and event time.
CREATE INDEX audit_workspace_time ON audit_events(workspace_id,at,id);
ALTER TABLE flux_schema DROP CONSTRAINT flux_schema_version_check;
UPDATE flux_schema SET version=8;
ALTER TABLE flux_schema ADD CHECK(version=8);
