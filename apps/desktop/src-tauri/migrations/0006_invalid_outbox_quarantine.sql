CREATE TABLE mutation_quarantine (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  quarantined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
