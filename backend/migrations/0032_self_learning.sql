-- Self-learning lessons: staff upload a self-contained HTML file per lesson; the public site lists the
-- published ones under /self-learning and embeds the file in an iframe. Handlers: src/handlers/selfLearning.ts.

CREATE TABLE IF NOT EXISTS self_learning_lessons (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    title_en TEXT,
    summary TEXT,
    summary_en TEXT,
    cover_url TEXT,
    level TEXT CHECK(level IS NULL OR level IN ('beginner', 'intermediate', 'advanced')),
    status TEXT NOT NULL CHECK(status IN ('draft', 'published')) DEFAULT 'draft',
    sort_order INTEGER NOT NULL DEFAULT 0,
    current_file_id TEXT,          -- self_learning_files row shown to learners; NULL until a file is uploaded
    published_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_self_learning_lessons_status ON self_learning_lessons (status, sort_order);

-- Every uploaded version is kept (private R2 under self-learning/), so staff can roll back.
CREATE TABLE IF NOT EXISTS self_learning_files (
    id TEXT PRIMARY KEY,
    lesson_id TEXT NOT NULL REFERENCES self_learning_lessons(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    filename TEXT,
    size_bytes INTEGER NOT NULL,
    uses_kit INTEGER NOT NULL DEFAULT 0,   -- The file speaks the lesson postMessage protocol (height, location)
    external_hosts TEXT,                   -- JSON array of other hosts the file loads from or links to
    uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (lesson_id, version)
);

INSERT OR IGNORE INTO role_permissions (role, permission) VALUES ('coordinator', 'site.self_learning');
