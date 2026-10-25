-- v0.5 course structure & content: chapters, lesson types (text/pdf/embed/scorm), drip and
-- sequential unlocking, prerequisite courses, sales-page fields and SCORM 1.2 attempts.

-- Chapters ("บท") that group lessons in the builder and the learner player.
CREATE TABLE IF NOT EXISTS course_sections (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_course_sections_course ON course_sections (course_id, sort_order);

-- Lessons: chapter, content type and per-type content. Existing lessons stay 'video'.
ALTER TABLE lessons ADD COLUMN section_id TEXT REFERENCES course_sections(id) ON DELETE SET NULL;
ALTER TABLE lessons ADD COLUMN type TEXT NOT NULL DEFAULT 'video' CHECK(type IN ('video', 'text', 'pdf', 'embed', 'scorm'));
ALTER TABLE lessons ADD COLUMN content_json TEXT;   -- text: BlockNote document JSON
ALTER TABLE lessons ADD COLUMN content_md TEXT;     -- text: Markdown fallback (search, old clients)
ALTER TABLE lessons ADD COLUMN pdf_r2_key TEXT;     -- pdf: R2 key under the uploader's prefix
ALTER TABLE lessons ADD COLUMN embed_url TEXT;      -- embed: allowlisted https URL (utils/embeds.ts)
ALTER TABLE lessons ADD COLUMN scorm_base TEXT;     -- scorm: R2 prefix of the unzipped package (scorm/<lessonId>/<uploadId>/)
ALTER TABLE lessons ADD COLUMN scorm_launch TEXT;   -- scorm: launch href from imsmanifest.xml, relative to scorm_base
-- Drip: unlock N days after enrollment and/or on a date (YYYY-MM-DD, Asia/Bangkok midnight).
ALTER TABLE lessons ADD COLUMN available_after_days INTEGER;
ALTER TABLE lessons ADD COLUMN available_on TEXT;
CREATE INDEX IF NOT EXISTS idx_lessons_section ON lessons (section_id);

-- Courses: "เรียนตามลำดับ" and sales-page fields (lists/FAQ are JSON arrays).
ALTER TABLE courses ADD COLUMN sequential INTEGER NOT NULL DEFAULT 0;
ALTER TABLE courses ADD COLUMN subtitle TEXT;
ALTER TABLE courses ADD COLUMN learning_outcomes_json TEXT;
ALTER TABLE courses ADD COLUMN requirements_json TEXT;
ALTER TABLE courses ADD COLUMN target_audience_json TEXT;
ALTER TABLE courses ADD COLUMN level TEXT;
ALTER TABLE courses ADD COLUMN language TEXT;
ALTER TABLE courses ADD COLUMN duration_hours REAL;
ALTER TABLE courses ADD COLUMN promo_video_url TEXT;
ALTER TABLE courses ADD COLUMN faq_json TEXT;
CREATE INDEX IF NOT EXISTS idx_courses_category ON courses (category_id);

-- Courses a learner must complete before enrolling in / ordering course_id.
CREATE TABLE IF NOT EXISTS course_prerequisites (
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    prerequisite_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    PRIMARY KEY (course_id, prerequisite_id)
);
CREATE INDEX IF NOT EXISTS idx_course_prerequisites_prereq ON course_prerequisites (prerequisite_id);

-- SCORM 1.2 runtime data, one row per learner and lesson (handlers/scorm.ts).
CREATE TABLE IF NOT EXISTS scorm_attempts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    lesson_status TEXT NOT NULL DEFAULT 'not attempted',
    score_raw REAL,
    score_min REAL,
    score_max REAL,
    lesson_location TEXT,
    suspend_data TEXT,
    session_time TEXT,
    total_seconds REAL NOT NULL DEFAULT 0,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, lesson_id)
);
CREATE INDEX IF NOT EXISTS idx_scorm_attempts_lesson ON scorm_attempts (lesson_id);
