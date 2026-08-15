ALTER TABLE sync_state ADD COLUMN preserve_outbox_on_epoch_adopt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mutation_outbox ADD COLUMN preserve_on_epoch_adopt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mutation_outbox ADD COLUMN profile_id TEXT NOT NULL DEFAULT '';
UPDATE mutation_outbox
SET profile_id = CASE
  WHEN kind = 'upsert' THEN json_extract(payload, '$.id')
  WHEN kind = 'delete' THEN json_extract(payload, '$.profileId')
  ELSE ''
END;
