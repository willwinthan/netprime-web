-- Partner/HR operations: remember which organization sponsored an enrollment, so removing or
-- transferring an employee suspends only what the organization paid for (personal purchases stay).
ALTER TABLE enrollments ADD COLUMN partner_id TEXT REFERENCES partners(id) ON DELETE SET NULL;

-- Backfill: an organization learner's enrollment in a course their organization sponsors, with no
-- paid course order and no completed personal payment, was created by the organization.
UPDATE enrollments SET partner_id = (SELECT u.partner_id FROM users u WHERE u.id = enrollments.user_id)
WHERE partner_id IS NULL
  AND EXISTS (SELECT 1 FROM users u JOIN partner_courses pc ON pc.partner_id = u.partner_id AND pc.course_id = enrollments.course_id
              WHERE u.id = enrollments.user_id)
  AND NOT EXISTS (SELECT 1 FROM course_orders o WHERE o.user_id = enrollments.user_id AND o.course_id = enrollments.course_id AND o.status = 'paid')
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.user_id = enrollments.user_id AND p.course_id = enrollments.course_id AND p.status = 'completed');

CREATE INDEX IF NOT EXISTS idx_enrollments_partner ON enrollments (partner_id);
