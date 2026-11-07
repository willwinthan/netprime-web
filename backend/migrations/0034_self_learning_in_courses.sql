-- Self-learning lessons inside courses.
-- visibility 'course': published, but kept off /self-learning; only learners of a course that uses it can open it.
ALTER TABLE self_learning_lessons ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'course'));

-- A course lesson that shows a self-learning lesson. lessons.type has a CHECK constraint that D1 cannot change
-- without rebuilding the table (which would cascade-delete learner progress), so such a lesson is stored as
-- type 'embed' with this column set; the API reports it as type 'self_learning' (handlers/content.ts).
ALTER TABLE lessons ADD COLUMN self_learning_id TEXT REFERENCES self_learning_lessons(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_lessons_self_learning ON lessons (self_learning_id);
