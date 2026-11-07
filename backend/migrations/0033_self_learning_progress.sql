-- Self-learning progress of signed-in learners, so a lesson continues on another device. The lesson file
-- reports it through the Lesson Kit (netprime-lesson:progress); state is the lesson's own JSON, opaque here.
CREATE TABLE IF NOT EXISTS self_learning_progress (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lesson_id TEXT NOT NULL REFERENCES self_learning_lessons(id) ON DELETE CASCADE,
    percent INTEGER NOT NULL DEFAULT 0 CHECK(percent BETWEEN 0 AND 100),
    state TEXT,                    -- JSON from the lesson, at most 64 KB
    completed_at TEXT,             -- First time the lesson reported itself complete; never cleared
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, lesson_id)
);
CREATE INDEX IF NOT EXISTS idx_self_learning_progress_lesson ON self_learning_progress (lesson_id);
