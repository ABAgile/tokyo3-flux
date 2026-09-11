-- Item comments are an append-only collaboration stream, not planning state.
CREATE TABLE item_comments (
 workspace_id text NOT NULL REFERENCES workspaces(id),
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 item_id text NOT NULL,
 author text NOT NULL CHECK (length(author) > 0),
 body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
 idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 120),
 digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,author,idempotency_key),
 FOREIGN KEY(workspace_id,item_id) REFERENCES work_items(workspace_id,id)
);
CREATE INDEX item_comments_item_order ON item_comments(workspace_id,item_id,id);

CREATE OR REPLACE FUNCTION prevent_item_comment_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'item comments are append-only';
END;
$$;
CREATE TRIGGER item_comments_immutable
 BEFORE UPDATE OR DELETE ON item_comments
 FOR EACH ROW EXECUTE FUNCTION prevent_item_comment_mutation();

ALTER TABLE flux_schema DROP CONSTRAINT flux_schema_version_check;
UPDATE flux_schema SET version=9;
ALTER TABLE flux_schema ADD CHECK(version=9);
