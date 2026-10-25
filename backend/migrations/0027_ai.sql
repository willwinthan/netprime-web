-- AI assistants (handlers/ai.ts, utils/aiclient.ts): usage log for quotas/reports and cached lesson summaries.
-- Settings (per-feature switches, quotas) live in site_settings under key 'ai'.

-- One row per AI request. Sizes and flags only: prompt and answer text are never stored.
CREATE TABLE IF NOT EXISTS ai_usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature TEXT NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL, -- NULL for the public chatbot
    input_chars INTEGER NOT NULL DEFAULT 0,
    output_chars INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER,
    mock INTEGER NOT NULL DEFAULT 0 CHECK(mock IN (0, 1)),   -- 1 = deterministic fallback (AI unavailable)
    status TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok', 'refused')),
    counted INTEGER NOT NULL DEFAULT 1 CHECK(counted IN (0, 1)), -- 0 = not charged to the daily quota
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_log(created_at);

-- Learner-facing summary per lesson, regenerated when the lesson text changes (content_hash).
CREATE TABLE IF NOT EXISTS ai_lesson_summaries (
    lesson_id TEXT PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('lesson', 'instructor')), -- lesson text, or notes/transcript pasted by the instructor
    source_text TEXT,
    summary TEXT NOT NULL,
    key_points_json TEXT NOT NULL,
    mock INTEGER NOT NULL DEFAULT 0 CHECK(mock IN (0, 1)),
    generated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
