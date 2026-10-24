-- One enrollment per learner and course, so activation can upsert instead of check-then-insert.
-- Existing duplicates are merged into the best row: active/completed first, then the highest progress,
-- then the earliest enrollment. Certificates and orders pointing at a dropped row move to the kept one.
CREATE TABLE IF NOT EXISTS _enrollment_merge AS
SELECT id AS old_id,
       FIRST_VALUE(id) OVER w AS keep_id,
       ROW_NUMBER() OVER w AS rn
FROM enrollments
WINDOW w AS (
  PARTITION BY user_id, course_id
  ORDER BY CASE WHEN status IN ('active', 'completed') THEN 0 ELSE 1 END,
           COALESCE(progress_percent, 0) DESC,
           enrolled_at IS NULL, enrolled_at ASC,
           id ASC
);
DELETE FROM _enrollment_merge WHERE rn = 1;

UPDATE certificates SET enrollment_id = (SELECT m.keep_id FROM _enrollment_merge m WHERE m.old_id = certificates.enrollment_id)
WHERE enrollment_id IN (SELECT old_id FROM _enrollment_merge);
UPDATE course_orders SET enrollment_id = (SELECT m.keep_id FROM _enrollment_merge m WHERE m.old_id = course_orders.enrollment_id)
WHERE enrollment_id IN (SELECT old_id FROM _enrollment_merge);
DELETE FROM enrollments WHERE id IN (SELECT old_id FROM _enrollment_merge);
DROP TABLE _enrollment_merge;

DROP INDEX IF EXISTS idx_enrollments_user_course;
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_user_course ON enrollments (user_id, course_id);
