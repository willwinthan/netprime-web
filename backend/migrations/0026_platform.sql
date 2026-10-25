-- v0.5 platform: school settings (site_settings key 'school', no DDL), outgoing webhooks, API keys,
-- enterprise SSO (OpenID Connect) and live meetings. Applies on a database at 0017 or later.

-- Outgoing webhook endpoints. secret_enc is AES-GCM encrypted (utils/secretbox.ts); never returned.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    secret_enc TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '["*"]',  -- JSON array of event names, or ["*"]
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Delivery log and retry queue (pending rows are retried with backoff; kept 30 days).
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'success', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    response_code INTEGER,
    duration_ms INTEGER,
    error TEXT,
    response_excerpt TEXT,
    next_attempt_at TEXT,
    locked_until TEXT,
    last_attempt_at TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);

-- Public REST API keys: only the SHA-256 hash is stored; the key is shown once.
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scopes TEXT NOT NULL,  -- JSON array
    rate_limit_per_minute INTEGER NOT NULL DEFAULT 120 CHECK(rate_limit_per_minute BETWEEN 1 AND 10000),
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Enterprise SSO identity providers (OIDC). partner_id maps an organization's own IdP.
CREATE TABLE IF NOT EXISTS sso_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    issuer TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_secret_enc TEXT NOT NULL,
    allowed_domains TEXT NOT NULL,  -- comma-separated lower-case email domains
    default_role TEXT NOT NULL DEFAULT 'student' CHECK(default_role IN ('student', 'instructor')),
    auto_create INTEGER NOT NULL DEFAULT 1 CHECK(auto_create IN (0, 1)),
    jit_tags TEXT,                  -- comma-separated tags added to auto-created users
    partner_id TEXT REFERENCES partners(id) ON DELETE SET NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    last_login_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sso_identities (
    provider_id TEXT NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT,
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider_id, subject),
    UNIQUE (provider_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_sso_identities_user ON sso_identities (user_id);

-- Online meeting of an online/hybrid training session (one per session).
CREATE TABLE IF NOT EXISTS session_meetings (
    session_id TEXT PRIMARY KEY REFERENCES training_sessions(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK(provider IN ('zoom', 'teams', 'meet', 'manual')),
    join_url TEXT NOT NULL,
    external_id TEXT,
    passcode TEXT,
    starts_at TEXT NOT NULL,        -- ISO UTC
    duration_minutes INTEGER NOT NULL DEFAULT 120,
    attendance_imported_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Live classes scheduled inside an online course (shown on the learner calendar).
CREATE TABLE IF NOT EXISTS course_live_sessions (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    starts_at TEXT NOT NULL,        -- ISO UTC
    duration_minutes INTEGER NOT NULL DEFAULT 60,
    provider TEXT NOT NULL CHECK(provider IN ('zoom', 'teams', 'meet', 'manual')),
    join_url TEXT NOT NULL,
    external_id TEXT,
    passcode TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'cancelled')),
    attendance_imported_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_course_live_sessions_course ON course_live_sessions (course_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_course_live_sessions_start ON course_live_sessions (starts_at);

CREATE TABLE IF NOT EXISTS live_attendance (
    live_session_id TEXT NOT NULL REFERENCES course_live_sessions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'zoom', 'join')),
    minutes INTEGER,
    marked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (live_session_id, user_id)
);
