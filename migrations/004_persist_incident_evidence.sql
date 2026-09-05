ALTER TABLE incidents ADD COLUMN affected_services text[];
ALTER TABLE incidents ADD COLUMN evidence jsonb;

UPDATE incidents
SET affected_services = ARRAY[suspected_service], evidence = '{}'::jsonb;

ALTER TABLE incidents ALTER COLUMN affected_services SET NOT NULL;
ALTER TABLE incidents ALTER COLUMN evidence SET NOT NULL;
