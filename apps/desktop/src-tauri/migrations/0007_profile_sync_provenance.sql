ALTER TABLE mutation_quarantine ADD COLUMN provenance TEXT NOT NULL DEFAULT 'pre-login';
ALTER TABLE mutation_quarantine ADD COLUMN subject TEXT NOT NULL DEFAULT '';

UPDATE mutation_quarantine
SET subject = '', provenance = 'pre-login';

CREATE TABLE profile_sync_policy (
  profile_id TEXT PRIMARY KEY,
  policy TEXT NOT NULL CHECK (policy IN ('unclaimed', 'local-only', 'consented')),
  subject TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO profile_sync_policy(profile_id, policy, subject)
SELECT profile_id, 'unclaimed', ''
FROM mutation_quarantine
WHERE provenance = 'pre-login' AND profile_id <> '';

INSERT OR IGNORE INTO profile_sync_policy(profile_id, policy, subject)
SELECT id, 'unclaimed', ''
FROM profiles
WHERE COALESCE((SELECT subject FROM sync_state WHERE singleton = 1), '') = '';

INSERT OR IGNORE INTO profile_sync_policy(profile_id, policy, subject)
SELECT profile_id, 'unclaimed', ''
FROM mutation_outbox
WHERE profile_id <> ''
  AND COALESCE((SELECT subject FROM sync_state WHERE singleton = 1), '') = '';
