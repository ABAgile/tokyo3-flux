-- Retain failed blob deletions so transient storage failures do not create
-- permanent orphan objects. The serving role may enqueue and retry cleanup.
CREATE TABLE attachment_cleanup (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 storage_key text NOT NULL UNIQUE CHECK (octet_length(storage_key) BETWEEN 1 AND 512),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 next_attempt timestamptz NOT NULL DEFAULT now(),
 last_error text NOT NULL DEFAULT '',
 queued_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachment_cleanup_due ON attachment_cleanup(next_attempt,id);

ALTER TABLE flux_schema DROP CONSTRAINT flux_schema_version_check;
UPDATE flux_schema SET version=12;
ALTER TABLE flux_schema ADD CHECK(version=12);
