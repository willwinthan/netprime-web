-- Analytics (v0.5): presence heartbeats and accumulated learning time per user/course/day.
-- Written by handlers/analytics.ts (POST /api/me/heartbeat). Applies on a database at 0017.

-- Last heartbeat per account (online users = last_seen_at within 5 minutes).
CREATE TABLE IF NOT EXISTS user_presence (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_seen_at TEXT NOT NULL,           -- ISO time with milliseconds (UTC)
    course_id TEXT,                       -- what the user had open, if known
    lesson_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_presence_seen ON user_presence(last_seen_at);

-- Seconds spent in the console per day (Asia/Bangkok date). course_id '' = outside a course.
CREATE TABLE IF NOT EXISTS learning_time (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL DEFAULT '',
    day TEXT NOT NULL,                    -- YYYY-MM-DD
    seconds INTEGER NOT NULL DEFAULT 0 CHECK(seconds >= 0),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, course_id, day)
);
CREATE INDEX IF NOT EXISTS idx_learning_time_day ON learning_time(day);
CREATE INDEX IF NOT EXISTS idx_learning_time_course ON learning_time(course_id, day);
