-- Shared foundation for v0.5: learner activity events, user tags, course categories, new permissions.

-- Learner/user activity (login, course and lesson views, completions, purchases…) for the events log,
-- reports and webhooks. Written through utils/events.ts trackEvent().
CREATE TABLE IF NOT EXISTS user_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    course_id TEXT,
    lesson_id TEXT,
    data_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_user_events_created ON user_events(created_at);
CREATE INDEX IF NOT EXISTS idx_user_events_user ON user_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_user_events_type ON user_events(type, created_at);

-- Free-form tags used for segments (broadcasts, reports, imports).
CREATE TABLE IF NOT EXISTS user_tags (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_user_tags_tag ON user_tags(tag);

-- Course categories (catalog filters, dashboard counts, sales pages).
CREATE TABLE IF NOT EXISTS course_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE courses ADD COLUMN category_id TEXT REFERENCES course_categories(id) ON DELETE SET NULL;

INSERT OR IGNORE INTO role_permissions (role, permission) VALUES
('coordinator', 'reports.view'), ('coordinator', 'communication.manage'), ('coordinator', 'community.moderate'),
('coordinator', 'marketing.manage'), ('coordinator', 'website.design'), ('instructor', 'community.moderate');
