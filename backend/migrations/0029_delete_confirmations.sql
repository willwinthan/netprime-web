-- Email confirmation codes for dangerous deletions (utils/dangerConfirm.ts, handlers/security.ts).
-- A code is bound to action + target + the requesting user, expires after 10 minutes, allows 5 wrong tries
-- and works once. Only an HMAC of the code is stored (keyed from JWT_SECRET).
CREATE TABLE IF NOT EXISTS danger_confirmations (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,                 -- e.g. course.delete, webhook.delete, privacy.approve
    target_id TEXT NOT NULL,
    requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    approver_kind TEXT NOT NULL CHECK(approver_kind IN ('owner', 'admin')),
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,             -- ISO UTC
    attempts INTEGER NOT NULL DEFAULT 0,  -- wrong tries; 5 = invalidated
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_danger_confirmations_lookup ON danger_confirmations (action, target_id, requested_by, created_at);
