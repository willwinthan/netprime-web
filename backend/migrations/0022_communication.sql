-- Communication & community (v0.5): broadcasts, course announcements, email templates, community spaces,
-- direct messages, web push, LINE linking and per-user notification preferences.

-- In-app notifications may carry a link (opened on click) and a category (broadcast, announcement, community, message).
ALTER TABLE notifications ADD COLUMN link TEXT;
ALTER TABLE notifications ADD COLUMN category TEXT;

-- Per-user channel preferences; a missing row means every channel is on.
CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email_marketing INTEGER NOT NULL DEFAULT 1,
    email_course INTEGER NOT NULL DEFAULT 1,
    push INTEGER NOT NULL DEFAULT 1,
    line INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Staff overrides of system emails (utils/email.ts EMAIL_TEMPLATES); no row = built-in email.
CREATE TABLE IF NOT EXISTS email_templates (
    key TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    body_html TEXT NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Messages to an audience (segment rules) over email / in-app / web push / LINE.
CREATE TABLE IF NOT EXISTS broadcasts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    subject TEXT NOT NULL,
    body_markdown TEXT NOT NULL,
    body_html TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'marketing' CHECK(category IN ('marketing', 'course', 'system')),
    channels_json TEXT NOT NULL DEFAULT '["email","in_app"]',
    audience_json TEXT NOT NULL DEFAULT '{}',
    course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
    link TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed')),
    scheduled_at TEXT,
    api_origin TEXT,
    recipient_count INTEGER NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_broadcasts_creator ON broadcasts(created_by, created_at);

-- One row per recipient and channel; processed in chunks of 100 (immediately and by the daily cron).
CREATE TABLE IF NOT EXISTS broadcast_recipients (
    broadcast_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK(channel IN ('email', 'in_app', 'push', 'line')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
    detail TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (broadcast_id, user_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_status ON broadcast_recipients(broadcast_id, status);

-- Instructor posts to the learners of one course.
CREATE TABLE IF NOT EXISTS course_announcements (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    body_markdown TEXT NOT NULL,
    body_html TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    email_sent INTEGER NOT NULL DEFAULT 0,
    recipient_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_course_announcements_course ON course_announcements(course_id, created_at);

-- Community: school-wide (course_id NULL) and course spaces.
CREATE TABLE IF NOT EXISTS community_spaces (
    id TEXT PRIMARY KEY,
    course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'course')),
    posting TEXT NOT NULL DEFAULT 'everyone' CHECK(posting IN ('everyone', 'staff')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_community_spaces_course ON community_spaces(course_id);

CREATE TABLE IF NOT EXISTS community_posts (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES community_spaces(id) ON DELETE CASCADE,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    body_markdown TEXT NOT NULL,
    body_html TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    locked INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_activity_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_community_posts_space ON community_posts(space_id, pinned, last_activity_at);

CREATE TABLE IF NOT EXISTS community_comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    body_markdown TEXT NOT NULL,
    body_html TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_community_comments_post ON community_comments(post_id, created_at);

CREATE TABLE IF NOT EXISTS community_reactions (
    target_type TEXT NOT NULL CHECK(target_type IN ('post', 'comment')),
    target_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reaction TEXT NOT NULL CHECK(reaction IN ('like', 'love', 'insightful', 'thanks')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (target_type, target_id, user_id, reaction)
);

-- Followers get an in-app notification for new posts (space) or new comments (post).
CREATE TABLE IF NOT EXISTS community_follows (
    target_type TEXT NOT NULL CHECK(target_type IN ('space', 'post')),
    target_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (target_type, target_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_community_follows_user ON community_follows(user_id);

CREATE TABLE IF NOT EXISTS community_reports (
    id TEXT PRIMARY KEY,
    target_type TEXT NOT NULL CHECK(target_type IN ('post', 'comment')),
    target_id TEXT NOT NULL,
    space_id TEXT REFERENCES community_spaces(id) ON DELETE CASCADE,
    reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved', 'dismissed')),
    resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_community_reports_status ON community_reports(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS community_reports_one_open ON community_reports(target_type, target_id, reporter_id) WHERE status = 'open';

-- Direct messages: 1:1 threads (user1_id < user2_id). Times are ISO with milliseconds for unread counts.
CREATE TABLE IF NOT EXISTS dm_threads (
    id TEXT PRIMARY KEY,
    user1_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user2_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_message_at TEXT,
    user1_read_at TEXT,
    user2_read_at TEXT,
    UNIQUE (user1_id, user2_id)
);
CREATE INDEX IF NOT EXISTS idx_dm_threads_user2 ON dm_threads(user2_id);

CREATE TABLE IF NOT EXISTS dm_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
    sender_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    attachment_key TEXT,
    attachment_type TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_dm_messages_thread ON dm_messages(thread_id, created_at);

-- Communication settings (key/value), e.g. dm_learner_to_learner = '0'.
CREATE TABLE IF NOT EXISTS communication_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Browser push subscriptions (Web Push / VAPID).
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

-- LINE Official Account links (user sends a one-time code to the OA chat; the webhook links it).
CREATE TABLE IF NOT EXISTS line_links (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    line_user_id TEXT NOT NULL UNIQUE,
    linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS line_link_codes (
    code TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_line_link_codes_user ON line_link_codes(user_id);

-- School-wide default space.
INSERT OR IGNORE INTO community_spaces (id, course_id, name, description, visibility, posting, sort_order)
VALUES ('space_general', NULL, 'ห้องรวมทั่วไป', 'พูดคุย แลกเปลี่ยน และถามตอบกับเพื่อนผู้เรียนและทีมงาน', 'public', 'everyone', 0);
