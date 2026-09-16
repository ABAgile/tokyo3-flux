-- Attachment bytes live in a configured blobstore; this table stores only
-- ownership, display metadata and the generated object key.
CREATE TABLE item_attachments (
 workspace_id text NOT NULL REFERENCES workspaces(id),
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 item_id text NOT NULL,
 storage_key text NOT NULL UNIQUE,
 name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
 content_type text NOT NULL CHECK (octet_length(content_type) BETWEEN 1 AND 255),
 size bigint NOT NULL CHECK (size >= 0 AND size <= 20971520),
 digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
 uploader text NOT NULL,
 idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 16 AND 120),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,uploader,idempotency_key),
 FOREIGN KEY(workspace_id,item_id) REFERENCES work_items(workspace_id,id)
);
CREATE INDEX item_attachments_item_order ON item_attachments(workspace_id,item_id,id);

ALTER TABLE flux_schema DROP CONSTRAINT flux_schema_version_check;
UPDATE flux_schema SET version=10;
ALTER TABLE flux_schema ADD CHECK(version=10);
