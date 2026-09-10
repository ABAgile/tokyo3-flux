ALTER TABLE external_links ADD COLUMN dirty boolean NOT NULL DEFAULT true;
ALTER TABLE external_links ADD COLUMN poll_after timestamptz NOT NULL DEFAULT now();
ALTER TABLE external_links ADD COLUMN failures integer NOT NULL DEFAULT 0;
ALTER TABLE integration_runs ADD COLUMN trigger text NOT NULL DEFAULT 'browser' CHECK(trigger IN ('browser','background'));
CREATE INDEX external_links_due ON external_links(poll_after,next_refresh);
CREATE TABLE webhook_deliveries (
 workspace_id text NOT NULL REFERENCES workspaces(id),
 instance text NOT NULL,
 delivery_id text NOT NULL,
 digest text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,instance,delivery_id)
);
CREATE INDEX webhook_deliveries_retention ON webhook_deliveries(received_at);
ALTER TABLE flux_schema DROP CONSTRAINT flux_schema_version_check;
UPDATE flux_schema SET version=5;
ALTER TABLE flux_schema ADD CHECK(version=5);
