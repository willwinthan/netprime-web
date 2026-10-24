-- Website coordinators: staff who may only manage website content.
-- users.role has a CHECK constraint and many tables reference users with ON DELETE CASCADE,
-- so rebuilding the table to add a new role value would risk cascading deletes.
-- Instead, staff_role overrides the effective role; the base role stays 'student' (least privilege
-- if staff_role is ever cleared).
ALTER TABLE users ADD COLUMN staff_role TEXT CHECK(staff_role IS NULL OR staff_role IN ('coordinator'));
