-- One account may hold several roles (e.g. a coordinator who also studies).
-- users.role / users.staff_role stay as the account's primary role (highest of admin > coordinator >
-- instructor > partner > student) so existing queries for seats, learner lists and the leaderboard
-- keep working; utils/permissions.ts keeps them in sync with this table.
CREATE TABLE IF NOT EXISTS user_roles (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('admin', 'coordinator', 'instructor', 'partner', 'student')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, role)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role);

INSERT OR IGNORE INTO user_roles (user_id, role) SELECT id, COALESCE(staff_role, role) FROM users;

-- Every code path that creates a user (sign-up, OAuth, HR adding staff) gets its primary role here.
CREATE TRIGGER IF NOT EXISTS users_primary_role AFTER INSERT ON users
BEGIN
    INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (NEW.id, COALESCE(NEW.staff_role, NEW.role));
END;
