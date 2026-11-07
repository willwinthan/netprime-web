-- Delivery record of every email the system sends (transactional and broadcast), shown to admins
-- under ตั้งค่าระบบ › อีเมล. Failed transactional emails keep their body for a day so the daily job
-- (and the retry button) can send them again; the body is cleared once sent or given up.
-- Rows older than 90 days are deleted by the daily job.
CREATE TABLE IF NOT EXISTS email_log (
    id TEXT PRIMARY KEY,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'general',
    status TEXT NOT NULL CHECK(status IN ('sent', 'failed', 'logged')), -- logged = no provider configured, written to the Worker log only
    provider_id TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    retry_html TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log (created_at);
CREATE INDEX IF NOT EXISTS idx_email_log_status ON email_log (status, created_at);
CREATE INDEX IF NOT EXISTS idx_email_log_to ON email_log (to_email);
