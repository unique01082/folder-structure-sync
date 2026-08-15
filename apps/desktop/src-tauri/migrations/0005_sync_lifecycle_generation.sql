ALTER TABLE sync_state ADD COLUMN lifecycle_generation TEXT NOT NULL DEFAULT '';
UPDATE sync_state SET lifecycle_generation=lower(hex(randomblob(16)));
