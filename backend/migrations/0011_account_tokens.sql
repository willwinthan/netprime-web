-- Single-use links for password reset, invitations and email verification (hash only; see utils/tokens.ts).
CREATE TABLE IF NOT EXISTS account_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('reset', 'invite', 'verify')),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_account_tokens_user ON account_tokens(user_id, purpose);

-- Soft email verification: login is never blocked; accounts that existed before count as verified.
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
UPDATE users SET email_verified_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE email_verified_at IS NULL;
