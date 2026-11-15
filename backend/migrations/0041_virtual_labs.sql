-- Virtual Lab (handlers/labs.ts, packages/lab-engine): network labs learners do inside a course lesson.
-- A lab is a JSON spec run by the shared engine. The server grades a learner by replaying their keystrokes
-- from the lab's initial state, so a passed lab can count towards course completion and the certificate.

CREATE TABLE IF NOT EXISTS labs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published')),
    spec_json TEXT NOT NULL,          -- current lab definition (packages/lab-engine validateSpec)
    version INTEGER NOT NULL DEFAULT 1, -- bumped whenever spec_json changes; each version is kept in lab_versions
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Every spec a lab has had, so a learner's passed result can be checked again against the exact lab they did.
CREATE TABLE IF NOT EXISTS lab_versions (
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    spec_json TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (lab_id, version)
);

-- One row per learner and lab lesson. transcript_json is the current attempt ([[deviceId, keystrokes], ...]);
-- the passed_* columns keep the first passing attempt as evidence and are never cleared by a reset.
CREATE TABLE IF NOT EXISTS lab_progress (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    lab_version INTEGER NOT NULL,
    engine_version TEXT NOT NULL,
    transcript_json TEXT NOT NULL DEFAULT '[]',
    passed_count INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    results_json TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    passed_at TEXT,
    passed_lab_version INTEGER,
    passed_engine_version TEXT,
    passed_transcript_json TEXT,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, lesson_id)
);
CREATE INDEX IF NOT EXISTS idx_lab_progress_lab ON lab_progress (lab_id);

-- A course lesson that shows a lab. lessons.type has a CHECK constraint D1 cannot change without rebuilding the
-- table, so such a lesson is stored as type 'embed' with lab_id set and the API reports it as type 'lab'
-- (same approach as self_learning_id, migration 0034).
ALTER TABLE lessons ADD COLUMN lab_id TEXT REFERENCES labs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_lessons_lab ON lessons (lab_id);

INSERT OR IGNORE INTO role_permissions (role, permission) VALUES ('coordinator', 'labs.manage');
