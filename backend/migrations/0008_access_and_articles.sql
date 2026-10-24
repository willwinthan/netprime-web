-- Account status, session revocation, per-role feature permissions and the article review workflow.

ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended'));
ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN sessions_revoked_at TEXT; -- ISO time; tokens issued before it are rejected

-- Admins implicitly hold every permission (see utils/permissions.ts); other roles are edited in the console.
CREATE TABLE IF NOT EXISTS role_permissions (
    role TEXT NOT NULL CHECK(role IN ('coordinator', 'instructor', 'partner', 'student')),
    permission TEXT NOT NULL,
    PRIMARY KEY (role, permission)
);
INSERT OR IGNORE INTO role_permissions (role, permission) VALUES
('coordinator', 'site.dashboard'),
('coordinator', 'site.sessions'),
('coordinator', 'site.inquiries'),
('coordinator', 'site.promotions'),
('coordinator', 'site.settings'),
('coordinator', 'site.media'),
('coordinator', 'site.audit'),
('coordinator', 'articles.write'),
('coordinator', 'articles.publish'),
('coordinator', 'articles.manage'),
('coordinator', 'articles.import_notion'),
('instructor', 'articles.write'),
('instructor', 'articles.import_notion'),
('instructor', 'site.media');

-- articles.status gains 'review'. SQLite cannot alter a CHECK constraint, so rebuild the table;
-- no other table references articles, so dropping the old copy cascades nowhere.
CREATE TABLE articles_v2 (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    category TEXT,
    excerpt TEXT,
    body TEXT NOT NULL,         -- Markdown: rendering fallback, search and share descriptions
    content_json TEXT,          -- Block editor document (BlockNote JSON); rendered when present
    cover_url TEXT,
    status TEXT NOT NULL CHECK(status IN ('draft', 'review', 'published')) DEFAULT 'draft',
    published_at TEXT,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    submitted_at TEXT,          -- When the author last sent it for review
    reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    review_note TEXT,           -- Feedback when a reviewer sends it back
    notion_page_id TEXT,        -- Source page when imported from Notion
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO articles_v2 (id, slug, title, category, excerpt, body, cover_url, status, published_at, author_id, created_at, updated_at)
SELECT id, slug, title, category, excerpt, body, cover_url, status, published_at, author_id, created_at, updated_at FROM articles;
DROP TABLE articles;
ALTER TABLE articles_v2 RENAME TO articles;
CREATE INDEX IF NOT EXISTS idx_articles_status_published ON articles (status, published_at);
CREATE INDEX IF NOT EXISTS idx_articles_author ON articles (author_id, status);
