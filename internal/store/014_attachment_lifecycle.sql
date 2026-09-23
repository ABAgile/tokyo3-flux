-- Distinguish active upload reservations from objects awaiting deletion.
-- Existing rows are already cleanup work; new uploads reserve their generated key
-- here before bytes are written so a crash remains discoverable.
ALTER TABLE attachment_cleanup
 ADD COLUMN state text NOT NULL DEFAULT 'cleanup'
 CHECK (state IN ('uploading','cleanup'));
DROP INDEX attachment_cleanup_due;
CREATE INDEX attachment_cleanup_cleanup_due ON attachment_cleanup(next_attempt,id)
 WHERE state='cleanup';
CREATE INDEX attachment_cleanup_upload_expiry ON attachment_cleanup(next_attempt,id)
 WHERE state='uploading';

ALTER TABLE flux_schema DROP CONSTRAINT flux_schema_version_check;
UPDATE flux_schema SET version=14;
ALTER TABLE flux_schema ADD CHECK(version=14);
