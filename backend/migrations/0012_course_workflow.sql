-- Voucher ownership and usage limits.
ALTER TABLE vouchers ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE vouchers ADD COLUMN max_uses INTEGER CHECK(max_uses IS NULL OR max_uses > 0);
ALTER TABLE vouchers ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0;

-- Course review workflow: draft → review → published (or archived). Existing courses stay live.
ALTER TABLE courses ADD COLUMN status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'review', 'published', 'archived'));
ALTER TABLE courses ADD COLUMN submitted_at TEXT;
ALTER TABLE courses ADD COLUMN published_at TEXT;
ALTER TABLE courses ADD COLUMN review_note TEXT;
UPDATE courses SET status = 'published', published_at = COALESCE(created_at, CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_courses_status ON courses (status);

-- Student groups belong to the instructor who created them; existing groups (NULL) are visible to admins only.
ALTER TABLE student_groups ADD COLUMN instructor_id TEXT REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_student_groups_instructor ON student_groups (instructor_id);
