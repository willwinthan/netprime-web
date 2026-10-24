CREATE TABLE IF NOT EXISTS quiz_answers (
    user_id TEXT NOT NULL REFERENCES users(id),
    quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    answer_index INTEGER NOT NULL,
    correct INTEGER NOT NULL CHECK(correct IN (0, 1)),
    submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, quiz_id)
);
