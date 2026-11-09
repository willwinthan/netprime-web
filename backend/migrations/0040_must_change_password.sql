-- Accounts whose password was chosen by someone else (an admin, a partner, a bulk import) must set
-- their own before using the system. middleware/rbac.ts blocks every route except /auth/me,
-- /auth/change-password and /auth/logout while it is 1; changing or resetting the password clears it.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
