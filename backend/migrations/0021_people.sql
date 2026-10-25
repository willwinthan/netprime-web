-- People management (v0.5): saved segments, custom profile fields, staff notes, CSV import log.

-- Saved audience segments; rules_json follows utils/segments.ts SegmentRules.
CREATE TABLE IF NOT EXISTS segments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    rules_json TEXT NOT NULL DEFAULT '{}',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Admin-defined profile fields. visibility: signup (signup form + profile), profile (profile only), admin (staff only).
CREATE TABLE IF NOT EXISTS profile_fields (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('text', 'number', 'date', 'select', 'checkbox')),
    options_json TEXT,
    required INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'profile' CHECK(visibility IN ('signup', 'profile', 'admin')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_profile_values (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    field_id TEXT NOT NULL REFERENCES profile_fields(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, field_id)
);
CREATE INDEX IF NOT EXISTS idx_user_profile_values_field ON user_profile_values(field_id);

-- Internal notes about a person (user detail page; never shown to the user).
CREATE TABLE IF NOT EXISTS staff_notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_staff_notes_user ON staff_notes(user_id, created_at);

-- CSV imports: one row per file, one row per processed line so a retried batch returns the stored result.
CREATE TABLE IF NOT EXISTS user_imports (
    id TEXT PRIMARY KEY,
    actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    filename TEXT,
    options_json TEXT,
    total_rows INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS user_import_rows (
    import_id TEXT NOT NULL REFERENCES user_imports(id) ON DELETE CASCADE,
    row_no INTEGER NOT NULL,
    email TEXT,
    result TEXT NOT NULL CHECK(result IN ('created', 'updated', 'skipped', 'failed')),
    user_id TEXT,
    message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (import_id, row_no)
);
