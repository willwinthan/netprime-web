-- Check and resolve existing duplicates before applying to a populated database:
-- SELECT project_id, student_id, COUNT(*) FROM project_applications
-- GROUP BY project_id, student_id HAVING COUNT(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS project_applications_one_student_per_project
ON project_applications (project_id, student_id);
