-- Website builder history: every published theme, homepage content and menu, newest 30 per key
-- (older ones are deleted when a new version is published). Drafts are kept in site_settings under
-- "draft:<key>" and are never read by the public site.
CREATE TABLE IF NOT EXISTS site_setting_versions (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    published_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_site_setting_versions_key ON site_setting_versions (key, published_at);
