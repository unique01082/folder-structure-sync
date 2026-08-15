ALTER TABLE mutation_quarantine ADD COLUMN provenance TEXT NOT NULL DEFAULT 'account-bound';
ALTER TABLE mutation_quarantine ADD COLUMN subject TEXT NOT NULL DEFAULT '';

UPDATE mutation_quarantine
SET subject = COALESCE((SELECT subject FROM sync_state WHERE singleton = 1), ''),
    provenance = CASE
      WHEN COALESCE((SELECT subject FROM sync_state WHERE singleton = 1), '') = '' THEN 'pre-login'
      ELSE 'account-bound'
    END;

CREATE TABLE profile_sync_policy (
  profile_id TEXT PRIMARY KEY,
  policy TEXT NOT NULL CHECK (policy IN ('unclaimed', 'local-only', 'consented')),
  subject TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO profile_sync_policy(profile_id, policy, subject)
SELECT profile_id, 'unclaimed', ''
FROM mutation_quarantine
WHERE provenance = 'pre-login' AND profile_id <> '';
