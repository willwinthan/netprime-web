-- Assessments (v0.5): question bank, exams with attempts, assignments, interactive video questions.
-- The simple lesson quiz (quizzes / quiz_answers) stays unchanged. Handlers: src/handlers/assessments.ts.

-- Passing a published final exam is required before the course certificate can be claimed.
ALTER TABLE courses ADD COLUMN requires_final_exam INTEGER NOT NULL DEFAULT 0;

-- Reusable questions per course. answer_json is the answer key and never reaches learners.
CREATE TABLE IF NOT EXISTS question_bank (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('single', 'multiple', 'true_false', 'short', 'fill_blank', 'matching', 'ordering', 'essay')),
    prompt TEXT NOT NULL,
    options_json TEXT,              -- choices, {left,right} pairs or items in the correct order
    answer_json TEXT,               -- option indexes, accepted texts or per-blank accepted texts
    explanation TEXT,
    points REAL NOT NULL DEFAULT 1 CHECK(points > 0),
    tags_json TEXT NOT NULL DEFAULT '[]',
    difficulty TEXT NOT NULL DEFAULT 'medium' CHECK(difficulty IN ('easy', 'medium', 'hard')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_question_bank_course ON question_bank (course_id, created_at);

-- Exams: fixed questions (exam_questions) or a random draw from the bank (draw_rules_json).
CREATE TABLE IF NOT EXISTS exams (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    lesson_id TEXT REFERENCES lessons(id) ON DELETE SET NULL, -- optional: shown as a step of this lesson
    title TEXT NOT NULL,
    description TEXT,
    is_final INTEGER NOT NULL DEFAULT 0,
    selection_mode TEXT NOT NULL DEFAULT 'fixed' CHECK(selection_mode IN ('fixed', 'random')),
    draw_rules_json TEXT,           -- [{tag?, difficulty?, count}]
    shuffle_questions INTEGER NOT NULL DEFAULT 0,
    shuffle_options INTEGER NOT NULL DEFAULT 0,
    time_limit_minutes INTEGER,     -- NULL = no limit; enforced by exam_attempts.deadline_at
    max_attempts INTEGER,           -- NULL = unlimited
    pass_percent REAL NOT NULL DEFAULT 60,
    show_answers TEXT NOT NULL DEFAULT 'after_submit' CHECK(show_answers IN ('never', 'after_submit', 'after_pass')),
    available_from TEXT,
    available_until TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_exams_course ON exams (course_id);

CREATE TABLE IF NOT EXISTS exam_questions (
    exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES question_bank(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (exam_id, question_id)
);

-- One row per attempt; question_set_json snapshots the drawn questions (with answer keys) and display order.
CREATE TABLE IF NOT EXISTS exam_attempts (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attempt_no INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'pending_grading', 'graded')),
    question_set_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    deadline_at TEXT,
    submitted_at TEXT,
    auto_closed INTEGER NOT NULL DEFAULT 0, -- closed by the server when the deadline passed
    score REAL,
    max_score REAL,
    percent REAL,
    passed INTEGER,                 -- NULL while essays wait for grading
    feedback TEXT,
    graded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    graded_at TEXT,
    UNIQUE (exam_id, user_id, attempt_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_attempts_open ON exam_attempts (exam_id, user_id) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_exam_attempts_user ON exam_attempts (user_id, exam_id);
CREATE INDEX IF NOT EXISTS idx_exam_attempts_status ON exam_attempts (status);

CREATE TABLE IF NOT EXISTS exam_answers (
    attempt_id TEXT NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,      -- id inside the attempt snapshot (bank row may be gone)
    response_json TEXT,
    is_correct INTEGER,             -- NULL until graded (essays: manual)
    points_awarded REAL,
    max_points REAL NOT NULL DEFAULT 0,
    feedback TEXT,
    saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (attempt_id, question_id)
);

-- Assignments per lesson; files live in private R2 under assignments/.
CREATE TABLE IF NOT EXISTS assignments (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    instructions TEXT,
    max_score REAL NOT NULL DEFAULT 100,
    due_at TEXT,
    late_policy TEXT NOT NULL DEFAULT 'accept' CHECK(late_policy IN ('accept', 'penalty', 'reject')),
    late_penalty_percent REAL NOT NULL DEFAULT 0,
    allow_text INTEGER NOT NULL DEFAULT 1,
    allow_files INTEGER NOT NULL DEFAULT 1,
    rubric_json TEXT NOT NULL DEFAULT '[]', -- [{criterion, max_points}]
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments (course_id);
CREATE INDEX IF NOT EXISTS idx_assignments_lesson ON assignments (lesson_id);

-- The learner's current submission; resubmitting after "returned" bumps version.
CREATE TABLE IF NOT EXISTS assignment_submissions (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    text_content TEXT,
    files_json TEXT NOT NULL DEFAULT '[]', -- [{key, name, size, content_type}]
    status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted', 'graded', 'returned')),
    is_late INTEGER NOT NULL DEFAULT 0,
    submitted_at TEXT NOT NULL,
    score REAL,                     -- as graded
    final_score REAL,               -- after the late penalty
    rubric_scores_json TEXT,
    feedback TEXT,
    graded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    graded_at TEXT,
    UNIQUE (assignment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_assignment_submissions_status ON assignment_submissions (status, submitted_at);

-- Questions that pause a video lesson at a timestamp.
CREATE TABLE IF NOT EXISTS video_questions (
    id TEXT PRIMARY KEY,
    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    timestamp_seconds REAL NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('single', 'multiple', 'true_false')),
    prompt TEXT NOT NULL,
    options_json TEXT NOT NULL,
    answer_json TEXT NOT NULL,
    explanation TEXT,
    must_answer INTEGER NOT NULL DEFAULT 0, -- player blocks playback until answered
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_video_questions_lesson ON video_questions (lesson_id, timestamp_seconds);

CREATE TABLE IF NOT EXISTS video_question_answers (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES video_questions(id) ON DELETE CASCADE,
    response_json TEXT NOT NULL,
    is_correct INTEGER NOT NULL CHECK(is_correct IN (0, 1)),
    tries INTEGER NOT NULL DEFAULT 1,
    answered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, question_id)
);
