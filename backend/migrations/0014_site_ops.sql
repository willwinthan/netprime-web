-- Coordinator operations: registrations linked to accounts, reminder emails,
-- article revisions with optimistic concurrency, and PDPA data subject requests.

-- Training registrations ↔ LMS accounts (matched by email; see handlers/site.ts).
ALTER TABLE session_registrations ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
-- Set once the "starts in 2 days" reminder was sent (jobs.ts); cleared when the session date moves.
ALTER TABLE session_registrations ADD COLUMN reminder_sent_at TEXT;
CREATE INDEX IF NOT EXISTS idx_session_registrations_user ON session_registrations (user_id);
CREATE INDEX IF NOT EXISTS idx_session_registrations_email ON session_registrations (email);
UPDATE session_registrations SET user_id = (SELECT u.id FROM users u WHERE u.email = session_registrations.email)
WHERE user_id IS NULL;

-- Who saved the current article version (copied into article_revisions on the next save).
ALTER TABLE articles ADD COLUMN updated_by TEXT REFERENCES users(id) ON DELETE SET NULL;

-- Previous versions of article content; the newest 30 per article are kept.
CREATE TABLE IF NOT EXISTS article_revisions (
    id TEXT PRIMARY KEY,
    article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content_json TEXT,
    body TEXT NOT NULL,
    saved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    saved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_article_revisions_article ON article_revisions (article_id, saved_at);

-- PDPA data subject requests (account deletion). One open request per user.
CREATE TABLE IF NOT EXISTS privacy_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('deletion')) DEFAULT 'deletion',
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
    reason TEXT,
    admin_note TEXT,
    processed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    processed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS privacy_requests_one_open ON privacy_requests (user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_privacy_requests_status ON privacy_requests (status, created_at);
