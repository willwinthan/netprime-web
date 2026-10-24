-- Additive migration. Run against staging before enabling OAuth providers.
CREATE TABLE IF NOT EXISTS oauth_identities (
  provider TEXT NOT NULL CHECK(provider IN ('google', 'github', 'microsoft')),
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, subject),
  UNIQUE (user_id, provider)
);
