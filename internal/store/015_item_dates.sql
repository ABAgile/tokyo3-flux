ALTER TABLE work_items
 ADD COLUMN start_date date,
 ADD COLUMN end_date date,
 ADD COLUMN due_date date,
 ADD CONSTRAINT work_items_date_order
 CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date);

ALTER TABLE flux_schema DROP CONSTRAINT flux_schema_version_check;
UPDATE flux_schema SET version=15;
ALTER TABLE flux_schema ADD CHECK(version=15);
