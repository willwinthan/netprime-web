-- Disable foreign keys temporarily during schema reset and seeding
PRAGMA foreign_keys = OFF;

-- Clean up existing tables (dependencies first)
DROP TABLE IF EXISTS danger_confirmations;
DROP TABLE IF EXISTS live_attendance;
DROP TABLE IF EXISTS course_live_sessions;
DROP TABLE IF EXISTS session_meetings;
DROP TABLE IF EXISTS sso_identities;
DROP TABLE IF EXISTS sso_providers;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS webhook_endpoints;
DROP TABLE IF EXISTS broadcast_recipients;
DROP TABLE IF EXISTS broadcasts;
DROP TABLE IF EXISTS notification_preferences;
DROP TABLE IF EXISTS email_templates;
DROP TABLE IF EXISTS course_announcements;
DROP TABLE IF EXISTS community_reports;
DROP TABLE IF EXISTS community_follows;
DROP TABLE IF EXISTS community_reactions;
DROP TABLE IF EXISTS community_comments;
DROP TABLE IF EXISTS community_posts;
DROP TABLE IF EXISTS community_spaces;
DROP TABLE IF EXISTS dm_messages;
DROP TABLE IF EXISTS dm_threads;
DROP TABLE IF EXISTS communication_settings;
DROP TABLE IF EXISTS push_subscriptions;
DROP TABLE IF EXISTS line_links;
DROP TABLE IF EXISTS line_link_codes;
DROP TABLE IF EXISTS voucher_campaign_codes;
DROP TABLE IF EXISTS voucher_campaigns;
DROP TABLE IF EXISTS course_reviews;
DROP TABLE IF EXISTS leads;
DROP TABLE IF EXISTS lead_forms;
DROP TABLE IF EXISTS affiliate_conversions;
DROP TABLE IF EXISTS affiliate_payouts;
DROP TABLE IF EXISTS signup_attributions;
DROP TABLE IF EXISTS affiliate_clicks;
DROP TABLE IF EXISTS affiliates;
DROP TABLE IF EXISTS affiliate_programs;
DROP TABLE IF EXISTS ai_lesson_summaries;
DROP TABLE IF EXISTS ai_usage_log;
DROP TABLE IF EXISTS course_certificate_templates;
DROP TABLE IF EXISTS certificate_templates;
DROP TABLE IF EXISTS site_pages;
DROP TABLE IF EXISTS user_import_rows;
DROP TABLE IF EXISTS user_imports;
DROP TABLE IF EXISTS staff_notes;
DROP TABLE IF EXISTS user_profile_values;
DROP TABLE IF EXISTS profile_fields;
DROP TABLE IF EXISTS segments;
DROP TABLE IF EXISTS article_revisions;
DROP TABLE IF EXISTS privacy_requests;
DROP TABLE IF EXISTS path_certificates;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS order_installments;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS quote_courses;
DROP TABLE IF EXISTS quotes;
DROP TABLE IF EXISTS product_courses;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS scorm_attempts;
DROP TABLE IF EXISTS course_prerequisites;
DROP TABLE IF EXISTS course_sections;
DROP TABLE IF EXISTS video_question_answers;
DROP TABLE IF EXISTS video_questions;
DROP TABLE IF EXISTS assignment_submissions;
DROP TABLE IF EXISTS assignments;
DROP TABLE IF EXISTS exam_answers;
DROP TABLE IF EXISTS exam_attempts;
DROP TABLE IF EXISTS exam_questions;
DROP TABLE IF EXISTS exams;
DROP TABLE IF EXISTS question_bank;
DROP TABLE IF EXISTS learning_time;
DROP TABLE IF EXISTS user_presence;
DROP TABLE IF EXISTS user_events;
DROP TABLE IF EXISTS user_tags;
DROP TABLE IF EXISTS account_tokens;
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS admin_audit_log;
DROP TABLE IF EXISTS site_settings;
DROP TABLE IF EXISTS promotions;
DROP TABLE IF EXISTS inquiries;
DROP TABLE IF EXISTS articles;
DROP TABLE IF EXISTS session_registrations;
DROP TABLE IF EXISTS training_sessions;
DROP TABLE IF EXISTS oauth_identities;
DROP TABLE IF EXISTS project_milestones;
DROP TABLE IF EXISTS project_applications;
DROP TABLE IF EXISTS it_projects;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS user_achievements;
DROP TABLE IF EXISTS achievements;
DROP TABLE IF EXISTS user_gamification;
DROP TABLE IF EXISTS internship_daily_logs;
DROP TABLE IF EXISTS internship_applications;
DROP TABLE IF EXISTS internship_openings;
DROP TABLE IF EXISTS partner_courses;
DROP TABLE IF EXISTS lesson_qa;
DROP TABLE IF EXISTS certificates;
DROP TABLE IF EXISTS lesson_progress;
DROP TABLE IF EXISTS student_notes;
DROP TABLE IF EXISTS quiz_attempts;
DROP TABLE IF EXISTS quiz_answers;
DROP TABLE IF EXISTS student_group_members;
DROP TABLE IF EXISTS student_groups;
DROP TABLE IF EXISTS payment_settings;
DROP TABLE IF EXISTS order_counters;
DROP TABLE IF EXISTS course_orders;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS vouchers;
DROP TABLE IF EXISTS quizzes;
DROP TABLE IF EXISTS enrollments;
DROP TABLE IF EXISTS lessons;
DROP TABLE IF EXISTS courses;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS course_categories;
DROP TABLE IF EXISTS partners;

-- Business Partners (B2B Corporate Clients & Academic Partners)
CREATE TABLE partners (
    id TEXT PRIMARY KEY,
    company_name TEXT NOT NULL,
    tax_id TEXT,
    total_seats INTEGER NOT NULL,
    allocated_seats INTEGER DEFAULT 0,
    partner_type TEXT CHECK(partner_type IN ('company', 'university')) DEFAULT 'company',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP)
);

-- Users and Roles
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT CHECK(role IN ('admin', 'instructor', 'partner', 'student')) NOT NULL,
    partner_id TEXT, -- Nullable, links to corporate entity if partner/student belongs to B2B
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    -- Overrides role when set (see migrations/0006_staff_role.sql); base role stays 'student'.
    staff_role TEXT CHECK(staff_role IS NULL OR staff_role IN ('coordinator')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended')),
    last_login_at TEXT,
    sessions_revoked_at TEXT, -- ISO time; tokens issued before it are rejected
    email_verified_at TEXT, -- NULL until the address is confirmed (see migrations/0011_account_tokens.sql)
    FOREIGN KEY(partner_id) REFERENCES partners(id)
);

-- Every role an account holds; users.role/staff_role keep the primary one (see migrations/0009_user_roles.sql).
CREATE TABLE user_roles (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('admin', 'coordinator', 'instructor', 'partner', 'student')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, role)
);
CREATE INDEX idx_user_roles_role ON user_roles(role);
CREATE TRIGGER users_primary_role AFTER INSERT ON users
BEGIN
    INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (NEW.id, COALESCE(NEW.staff_role, NEW.role));
END;

-- Single-use links for password reset, invitations and email verification (see utils/tokens.ts).
CREATE TABLE account_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('reset', 'invite', 'verify')),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_account_tokens_user ON account_tokens(user_id, purpose);

-- Learner/user activity log (utils/events.ts) and user tags (segments).
CREATE TABLE user_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    course_id TEXT,
    lesson_id TEXT,
    data_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_user_events_created ON user_events(created_at);
CREATE INDEX idx_user_events_user ON user_events(user_id, created_at);
CREATE INDEX idx_user_events_type ON user_events(type, created_at);
CREATE TABLE user_tags (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, tag)
);
CREATE INDEX idx_user_tags_tag ON user_tags(tag);

-- Presence heartbeats and learning time (see migrations/0020_analytics.sql).
CREATE TABLE user_presence (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_seen_at TEXT NOT NULL,
    course_id TEXT,
    lesson_id TEXT
);
CREATE INDEX idx_user_presence_seen ON user_presence(last_seen_at);
CREATE TABLE learning_time (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL DEFAULT '',
    day TEXT NOT NULL,
    seconds INTEGER NOT NULL DEFAULT 0 CHECK(seconds >= 0),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, course_id, day)
);
CREATE INDEX idx_learning_time_day ON learning_time(day);
CREATE INDEX idx_learning_time_course ON learning_time(course_id, day);

CREATE TABLE oauth_identities (
    provider TEXT NOT NULL CHECK(provider IN ('google', 'github', 'microsoft')),
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider, subject),
    UNIQUE (user_id, provider)
);

-- Course Catalog
-- Course categories (see migrations/0017_platform_foundation.sql).
CREATE TABLE course_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE courses (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    instructor_id TEXT NOT NULL,
    category_id TEXT REFERENCES course_categories(id) ON DELETE SET NULL,
    price REAL DEFAULT 0.0,
    cover_image_url TEXT,
    access_duration_days INTEGER,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    -- Review workflow (migrations/0012_course_workflow.sql): only 'published' courses are in the catalog
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'review', 'published', 'archived')),
    submitted_at TEXT,
    published_at TEXT,
    review_note TEXT,
    FOREIGN KEY(instructor_id) REFERENCES users(id)
);

-- Lessons (Linked directly with Cloudflare Stream UID or YouTube/Vimeo ID)
CREATE TABLE lessons (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL,
    title TEXT NOT NULL,
    video_stream_uid TEXT, -- Cloudflare Stream Video Object UID, YouTube ID, or Vimeo ID
    video_provider TEXT CHECK(video_provider IN ('cloudflare', 'youtube', 'vimeo')) DEFAULT 'cloudflare',
    handout_r2_key TEXT,   -- Reference link to file saved inside Cloudflare R2
    sort_order INTEGER NOT NULL,
    FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
);

-- Enrollments & Real-time Progress Tracking
CREATE TABLE enrollments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    course_id TEXT NOT NULL,
    progress_percent INTEGER DEFAULT 0, -- 0 to 100% calculate programmatically
    status TEXT CHECK(status IN ('active', 'suspended', 'completed')) DEFAULT 'active',
    enrolled_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    completed_at TEXT,
    expires_at TEXT,
    partner_id TEXT REFERENCES partners(id) ON DELETE SET NULL, -- sponsoring organization (see migrations/0015_partner_ops.sql)
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(course_id) REFERENCES courses(id)
);

-- Quiz and Assessment Engine
CREATE TABLE quizzes (
    id TEXT PRIMARY KEY,
    lesson_id TEXT NOT NULL,
    question TEXT NOT NULL,
    options_json TEXT NOT NULL, -- JSON String array of choices
    correct_option_index INTEGER NOT NULL,
    FOREIGN KEY(lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
);

-- Discount Vouchers Engine
CREATE TABLE vouchers (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    discount_type TEXT CHECK(discount_type IN ('percent', 'fixed')) NOT NULL,
    discount_value REAL NOT NULL,
    course_id TEXT, -- Nullable: if set, voucher is course-specific
    active INTEGER DEFAULT 1,
    expires_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL, -- owner; NULL = admin/legacy
    max_uses INTEGER CHECK(max_uses IS NULL OR max_uses > 0), -- NULL = unlimited
    used_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
);

-- Payments and Checkout transactions
CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    course_id TEXT NOT NULL,
    amount REAL NOT NULL,
    voucher_code TEXT,
    status TEXT CHECK(status IN ('pending', 'completed', 'failed')) DEFAULT 'pending',
    provider_charge_id TEXT,
    currency TEXT NOT NULL DEFAULT 'THB',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(course_id) REFERENCES courses(id)
);

CREATE UNIQUE INDEX payments_provider_charge_unique ON payments(provider_charge_id) WHERE provider_charge_id IS NOT NULL;

-- Bank-transfer orders confirmed by staff (migrations/0013_manual_payments.sql, rebuilt in 0023_commerce.sql):
-- a course (course_id), a product (bundle / learning path / membership / single course) or an organization quote.
CREATE TABLE course_orders (
    id TEXT PRIMARY KEY,
    reference TEXT UNIQUE NOT NULL,             -- NP-260001, quoted in the transfer note
    user_id TEXT NOT NULL REFERENCES users(id),
    course_id TEXT REFERENCES courses(id),      -- course orders and single-course products
    product_id TEXT REFERENCES products(id),
    kind TEXT NOT NULL DEFAULT 'course' CHECK(kind IN ('course', 'bundle', 'membership', 'organization')),
    item_title TEXT,                            -- product / quote title at order time
    partner_id TEXT REFERENCES partners(id) ON DELETE SET NULL, -- organization orders
    quote_id TEXT,
    seats INTEGER,
    list_price REAL NOT NULL,
    amount REAL NOT NULL,                       -- amount due after voucher, whole baht, VAT included
    voucher_id TEXT REFERENCES vouchers(id) ON DELETE SET NULL,
    voucher_code TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'partial', 'paid', 'rejected', 'cancelled', 'expired', 'refunded')),
    expires_at TEXT NOT NULL,
    installment_count INTEGER NOT NULL DEFAULT 1 CHECK(installment_count BETWEEN 1 AND 6),
    access_granted_at TEXT,                     -- courses/seats opened (once)
    suspended_at TEXT,                          -- overdue installment suspended access
    slip_r2_key TEXT,                           -- private R2 object under slips/
    slip_content_type TEXT,
    slip_uploaded_at TEXT,
    amount_received REAL,
    paid_at TEXT,
    confirmed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    receipt_no TEXT UNIQUE,                     -- RC-2026-000001 (single payment orders)
    vat_rate REAL,                              -- VAT % at receipt time (0 when not VAT registered)
    enrollment_id TEXT,
    voucher_note TEXT,
    staff_note TEXT,
    refunded_at TEXT,
    refunded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    tax_invoice_requested INTEGER NOT NULL DEFAULT 0,
    buyer_name TEXT,
    buyer_tax_id TEXT,
    buyer_branch TEXT,
    buyer_address TEXT,
    tax_invoice_no TEXT UNIQUE,                 -- TI-2026-000001
    tax_invoice_at TEXT,
    credit_note_no TEXT UNIQUE,                 -- CN-2026-000001, issued on refund of a tax-invoiced order
    credit_note_at TEXT,
    credit_note_amount REAL,
    reminder_sent_at TEXT,                      -- abandoned-order reminder (once)
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    grant_snapshot_json TEXT,                   -- courses / access days / installment rules frozen at order time (migration 0028)
    granted_days INTEGER                        -- membership days this order actually added (refunds subtract these)
);
CREATE UNIQUE INDEX idx_course_orders_open ON course_orders (user_id, course_id) WHERE status = 'pending';
CREATE UNIQUE INDEX idx_course_orders_open_product ON course_orders (user_id, product_id) WHERE status = 'pending' AND product_id IS NOT NULL;
CREATE INDEX idx_course_orders_status ON course_orders (status, created_at);
CREATE INDEX idx_course_orders_user ON course_orders (user_id);
CREATE INDEX idx_course_orders_paid ON course_orders (paid_at);

-- Sequential order references and receipt numbers per year
CREATE TABLE order_counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
);

-- Bank-transfer instructions edited by payments.manage holders
CREATE TABLE payment_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Commerce (see migrations/0023_commerce.sql): products, installments, memberships, quotes, path certificates.
CREATE TABLE products (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('course', 'bundle', 'membership')),
    title TEXT NOT NULL,
    description TEXT,
    price INTEGER NOT NULL CHECK(price >= 0),             -- whole baht, VAT included
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published', 'archived')),
    course_id TEXT REFERENCES courses(id) ON DELETE SET NULL, -- kind = 'course'
    access_days INTEGER CHECK(access_days IS NULL OR access_days > 0), -- NULL = lifetime; required for memberships
    all_courses INTEGER NOT NULL DEFAULT 0,               -- membership: every published course
    is_path INTEGER NOT NULL DEFAULT 0,                   -- bundle shown as an ordered learning path
    path_certificate INTEGER NOT NULL DEFAULT 0,          -- path completion certificate
    max_installments INTEGER NOT NULL DEFAULT 1 CHECK(max_installments BETWEEN 1 AND 6),
    installment_interval_days INTEGER NOT NULL DEFAULT 30 CHECK(installment_interval_days BETWEEN 7 AND 90),
    installment_access TEXT NOT NULL DEFAULT 'first' CHECK(installment_access IN ('first', 'full')),
    overdue_grace_days INTEGER NOT NULL DEFAULT 7 CHECK(overdue_grace_days BETWEEN 0 AND 60),
    cover_image_url TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_products_status ON products (status, kind);
CREATE TABLE product_courses (
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, course_id)
);
CREATE INDEX idx_product_courses_course ON product_courses (course_id);
CREATE TABLE quotes (
    id TEXT PRIMARY KEY,
    quote_no TEXT UNIQUE NOT NULL,                        -- QT-2026-0001
    partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    contact_name TEXT,
    contact_email TEXT,
    buyer_address TEXT,
    buyer_branch TEXT,
    seats INTEGER NOT NULL DEFAULT 0 CHECK(seats >= 0),
    price INTEGER NOT NULL CHECK(price >= 0),
    valid_until TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'sent', 'accepted', 'expired', 'cancelled')),
    note TEXT,
    order_id TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    sent_at TEXT,
    accepted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_quotes_status ON quotes (status, created_at);
CREATE TABLE quote_courses (
    quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    PRIMARY KEY (quote_id, course_id)
);
CREATE TABLE order_items (
    order_id TEXT NOT NULL REFERENCES course_orders(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    PRIMARY KEY (order_id, course_id)
);
CREATE INDEX idx_order_items_course ON order_items (course_id);
CREATE TABLE order_installments (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES course_orders(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    amount REAL NOT NULL,
    due_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'cancelled', 'refunded')),
    slip_r2_key TEXT,
    slip_content_type TEXT,
    slip_uploaded_at TEXT,
    amount_received REAL,
    paid_at TEXT,
    confirmed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    receipt_no TEXT UNIQUE,
    vat_rate REAL,
    tax_invoice_no TEXT UNIQUE,
    staff_note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (order_id, seq)
);
CREATE INDEX idx_order_installments_due ON order_installments (status, due_at);
CREATE TABLE memberships (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'expired', 'cancelled')),
    last_order_id TEXT,
    reminder_sent_for TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, product_id)
);
CREATE INDEX idx_memberships_expiry ON memberships (status, expires_at);
CREATE TABLE path_certificates (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    certificate_code TEXT UNIQUE NOT NULL,
    issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (product_id, user_id)
);

-- Student Groups (Cohorts)
CREATE TABLE student_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    instructor_id TEXT REFERENCES users(id) ON DELETE CASCADE -- owner; NULL = legacy, visible to admins only
);

-- Student Group Members mapping table
CREATE TABLE student_group_members (
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id),
    FOREIGN KEY(group_id) REFERENCES student_groups(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Quiz attempts history
CREATE TABLE quiz_attempts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    lesson_id TEXT NOT NULL,
    score INTEGER NOT NULL,
    total_questions INTEGER NOT NULL,
    submitted_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
);

-- Server-graded current answer per question; clients cannot submit an arbitrary score.
CREATE TABLE quiz_answers (
    user_id TEXT NOT NULL REFERENCES users(id),
    quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    answer_index INTEGER NOT NULL,
    correct INTEGER NOT NULL CHECK(correct IN (0, 1)),
    submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, quiz_id)
);

-- Student timestamped bookmarks/notes
CREATE TABLE student_notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    course_id TEXT NOT NULL,
    lesson_id TEXT NOT NULL,
    timestamp_seconds REAL NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE,
    FOREIGN KEY(lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
);

-- Lesson resume playback position and completion tracking
CREATE TABLE lesson_progress (
    user_id TEXT NOT NULL,
    lesson_id TEXT NOT NULL,
    course_id TEXT NOT NULL,
    resume_seconds REAL DEFAULT 0.0,
    completed INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    PRIMARY KEY (user_id, lesson_id),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(lesson_id) REFERENCES lessons(id) ON DELETE CASCADE,
    FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
);

-- Certificates issued for course completions
CREATE TABLE certificates (
    id TEXT PRIMARY KEY,
    enrollment_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    course_id TEXT NOT NULL,
    certificate_code TEXT UNIQUE NOT NULL,
    issued_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    revoked_at TEXT,
    revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    revoke_reason TEXT,
    reissued_from TEXT, -- certificate this one replaces
    FOREIGN KEY(enrollment_id) REFERENCES enrollments(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
);

-- Lesson Q&A Forum
CREATE TABLE lesson_qa (
    id TEXT PRIMARY KEY,
    lesson_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    parent_id TEXT, -- Nullable: if set, links to parent question
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY(lesson_id) REFERENCES lessons(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(parent_id) REFERENCES lesson_qa(id) ON DELETE CASCADE
);

-- B2B Sponsored Courses mapping table
CREATE TABLE partner_courses (
    partner_id TEXT NOT NULL,
    course_id TEXT NOT NULL,
    PRIMARY KEY (partner_id, course_id),
    FOREIGN KEY(partner_id) REFERENCES partners(id) ON DELETE CASCADE,
    FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
);

-- Student Internship Portal Tables
CREATE TABLE internship_openings (
    id TEXT PRIMARY KEY,
    partner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    required_course_id TEXT NOT NULL,
    status TEXT CHECK(status IN ('open', 'closed')) DEFAULT 'open',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY(partner_id) REFERENCES partners(id) ON DELETE CASCADE,
    FOREIGN KEY(required_course_id) REFERENCES courses(id) ON DELETE CASCADE
);

CREATE TABLE internship_applications (
    id TEXT PRIMARY KEY,
    opening_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    status TEXT CHECK(status IN ('applied', 'under_review', 'accepted', 'rejected', 'completed')) DEFAULT 'applied',
    evaluation_score INTEGER,
    evaluation_feedback TEXT,
    university_feedback TEXT,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY(opening_id) REFERENCES internship_openings(id) ON DELETE CASCADE,
    FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE internship_daily_logs (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    log_date TEXT NOT NULL, -- YYYY-MM-DD
    hours_worked REAL NOT NULL,
    activity_description TEXT NOT NULL,
    company_approved INTEGER DEFAULT 0, -- 0: pending, 1: approved, -1: rejected
    university_approved INTEGER DEFAULT 0, -- 0: pending, 1: approved, -1: rejected
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY(application_id) REFERENCES internship_applications(id) ON DELETE CASCADE
);

-- Student Gamification profiles
CREATE TABLE user_gamification (
    user_id TEXT PRIMARY KEY,
    exp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    title TEXT DEFAULT 'ผู้ฝึกหัดโค้ด',
    last_learn_date TEXT,
    streak_count INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Achievement Badges definitions
CREATE TABLE achievements (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    badge_icon TEXT NOT NULL, -- Lucide icon key name
    exp_reward INTEGER DEFAULT 100
);

-- Student achievements mappings
CREATE TABLE user_achievements (
    user_id TEXT NOT NULL,
    achievement_id TEXT NOT NULL,
    unlocked_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    PRIMARY KEY (user_id, achievement_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(achievement_id) REFERENCES achievements(id) ON DELETE CASCADE
);

-- Notifications table
CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ==========================================
-- SEED DATA SETUP
-- ==========================================

-- 1. Seed Partners
INSERT INTO partners (id, company_name, tax_id, total_seats, allocated_seats, partner_type) VALUES
('partner_acme', 'Acme Corporation Ltd.', 'TX-99881122', 15, 2, 'company'),
('partner_globex', 'Globex Industries Inc.', 'TX-77443311', 5, 0, 'company'),
('partner_mit', 'MIT University', 'UN-11223344', 100, 1, 'university'),
('partner_chula', 'Chulalongkorn University', 'UN-55667788', 50, 0, 'university');


-- 2. Seed Users
INSERT INTO users (id, email, password_hash, name, role, partner_id) VALUES
('usr_admin', 'admin@netprime.com', 'admin123', 'System Administrator', 'admin', NULL),
('usr_inst', 'instructor@netprime.com', 'inst123', 'Prof. Alice Smith', 'instructor', NULL),
('usr_partner', 'hr@netprime.com', 'partner123', 'Sarah Jenkins (HR)', 'partner', 'partner_acme'),
('usr_student1', 'student1@netprime.com', 'stud123', 'Alex Rivera (Acme Dev)', 'student', 'partner_acme'),
('usr_student2', 'student2@netprime.com', 'stud123', 'Bob Marley (Acme Sys)', 'student', 'partner_acme'),
('usr_student3', 'student3@netprime.com', 'stud123', 'Emma Watson (Indie Student)', 'student', NULL),
('usr_univ_coord', 'coordinator@mit.edu', 'univ123', 'Dr. John Doe (MIT Coordinator)', 'partner', 'partner_mit'),
('usr_student_univ', 'student_mit@mit.edu', 'stud123', 'Charlie Brown (MIT Student)', 'student', 'partner_mit'),
('usr_coord', 'coord@netprime.com', 'coord123', 'Nok (Training Coordinator)', 'student', NULL);

UPDATE users SET staff_role = 'coordinator' WHERE id = 'usr_coord';
UPDATE users SET email_verified_at = created_at;
UPDATE user_roles SET role = 'coordinator' WHERE user_id = 'usr_coord';

UPDATE partners SET allocated_seats = 2 WHERE id = 'partner_acme';
UPDATE partners SET allocated_seats = 1 WHERE id = 'partner_mit';

-- 3. Seed Courses (Expanded with Cisco, AWS, Arista, Aruba, Huawei, Juniper, Nutanix)
-- 3. Seed Courses (Expanded with Cisco, AWS, Arista, Aruba, Huawei, Juniper, Nutanix)
INSERT INTO courses (id, title, description, instructor_id, price) VALUES
-- Cloudflare Courses
('course_cf_workers', 'Cloudflare Workers & Hono API Gateway', 'เชี่ยวชาญการออกแบบไมโครเซอร์วิสแบบ serverless ด้วยโครงสร้างการกำหนดเส้นทางของ Hono, edge caching และการจัดการ JWT เชิงการเข้ารหัส', 'usr_inst', 1715.0),
('course_cf_d1_r2', 'D1 SQLite Database & R2 Storage Architectures', 'ออกแบบฐานข้อมูลเชิงสัมพันธ์ SQLite ที่มีความหน่วงต่ำ และเชื่อมเอกสารประกอบการเรียนกับ R2 object storage อย่างปลอดภัย', 'usr_inst', 2065.0),

-- Cisco Courses
('course_cisco_ccna', 'Cisco CCNA (200-301) Networking Masterclass', 'คู่มือครอบคลุมเรื่อง routing, switching, subnetting, IPv4/IPv6 และการตั้งค่าสวิตช์ Cisco IOS ผ่าน CLI', 'usr_inst', 3465.0),
('course_cisco_ccnp', 'Cisco CCNP Enterprise: Advanced Routing Protocols', 'เจาะลึก BGP, OSPF ขั้นสูง, EIGRP และการติดตั้ง Cisco SD-WAN overlay', 'usr_inst', 6965.0),
('course_cisco_ccie_sec', 'Cisco CCIE Security: Next-Gen Firewalls & VPNs', 'ตั้งค่านโยบายควบคุมการเข้าถึงบน Cisco ASA/FTD, สร้างอุโมงค์ IPsec VPN แบบ site-to-site และตรวจสอบเหตุการณ์ด้านความปลอดภัย', 'usr_inst', 10465.0),
('course_cisco_sdwan', 'Cisco SD-WAN & SASE Orchestration Masterclass', 'ออกแบบ overlay ด้วย vManage, กำหนด control policy ผ่าน vSmart และรักษาความปลอดภัยของ edge router', 'usr_inst', 6615.0),

-- AWS Courses
('course_aws_csa', 'AWS Solutions Architect Professional Exam Prep', 'ขยายสถาปัตยกรรมระดับองค์กร, คลัสเตอร์ load balancing, สถาปัตยกรรมจัดเก็บข้อมูล S3 และการควบคุมความปลอดภัยด้วย IAM', 'usr_inst', 5215.0),
('course_aws_net', 'AWS Advanced Networking Specialty (ANS-C01)', 'ติดตั้ง Direct Connect, สถาปัตยกรรม Transit Gateway, การเชื่อมต่อ hybrid cloud และ route table', 'usr_inst', 6265.0),
('course_aws_devops', 'AWS Certified DevOps Engineer Professional', 'ทำ provisioning อัตโนมัติด้วย CloudFormation, สร้าง CI/CD pipeline และตั้งค่าพฤติกรรม auto-scaling', 'usr_inst', 5565.0),
('course_aws_sec', 'AWS Certified Security Specialty', 'เชี่ยวชาญการมอบหมายบทบาท IAM, นโยบายคีย์เข้ารหัส KMS, การบันทึก CloudTrail และการตรวจสอบด้วย VPC traffic mirroring', 'usr_inst', 5915.0),

-- Arista Courses
('course_arista_acea', 'Arista ACEA Cloud Engineer Associate', 'ตั้งค่าแพลตฟอร์ม EOS, ใช้งานสถาปัตยกรรม SysDB และมอนิเตอร์เครือข่ายด้วย Arista CloudVision Portal (CVP)', 'usr_inst', 4165.0),
('course_arista_acep', 'Arista ACEP Cloud Engineer Professional', 'ออกแบบ leaf-spine fabric, ตั้งค่า EVPN-VXLAN และทำการตั้งค่าอัตโนมัติด้วย Ansible playbook', 'usr_inst', 6615.0),

-- Aruba Courses
('course_aruba_acsa', 'Aruba ACSA Switch Management Masterclass', 'ตั้งค่าสวิตช์ ArubaOS-CX, จัดการ VLAN ในเครือข่ายอาคาร/แคมปัส, link aggregation และ routing เบื้องต้น', 'usr_inst', 4515.0),
('course_aruba_acsp', 'Aruba ACSP Security Professional & ClearPass Integration', 'ตั้งค่าการล็อกอินเครือข่ายองค์กรด้วย 802.1X, การพิสูจน์ตัวตน RADIUS/TACACS+ และ policy template บน Aruba ClearPass', 'usr_inst', 6965.0),

-- Huawei Courses
('course_huawei_hcia', 'Huawei HCIA-Datacom Networking Associate', 'ตั้งค่าเราเตอร์องค์กร Huawei ด้วยคำสั่ง VRP CLI, เรียนรู้พื้นฐาน Datacom และบริหารจัดการเครือข่ายแบบไดนามิก', 'usr_inst', 3115.0),
('course_huawei_hcip', 'Huawei HCIP-Datacom Enterprise Routing & Switching', 'การเลือกเส้นทาง BGP ขั้นสูง, การปรับแต่งเส้นทาง OSPF แบบหลาย area และการตั้งค่า multicast บน Huawei VRP', 'usr_inst', 5215.0),

-- Juniper Courses
('course_juniper_jncia', 'Juniper JNCIA-Junos (JN0-104) Associate', 'เรียนรู้ลำดับชั้นคำสั่งของ Junos OS, ลอจิกการ commit, routing policy, firewall filter และพื้นฐาน Junos CLI', 'usr_inst', 3465.0),
('course_juniper_jncip', 'Juniper JNCIP-ENT Enterprise Routing Professional', 'routing ระดับองค์กรขั้นสูงด้วยการตั้งค่า Junos BGP, OSPF แบบหลาย area และ layer 2 VPN', 'usr_inst', 6615.0),
('course_juniper_jncie', 'Juniper JNCIE-ENT Enterprise Routing Expert Lab Prep', 'แก้โจทย์แก้ไขปัญหาระดับผู้เชี่ยวชาญ, routing loop ที่ซับซ้อน, โครงสร้าง filter และนโยบาย OSPF transit area', 'usr_inst', 10465.0),

-- Nutanix Courses
('course_nutanix_ncp', 'Nutanix NCP-MCI Multicloud Infrastructure', 'ติดตั้งและบริหารคลัสเตอร์ hyperconverged ของ Nutanix, ใช้งานเวอร์ชวลไลเซชัน Acropolis AHV และติดตั้ง Prism Central', 'usr_inst', 4865.0),
('course_nutanix_ncm', 'Nutanix NCM-MCI Multicloud Integration Professional', 'สร้างการ replicate แบบ hybrid cloud, จัดการกลุ่มป้องกัน VM และตั้งค่าแผน disaster recovery ของ Nutanix', 'usr_inst', 6965.0);

-- Demo courses are live in the catalog
UPDATE courses SET status = 'published', published_at = CURRENT_TIMESTAMP;

-- Seed Partner Courses (B2B Sponsored Courses)
INSERT INTO partner_courses (partner_id, course_id) VALUES
('partner_acme', 'course_cf_workers'),
('partner_acme', 'course_cf_d1_r2'),
('partner_acme', 'course_cisco_ccna');

-- 4. Seed Lessons
INSERT INTO lessons (id, course_id, title, video_stream_uid, video_provider, handout_r2_key, sort_order) VALUES
-- Cloudflare Lessons
('lesson_cf_workers_intro', 'course_cf_workers', 'แนะนำ Serverless Computing และ Workers CLI', 'cf-stream-uid-workers-intro', 'cloudflare', 'handouts/workers_intro.pdf', 1),
('lesson_cf_workers_hono', 'course_cf_workers', 'การกำหนดเส้นทางและการจัดการ Context ใน Hono Framework', 'cf-stream-uid-workers-hono', 'cloudflare', 'handouts/workers_hono.pdf', 2),
('lesson_cf_d1_schema', 'course_cf_d1_r2', 'การออกแบบ Relational Schema บน Cloudflare D1', 'cf-stream-uid-d1-schema', 'cloudflare', 'handouts/d1_schema.pdf', 1),

-- Cisco Lessons
('lesson_cisco_ccna_cli', 'course_cisco_ccna', 'โหมด CLI ของ Cisco IOS และ Startup Config', 'cf-stream-uid-cisco-cli', 'cloudflare', 'handouts/cisco_cli.pdf', 1),
('lesson_cisco_ccna_vlan', 'course_cisco_ccna', 'การตั้งค่า Access และ Trunk VLAN บนสวิตช์ Catalyst', 'cf-stream-uid-cisco-vlan', 'cloudflare', 'handouts/cisco_vlans.pdf', 2),
('lesson_cisco_ccnp_bgp', 'course_cisco_ccnp', 'การสร้าง External และ Internal BGP Peering', 'cf-stream-uid-cisco-bgp', 'cloudflare', 'handouts/cisco_bgp.pdf', 1),
('lesson_cisco_ccie_vpn', 'course_cisco_ccie_sec', 'การติดตั้งอุโมงค์ IPsec VPN แบบ Site-to-Site บน Cisco ASA', 'cf-stream-uid-cisco-vpn', 'cloudflare', 'handouts/cisco_vpn.pdf', 1),
('lesson_cisco_sdwan_vsmart', 'course_cisco_sdwan', 'การตั้งค่า Control Policy บน vSmart Controller', 'cf-stream-uid-cisco-sdwan', 'cloudflare', 'handouts/cisco_sdwan.pdf', 1),
('lesson_cisco_youtube', 'course_cisco_ccna', 'เสริม: ภาพรวมการทำ Subnetting เบื้องต้น (YouTube)', 'dQw4w9WgXcQ', 'youtube', 'handouts/subnetting_cheatsheet.pdf', 3),

-- AWS Lessons
('lesson_aws_csa_vpc', 'course_aws_csa', 'การออกแบบสถาปัตยกรรม VPC แบบหลาย Region พร้อม Subnet', 'cf-stream-uid-aws-vpc', 'cloudflare', 'handouts/aws_vpc.pdf', 1),
('lesson_aws_net_dx', 'course_aws_net', 'การติดตั้ง Virtual Interface ของ AWS Direct Connect', 'cf-stream-uid-aws-dx', 'cloudflare', 'handouts/aws_dx.pdf', 1),
('lesson_aws_devops_pipeline', 'course_aws_devops', 'การสร้าง CI/CD Pipeline ด้วย AWS CodePipeline และ CodeBuild', 'cf-stream-uid-aws-pipeline', 'cloudflare', 'handouts/aws_pipeline.pdf', 1),
('lesson_aws_sec_iam', 'course_aws_sec', 'การรักษาความปลอดภัยสภาพแวดล้อม AWS ด้วย IAM Role และ Boundary', 'cf-stream-uid-aws-sec-iam', 'cloudflare', 'handouts/aws_sec_iam.pdf', 1),
('lesson_aws_vimeo', 'course_aws_csa', 'เสริม: ภาพรวมสถาปัตยกรรม AWS (Vimeo)', '76979871', 'vimeo', 'handouts/aws_topology.pdf', 2),

-- Arista Lessons
('lesson_arista_eos', 'course_arista_acea', 'ทำความเข้าใจสถาปัตยกรรม Arista EOS และสถานะ SysDB', 'cf-stream-uid-arista-eos', 'cloudflare', 'handouts/arista_eos.pdf', 1),
('lesson_arista_cvp', 'course_arista_acep', 'การบริหาร Leaf-Spine Topology ด้วย Arista CloudVision Portal (CVP)', 'cf-stream-uid-arista-cvp', 'cloudflare', 'handouts/arista_cvp.pdf', 1),

-- Aruba Lessons
('lesson_aruba_cx', 'course_aruba_acsa', 'พื้นฐาน CLI ของ ArubaOS-CX และการ Commit Configuration', 'cf-stream-uid-aruba-cx', 'cloudflare', 'handouts/aruba_cx.pdf', 1),
('lesson_aruba_clearpass', 'course_aruba_acsp', 'การพิสูจน์ตัวตน RADIUS/TACACS+ ด้วย Aruba ClearPass Policy Manager', 'cf-stream-uid-aruba-clearpass', 'cloudflare', 'handouts/aruba_clearpass.pdf', 1),

-- Huawei Lessons
('lesson_huawei_vrp', 'course_huawei_hcia', 'พื้นฐานคำสั่ง Huawei VRP CLI และการบันทึก Configuration', 'cf-stream-uid-huawei-vrp', 'cloudflare', 'handouts/huawei_vrp.pdf', 1),
('lesson_huawei_ospf', 'course_huawei_hcip', 'การตั้งค่า OSPF Multi-Area Routing บน Huawei VRP CLI', 'cf-stream-uid-huawei-ospf', 'cloudflare', 'handouts/huawei_ospf.pdf', 1),

-- Juniper Lessons
('lesson_juniper_junos', 'course_juniper_jncia', 'การใช้งาน Junos OS CLI และการ Commit Candidate Configuration', 'cf-stream-uid-juniper-cli', 'cloudflare', 'handouts/juniper_cli.pdf', 1),
('lesson_juniper_policy', 'course_juniper_jncia', 'การเขียน Routing Policy และ Firewall Term ของ Junos', 'cf-stream-uid-juniper-policy', 'cloudflare', 'handouts/juniper_policies.pdf', 2),
('lesson_juniper_bgp', 'course_juniper_jncip', 'เกณฑ์การเลือกเส้นทาง BGP ของ Junos', 'cf-stream-uid-juniper-bgp', 'cloudflare', 'handouts/juniper_bgp.pdf', 1),
('lesson_juniper_jncie_lab', 'course_juniper_jncie', 'แล็บแก้ไขปัญหา Enterprise Core Routing ของ Junos', 'cf-stream-uid-juniper-jncie', 'cloudflare', 'handouts/juniper_jncie.pdf', 1),

-- Nutanix Lessons
('lesson_nutanix_ahv', 'course_nutanix_ncp', 'เวอร์ชวลไลเซชัน AHV และสถาปัตยกรรม Acropolis Hypervisor', 'cf-stream-uid-nutanix-ahv', 'cloudflare', 'handouts/nutanix_ahv.pdf', 1),
('lesson_nutanix_prism', 'course_nutanix_ncp', 'การจัดการคลัสเตอร์ด้วย Nutanix Prism Central GUI', 'cf-stream-uid-nutanix-prism', 'cloudflare', 'handouts/nutanix_prism.pdf', 2),
('lesson_nutanix_ncm_dr', 'course_nutanix_ncm', 'การตั้งค่าแผน Disaster Recovery และ Protection Domain ของ Nutanix', 'cf-stream-uid-nutanix-dr', 'cloudflare', 'handouts/nutanix_dr.pdf', 1);

-- 5. Seed Enrollments
INSERT INTO enrollments (id, user_id, course_id, progress_percent, status, enrolled_at, completed_at) VALUES
('enr_student1_c1', 'usr_student1', 'course_cf_workers', 50, 'active', '2026-06-01 10:00:00', NULL),
('enr_student3_c1', 'usr_student3', 'course_cf_workers', 100, 'completed', '2026-05-20 09:00:00', '2026-06-05 17:45:00'),
('enr_student3_c2', 'usr_student3', 'course_cisco_ccna', 0, 'active', '2026-06-05 18:00:00', NULL),
('enr_student_univ_c1', 'usr_student_univ', 'course_cf_workers', 100, 'completed', '2026-06-01 09:00:00', '2026-06-10 17:00:00');
-- Acme sponsors course_cf_workers for its learners.
UPDATE enrollments SET partner_id = 'partner_acme' WHERE id = 'enr_student1_c1';

-- 6. Seed Quizzes
INSERT INTO quizzes (id, lesson_id, question, options_json, correct_option_index) VALUES
-- Cloudflare Quizzes
('quiz_workers_intro_1', 'lesson_cf_workers_intro', 'เทคโนโลยีใดขับเคลื่อน Cloudflare Workers ในระดับ runtime', '["V8 JavaScript Engine Isolates", "Docker Containers", "Python Virtual Environments", "JVM Sandboxes"]', 0),
('quiz_workers_hono_1', 'lesson_cf_workers_hono', 'จะเรียกใช้ environment binding (เช่น DB หรือ KV) ใน Hono ได้อย่างไร', '["ผ่าน context c.env.BINDING_NAME", "ผ่าน process.env.BINDING_NAME", "ผ่าน globalThis.BINDING_NAME", "ผ่าน import BINDING_NAME"]', 0),

-- Cisco Quizzes
('quiz_cisco_cli_1', 'lesson_cisco_ccna_cli', 'คำสั่งใดใช้เปลี่ยนจาก User EXEC mode ไปเป็น Privileged EXEC mode ใน Cisco IOS', '["enable", "configure terminal", "setup", "super"]', 0),
('quiz_cisco_vlan_1', 'lesson_cisco_ccna_vlan', 'VLAN ID เริ่มต้นที่ใช้กับทราฟฟิกจัดการแบบ untagged บนสวิตช์ Cisco คืออะไร', '["VLAN 1", "VLAN 10", "VLAN 100", "VLAN 999"]', 0),
('quiz_cisco_bgp_1', 'lesson_cisco_ccnp_bgp', 'BGP ใช้พอร์ตใดในการสร้างการเชื่อมต่อ TCP peer', '["Port 179", "Port 22", "Port 80", "Port 443"]', 0),
('quiz_cisco_ccie_vpn_1', 'lesson_cisco_ccie_vpn', 'IKEv2 ใช้โปรโตคอลและพอร์ตใดในการสร้างอุโมงค์ที่ปลอดภัย', '["UDP Port 500", "TCP Port 80", "UDP Port 123", "TCP Port 443"]', 0),
('quiz_cisco_sdwan_vsmart_1', 'lesson_cisco_sdwan_vsmart', 'คอนโทรลเลอร์ใดจัดการการอัปเดต routing ของ control plane ใน Cisco SD-WAN overlay', '["vSmart", "vManage", "vBond", "vEdge"]', 0),

-- AWS Quizzes
('quiz_aws_vpc_1', 'lesson_aws_csa_vpc', 'ขนาด subnet (/CIDR) ขั้นต่ำที่แนะนำสำหรับการวาง AWS VPC คือเท่าใด', '["/28", "/16", "/24", "/32"]', 0),
('quiz_aws_dx_1', 'lesson_aws_net_dx', 'ใช้ virtual interface ประเภทใดเชื่อมต่อกับ public AWS endpoint ผ่าน Direct Connect', '["Public VIF", "Private VIF", "Transit VIF", "Local VIF"]', 0),
('quiz_aws_devops_pipeline_1', 'lesson_aws_devops_pipeline', 'บริการ AWS ใดใช้ทำ deployment โค้ดไปยัง EC2 หรือ ECS โดยอัตโนมัติ', '["AWS CodeDeploy", "AWS CodePipeline", "AWS Elastic Beanstalk", "AWS CloudFormation"]', 0),
('quiz_aws_sec_iam_1', 'lesson_aws_sec_iam', 'หน้าที่หลักของ IAM Permissions Boundary คืออะไร', '["กำหนดสิทธิ์สูงสุดที่ identity-based policy สามารถให้ได้", "ออกข้อมูลรับรองชั่วคราว", "บันทึกการเรียก API", "บล็อกการล็อกอินด้วย root"]', 0),

-- Arista Quizzes
('quiz_arista_eos_1', 'lesson_arista_eos', 'ฐานข้อมูลสถานะกลางใน Arista EOS มีชื่อว่าอะไร', '["SysDB", "MySQL", "Etcd", "SQLite"]', 0),
('quiz_arista_cvp_1', 'lesson_arista_cvp', 'ฟีเจอร์ใดของ Arista ที่ช่วยทำ zero-touch deployment และตรวจสอบสถานะ config ผ่าน CloudVision', '["Configlet builder", "SysDB API", "EOS CLI", "EAPI"]', 0),

-- Aruba Quizzes
('quiz_aruba_cx_1', 'lesson_aruba_cx', 'ระบบปฏิบัติการใดใช้บนสวิตช์ core ระดับองค์กรรุ่นใหม่ของ Aruba', '["ArubaOS-CX", "ArubaOS-Switch", "Junos", "Cisco IOS"]', 0),
('quiz_aruba_clearpass_1', 'lesson_aruba_clearpass', 'ClearPass ใช้โปรโตคอลพิสูจน์ตัวตนใดบ่อยที่สุดสำหรับการล็อกอินเครือข่ายองค์กรด้วย 802.1X', '["EAP-TLS", "PAP", "CHAP", "Kerberos"]', 0),

-- Huawei Quizzes
('quiz_huawei_vrp_1', 'lesson_huawei_vrp', 'VRP ในระบบเครือข่ายของ Huawei ย่อมาจากอะไร', '["Versatile Routing Platform", "Virtual Router Protocol", "VLAN Route Path", "Vector Routing Package"]', 0),
('quiz_huawei_ospf_1', 'lesson_huawei_ospf', 'คำสั่งใดใช้แสดงตาราง routing ของ OSPF บน Huawei VRP CLI', '["display ospf routing", "show ip ospf route", "display ip routing-table", "get ospf routes"]', 0),

-- Juniper Quizzes
('quiz_juniper_cli_1', 'lesson_juniper_junos', 'คำสั่งใดใช้ commit candidate configuration ให้เป็น active ใน Junos', '["commit", "write memory", "save", "apply"]', 0),
('quiz_juniper_policy_1', 'lesson_juniper_policy', 'ถ้าไม่มี policy term ใดตรงเงื่อนไข การดำเนินการเริ่มต้นสำหรับ routing protocol ใน Junos คืออะไร', '["ขึ้นอยู่กับกฎของ routing protocol นั้น", "ยอมรับทุก route", "ปฏิเสธทุก route", "เข้ารหัสทุกแพ็กเก็ต"]', 0),
('quiz_juniper_bgp_1', 'lesson_juniper_bgp', 'พารามิเตอร์แรกที่ Junos ตรวจสอบในกระบวนการเลือกเส้นทาง BGP คืออะไร', '["Next-hop accessibility", "Local preference", "AS path length", "MED value"]', 0),
('quiz_juniper_jncie_lab_1', 'lesson_juniper_jncie_lab', 'ใน Junos จะตรวจสอบ routing loop และ route ที่ถูกเลือกใช้งานในตาราง routing ที่ระบุได้อย่างไร', '["show route table <name>", "show ip route", "display routing table", "show junos route"]', 0),

-- Nutanix Quizzes
('quiz_nutanix_ahv_1', 'lesson_nutanix_ahv', 'แพลตฟอร์ม Nutanix HCI ถูกสร้างขึ้นโดยใช้ hypervisor ใดเป็นหลัก', '["Acropolis Hypervisor (AHV)", "VMware ESXi", "Microsoft Hyper-V", "XenServer"]', 0),
('quiz_nutanix_prism_1', 'lesson_nutanix_prism', 'อินเทอร์เฟซใดของ Nutanix ใช้จัดการหลายคลัสเตอร์จากหน้าจอเดียว', '["Prism Central", "Prism Element", "Nutanix Command CLI", "Acropolis Manager"]', 0),
('quiz_nutanix_ncm_dr_1', 'lesson_nutanix_ncm_dr', 'ใน Nutanix เรียกกลุ่ม VM ที่ถูก replicate ร่วมกันเพื่อ Disaster Recovery ว่าอะไร', '["Protection Domain", "Recovery Group", "AHV Cluster", "SLA Domain"]', 0);

-- 7. Seed Internship Portal Data
INSERT INTO internship_openings (id, partner_id, title, description, required_course_id, status) VALUES
('op_acme_frontend', 'partner_acme', 'นักพัฒนา Frontend ฝึกงาน', 'พัฒนา frontend แบบ cloud-native ด้วย React, Vite และ Hono เขียน component ให้สะอาด และเรียนรู้การจัดการ state', 'course_cf_workers', 'open'),
('op_globex_cloud', 'partner_globex', 'เจ้าหน้าที่โครงสร้างพื้นฐานคลาวด์ฝึกงาน', 'ติดตั้ง มอนิเตอร์ และตั้งค่า edge worker, DNS route และระบบ object storage', 'course_cf_workers', 'open');

INSERT INTO internship_applications (id, opening_id, student_id, status, evaluation_score, evaluation_feedback, university_feedback) VALUES
('app_student_univ_acme', 'op_acme_frontend', 'usr_student_univ', 'accepted', NULL, NULL, NULL),
('app_student3_globex', 'op_globex_cloud', 'usr_student3', 'applied', NULL, NULL, NULL);

INSERT INTO internship_daily_logs (id, application_id, log_date, hours_worked, activity_description, company_approved, university_approved) VALUES
('log_univ_acme_day1', 'app_student_univ_acme', '2026-06-12', 8.0, 'ตั้งค่าสภาพแวดล้อม Vite และออกแบบเลย์เอาต์แดชบอร์ด UI', 1, 1),
('log_univ_acme_day2', 'app_student_univ_acme', '2026-06-13', 8.0, 'เชื่อมต่อ API endpoint กับ router ฝั่ง backend ของ Hono และทดสอบในเครื่อง', 1, 0),
('log_univ_acme_day3', 'app_student_univ_acme', '2026-06-14', 6.0, 'แก้บั๊กเกี่ยวกับสถานะการยืนยันตัวตนและปรับปรุงการเข้าถึงสำหรับผู้ใช้ทุกกลุ่ม', 0, 0);

-- 8. Seed Gamification Data
INSERT INTO achievements (id, name, description, badge_icon, exp_reward) VALUES
('ach_workers_master', 'ผู้ฝึกหัด Edge', 'เรียนจบหลักสูตร Cloudflare Workers & Hono API Gateway ครบ 100%', 'Award', 500),
('ach_first_log', 'นักบันทึกประจำวัน', 'ส่งบันทึกประจำวันฝึกงานครั้งแรกแล้ว', 'BookOpen', 100),
('ach_diligent_work', 'เด็กฝึกงานมุ่งมั่น', 'สะสมบันทึกประจำวันที่ได้รับอนุมัติครบ 5 รายการ', 'Clock', 300),
('ach_high_eval', 'ผลงานยอดเยี่ยม', 'จบการฝึกงานด้วยคะแนนประเมิน 90 ขึ้นไป', 'Sparkles', 1000);

INSERT INTO user_gamification (user_id, exp, level, title) VALUES
('usr_student1', 250, 1, 'ผู้ฝึกหัดโค้ด'),
('usr_student2', 0, 1, 'ผู้ฝึกหัดโค้ด'),
('usr_student3', 500, 2, 'นักสำรวจคลาวด์'),
('usr_student_univ', 950, 2, 'นักสำรวจคลาวด์');

INSERT INTO user_achievements (user_id, achievement_id, unlocked_at) VALUES
('usr_student3', 'ach_workers_master', '2026-06-05 17:45:00'),
('usr_student_univ', 'ach_workers_master', '2026-06-10 17:00:00'),
('usr_student_univ', 'ach_first_log', '2026-06-12 18:00:00');

-- 9. IT Outsource Matching System
CREATE TABLE it_projects (
    id TEXT PRIMARY KEY,
    partner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    scope_of_work TEXT NOT NULL,
    budget_type TEXT CHECK(budget_type IN ('fixed', 'hourly')) NOT NULL,
    budget_range TEXT NOT NULL,
    required_course_id TEXT, -- Course badge needed for match
    min_level INTEGER DEFAULT 1,
    status TEXT CHECK(status IN ('open', 'active', 'completed', 'cancelled')) DEFAULT 'open',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY(partner_id) REFERENCES partners(id) ON DELETE CASCADE,
    FOREIGN KEY(required_course_id) REFERENCES courses(id) ON DELETE SET NULL
);

CREATE TABLE project_applications (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    proposal TEXT NOT NULL,
    bid_amount TEXT NOT NULL,
    status TEXT CHECK(status IN ('applied', 'accepted', 'rejected', 'completed')) DEFAULT 'applied',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY(project_id) REFERENCES it_projects(id) ON DELETE CASCADE,
    FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX project_applications_one_student_per_project
ON project_applications (project_id, student_id);

CREATE TABLE project_milestones (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    deliverables TEXT,
    status TEXT CHECK(status IN ('pending', 'submitted', 'approved', 'rejected')) DEFAULT 'pending',
    audit_report TEXT,
    quality_score INTEGER,
    timeline_risk TEXT,
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY(application_id) REFERENCES project_applications(id) ON DELETE CASCADE
);

-- Seeds for IT Outsource Matching System
INSERT INTO it_projects (id, partner_id, title, description, scope_of_work, budget_type, budget_range, required_course_id, min_level, status) VALUES
('proj_workers_gateway', 'partner_acme', 'การเชื่อมต่อ Cloudflare Workers Hono Gateway', 'ตั้งค่า edge routing gateway ประสิทธิภาพสูงด้วย Hono และกฎ cache ของ Workers KV', '### 📋 ขอบเขตงาน
- ตั้งค่าการกำหนดเส้นทาง endpoint แบบไดนามิกด้วย Cloudflare Workers
- เก็บตาราง routing cache ใน KV namespace
- พัฒนา middleware ตรวจสอบ JWT auth token อย่างปลอดภัย', 'fixed', '฿25,000 - ฿35,000', 'course_cf_workers', 2, 'open'),
('proj_aws_scaling', 'partner_acme', 'สถาปัตยกรรม Load Balancing แบบหลาย Region บน AWS', 'ออกแบบการขยายระบบคลาวด์แบบหลาย region, Route53 latency routing และการตั้งค่า EC2 auto-scaling', '### 📋 ขอบเขตงาน
- ตั้งค่า AWS Transit Gateway เชื่อมต่อหลาย VPC
- ออกแบบโปรไฟล์ Route53 latency routing
- ตั้งค่า auto-scaling group ร่วมกับ ALB load balancing', 'fixed', '฿45,000 - ฿60,000', 'course_aws_csa', 2, 'open');

-- 10. Website content (see migrations/0005_site_content.sql)

-- Classroom/online training rounds shown on the public schedule.
CREATE TABLE IF NOT EXISTS training_sessions (
    id TEXT PRIMARY KEY,
    course_id TEXT REFERENCES courses(id) ON DELETE SET NULL, -- Optional link to an LMS course
    title TEXT NOT NULL,
    vendor TEXT,                -- Cisco, Aruba, AWS ... used for filtering
    description TEXT,
    start_date TEXT NOT NULL,   -- YYYY-MM-DD (Asia/Bangkok)
    end_date TEXT NOT NULL,
    time_text TEXT,             -- Free text, e.g. 09:00–16:00
    mode TEXT NOT NULL CHECK(mode IN ('classroom', 'online', 'hybrid')) DEFAULT 'classroom',
    location TEXT,
    instructor_name TEXT,
    price INTEGER NOT NULL DEFAULT 0 CHECK(price >= 0), -- Whole THB
    capacity INTEGER NOT NULL CHECK(capacity > 0),
    registration_deadline TEXT, -- YYYY-MM-DD; NULL means until start_date
    status TEXT NOT NULL CHECK(status IN ('draft', 'open', 'closed', 'cancelled')) DEFAULT 'draft',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_training_sessions_status_start ON training_sessions (status, start_date);

-- Public registrations. Seats are held by pending/confirmed/paid/attended rows.
CREATE TABLE IF NOT EXISTS session_registrations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    company TEXT,
    attendees INTEGER NOT NULL DEFAULT 1 CHECK(attendees BETWEEN 1 AND 50),
    note TEXT,
    invoice_required INTEGER NOT NULL DEFAULT 0 CHECK(invoice_required IN (0, 1)),
    tax_id TEXT,
    billing_address TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'paid', 'waitlist', 'cancelled', 'attended')) DEFAULT 'pending',
    payment_ref TEXT,
    admin_note TEXT,
    source TEXT NOT NULL CHECK(source IN ('web', 'admin')) DEFAULT 'web',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (session_id, email)
);
CREATE INDEX IF NOT EXISTS idx_session_registrations_session ON session_registrations (session_id, status);

-- News and knowledge articles.
CREATE TABLE articles (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    category TEXT,
    excerpt TEXT,
    body TEXT NOT NULL,         -- Markdown: rendering fallback, search and share descriptions
    content_json TEXT,          -- Block editor document (BlockNote JSON); rendered when present
    cover_url TEXT,
    status TEXT NOT NULL CHECK(status IN ('draft', 'review', 'published')) DEFAULT 'draft',
    published_at TEXT,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    submitted_at TEXT,          -- When the author last sent it for review
    reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    review_note TEXT,           -- Feedback when a reviewer sends it back
    notion_page_id TEXT,        -- Source page when imported from Notion
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_articles_status_published ON articles (status, published_at);
CREATE INDEX IF NOT EXISTS idx_articles_author ON articles (author_id, status);

-- Contact form submissions.
CREATE TABLE IF NOT EXISTS inquiries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    company TEXT,
    topic TEXT,
    message TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('new', 'in_progress', 'closed')) DEFAULT 'new',
    admin_note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries (status, created_at);

-- Promotion banners/cards with an optional voucher code.
CREATE TABLE IF NOT EXISTS promotions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    voucher_code TEXT,
    link_url TEXT,
    image_url TEXT,
    starts_at TEXT,             -- YYYY-MM-DD, inclusive
    ends_at TEXT,               -- YYYY-MM-DD, inclusive
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Key/value JSON settings (contact details, announcement, notification recipients).
CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Who changed what in the content console.
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON admin_audit_log (created_at);

-- Seeds for website content (demo only)
INSERT INTO site_settings (key, value) VALUES ('site', '{"phone":"02-000-0000","email":"training@netprime.example","line":"@netprime","address":"กรุงเทพมหานคร","hours":"จ.–ศ. 08:30–17:30","announcement":{"active":true,"text":"เปิดรับสมัคร CCNA รอบเดือนพฤศจิกายน ที่นั่งจำกัด","link":"#schedule"},"notify_emails":"admin@netprime.com"}');

INSERT INTO training_sessions (id, course_id, title, vendor, description, start_date, end_date, time_text, mode, location, instructor_name, price, capacity, status) VALUES
('ses_ccna_nov', 'course_cisco_ccna', 'CCNA 200-301', 'Cisco', 'ปูพื้นฐาน Routing & Switching พร้อม Lab อุปกรณ์จริง', '2026-11-03', '2026-11-07', '09:00–16:00', 'classroom', 'ห้องอบรม NetPrime ชั้น 5', 'อ.สมชาย', 18900, 12, 'open'),
('ses_aruba_nov', 'course_aruba_acsa', 'Aruba Mobility Fundamentals', 'Aruba', 'ออกแบบและติดตั้ง Wireless องค์กร', '2026-11-12', '2026-11-14', '09:00–16:00', 'classroom', 'ห้องอบรม NetPrime ชั้น 5', 'อ.วิภา', 15500, 10, 'open'),
('ses_aws_nov', 'course_aws_csa', 'AWS Solutions Architect Associate', 'AWS', 'เรียนออนไลน์สด 4 สัปดาห์ เสาร์–อาทิตย์', '2026-11-18', '2026-12-13', 'ส.–อา. 09:00–12:00', 'online', 'Zoom + LMS', 'อ.ธนา', 12900, 30, 'open'),
('ses_secplus_dec', NULL, 'CompTIA Security+', 'CompTIA', 'เตรียมสอบ Security+ SY0-701', '2026-12-01', '2026-12-05', '09:00–16:00', 'hybrid', 'ห้องอบรม NetPrime / ออนไลน์', 'อ.ปกรณ์', 16500, 15, 'draft');

INSERT INTO session_registrations (id, session_id, name, email, phone, company, attendees, status) VALUES
('reg_demo_1', 'ses_ccna_nov', 'คุณสมศรี ตัวอย่าง', 'somsri@example.invalid', '0810000001', 'Acme Corp', 3, 'confirmed'),
('reg_demo_2', 'ses_ccna_nov', 'คุณมานะ ตัวอย่าง', 'mana@example.invalid', '0810000002', NULL, 1, 'pending');

INSERT INTO articles (id, slug, title, category, excerpt, body, status, published_at) VALUES
('art_ccna_plan', 'ccna-study-plan', 'เตรียมสอบ CCNA ให้ผ่านในรอบเดียว', 'Cisco', 'แผนอ่าน 6 สัปดาห์และ Lab ที่ต้องฝึก', 'ข้อสอบ CCNA 200-301 วัดทั้งความเข้าใจและการลงมือทำ แผนนี้แบ่งเป็น 3 ช่วง

## สัปดาห์ที่ 1: ทบทวนพื้นฐาน

เริ่มจากทบทวน OSI model และ subnetting ให้คล่อง เพราะเป็นพื้นฐานของเกือบทุกหัวข้อในข้อสอบ

## สัปดาห์ที่ 2–4: ฝึก Lab ทุกวัน

ฝึก Lab switching, VLAN และ OSPF ทุกวัน ตัวอย่างการสร้าง VLAN บนสวิตช์ Cisco:

```
Switch(config)# vlan 10
Switch(config-vlan)# name SALES
Switch(config)# interface g0/1
Switch(config-if)# switchport access vlan 10
```

- ทำ Lab ซ้ำจนพิมพ์คำสั่งได้โดยไม่ต้องเปิดโน้ต
- จดคำสั่ง **show** ที่ใช้ตรวจผลทุกครั้ง

## สัปดาห์ที่ 5–6: ซ้อมข้อสอบ

สองสัปดาห์สุดท้ายทำข้อสอบเสมือนจริงและทบทวนจุดอ่อน', 'published', '2026-10-18 09:00:00'),
('art_aruba_wifi', 'aruba-dense-wifi', 'ออกแบบ Wi-Fi สำนักงานให้รองรับผู้ใช้หนาแน่น', 'Aruba', 'Channel planning และ RF ที่ควรรู้', 'วางแผนช่องสัญญาณ 5 GHz ให้ไม่ชนกัน

ปรับกำลังส่งให้เหมาะกับขนาดห้อง แทนการเปิดสูงสุด', 'published', '2026-10-10 09:00:00'),
('art_draft', 'vsphere-8-basics', 'vSphere 8 สำหรับผู้เริ่มต้น', 'VMware', 'ติดตั้ง ESXi และ vCenter ทีละขั้น', 'ฉบับร่าง', 'draft', NULL);

INSERT INTO promotions (id, title, description, voucher_code, starts_at, ends_at, active, sort_order) VALUES
('promo_early', 'Early Bird ลด 10%', 'สมัครล่วงหน้า 30 วัน รับส่วนลดทุกหลักสูตรห้องอบรม', 'EARLY10', '2026-10-01', '2026-12-31', 1, 1);

INSERT INTO inquiries (id, name, email, phone, company, topic, message, status) VALUES
('inq_demo_1', 'คุณวิทยา ตัวอย่าง', 'witthaya@example.invalid', '0820000003', 'Globex', 'อบรม In-house', 'สนใจจัดอบรม CCNA ให้ทีม 15 คน ช่วงเดือนมกราคม', 'new');

-- Manual bank-transfer payments (demo only)
INSERT INTO payment_settings (key, value) VALUES ('bank_transfer', '{"bank_name":"ธนาคารกสิกรไทย","account_name":"บจก. เน็ตไพรม์ เทรนนิ่ง (ตัวอย่าง)","account_number":"000-0-00000-0","promptpay_id":"0000000000000","note":"โอนแล้วอัปโหลดสลิปในหน้าการชำระเงินของฉัน เจ้าหน้าที่ตรวจสอบภายใน 1 วันทำการ"}');
INSERT INTO vouchers (id, code, discount_type, discount_value, course_id, active, expires_at, max_uses, used_count) VALUES
('vouch_demo_usedup', 'DEMO-USEDUP', 'percent', 10, NULL, 1, NULL, 1, 1),
('vouch_demo_once', 'DEMO-ONCE20', 'percent', 20, NULL, 1, NULL, 1, 0),
('vouch_demo_free', 'DEMO-FREE100', 'percent', 100, NULL, 1, NULL, NULL, 0);

-- 11. Feature permissions per role (see migrations/0008_access_and_articles.sql)
CREATE TABLE IF NOT EXISTS role_permissions (
    role TEXT NOT NULL CHECK(role IN ('coordinator', 'instructor', 'partner', 'student')),
    permission TEXT NOT NULL,
    PRIMARY KEY (role, permission)
);
INSERT INTO role_permissions (role, permission) VALUES
('coordinator', 'payments.manage'),
('coordinator', 'reports.view'),
('coordinator', 'communication.manage'),
('coordinator', 'community.moderate'),
('coordinator', 'marketing.manage'),
('coordinator', 'website.design'),
('instructor', 'community.moderate'),
('coordinator', 'site.dashboard'),
('coordinator', 'site.sessions'),
('coordinator', 'site.inquiries'),
('coordinator', 'site.promotions'),
('coordinator', 'site.settings'),
('coordinator', 'site.media'),
('coordinator', 'site.audit'),
('coordinator', 'articles.write'),
('coordinator', 'articles.publish'),
('coordinator', 'articles.manage'),
('coordinator', 'articles.import_notion'),
('instructor', 'articles.write'),
('instructor', 'articles.import_notion'),
('instructor', 'site.media');

-- Enable foreign key checking again
PRAGMA foreign_keys = ON;

-- ==========================================
-- PERFORMANCE OPTIMIZATION INDEXES
-- ==========================================
-- One enrollment per learner and course; activation upserts on it (see migrations/0016_integrity.sql).
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_user_course ON enrollments (user_id, course_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_partner ON enrollments (partner_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user_lesson ON quiz_attempts (user_id, lesson_id);
CREATE INDEX IF NOT EXISTS idx_student_notes_user_course ON student_notes (user_id, course_id);
CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons (course_id);
CREATE INDEX IF NOT EXISTS idx_courses_status ON courses (status);
CREATE INDEX IF NOT EXISTS idx_student_groups_instructor ON student_groups (instructor_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_lesson ON quizzes (lesson_id);
CREATE INDEX IF NOT EXISTS idx_lesson_qa_lesson ON lesson_qa (lesson_id);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id);

-- Coordinator operations (see migrations/0014_site_ops.sql)
-- Training registrations ↔ LMS accounts (matched by email; see handlers/site.ts).
ALTER TABLE session_registrations ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
-- Set once the "starts in 2 days" reminder was sent (jobs.ts); cleared when the session date moves.
ALTER TABLE session_registrations ADD COLUMN reminder_sent_at TEXT;
CREATE INDEX IF NOT EXISTS idx_session_registrations_user ON session_registrations (user_id);
CREATE INDEX IF NOT EXISTS idx_session_registrations_email ON session_registrations (email);
UPDATE session_registrations SET user_id = (SELECT u.id FROM users u WHERE u.email = session_registrations.email)
WHERE user_id IS NULL;

-- Who saved the current article version (copied into article_revisions on the next save).
ALTER TABLE articles ADD COLUMN updated_by TEXT REFERENCES users(id) ON DELETE SET NULL;

-- Previous versions of article content; the newest 30 per article are kept.
CREATE TABLE IF NOT EXISTS article_revisions (
    id TEXT PRIMARY KEY,
    article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content_json TEXT,
    body TEXT NOT NULL,
    saved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    saved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_article_revisions_article ON article_revisions (article_id, saved_at);

-- PDPA data subject requests (account deletion). One open request per user.
CREATE TABLE IF NOT EXISTS privacy_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('deletion')) DEFAULT 'deletion',
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
    reason TEXT,
    admin_note TEXT,
    processed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    processed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS privacy_requests_one_open ON privacy_requests (user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_privacy_requests_status ON privacy_requests (status, created_at);

-- People management: segments, custom profile fields, staff notes, CSV import log (see migrations/0021_people.sql).
-- Saved audience segments; rules_json follows utils/segments.ts SegmentRules.
CREATE TABLE IF NOT EXISTS segments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    rules_json TEXT NOT NULL DEFAULT '{}',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Admin-defined profile fields. visibility: signup (signup form + profile), profile (profile only), admin (staff only).
CREATE TABLE IF NOT EXISTS profile_fields (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('text', 'number', 'date', 'select', 'checkbox')),
    options_json TEXT,
    required INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'profile' CHECK(visibility IN ('signup', 'profile', 'admin')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_profile_values (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    field_id TEXT NOT NULL REFERENCES profile_fields(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, field_id)
);
CREATE INDEX IF NOT EXISTS idx_user_profile_values_field ON user_profile_values(field_id);

-- Internal notes about a person (user detail page; never shown to the user).
CREATE TABLE IF NOT EXISTS staff_notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_staff_notes_user ON staff_notes(user_id, created_at);

-- CSV imports: one row per file, one row per processed line so a retried batch returns the stored result.
CREATE TABLE IF NOT EXISTS user_imports (
    id TEXT PRIMARY KEY,
    actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    filename TEXT,
    options_json TEXT,
    total_rows INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS user_import_rows (
    import_id TEXT NOT NULL REFERENCES user_imports(id) ON DELETE CASCADE,
    row_no INTEGER NOT NULL,
    email TEXT,
    result TEXT NOT NULL CHECK(result IN ('created', 'updated', 'skipped', 'failed')),
    user_id TEXT,
    message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (import_id, row_no)
);

-- Website builder: custom pages, certificate templates, per-course template override (see migrations/0025_website.sql).
CREATE TABLE IF NOT EXISTS site_pages (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    title_en TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published')),
    blocks_json TEXT NOT NULL DEFAULT '[]',
    blocks_en_json TEXT,
    seo_title TEXT,
    seo_description TEXT,
    og_image_url TEXT,
    published_title TEXT,
    published_title_en TEXT,
    published_blocks_json TEXT,
    published_blocks_en_json TEXT,
    published_seo_json TEXT,
    show_in_nav INTEGER NOT NULL DEFAULT 0 CHECK(show_in_nav IN (0, 1)),
    show_in_footer INTEGER NOT NULL DEFAULT 0 CHECK(show_in_footer IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    published_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_site_pages_status ON site_pages(status, sort_order);

-- Certificate designs; config_json follows handlers/website.ts CertificateConfig. One row may be the default.
CREATE TABLE IF NOT EXISTS certificate_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
    config_json TEXT NOT NULL DEFAULT '{}',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS certificate_templates_one_default ON certificate_templates(is_default) WHERE is_default = 1;

-- Per-course override; courses without a row use the default template (or the built-in design).
CREATE TABLE IF NOT EXISTS course_certificate_templates (
    course_id TEXT PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
    template_id TEXT NOT NULL REFERENCES certificate_templates(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_course_certificate_templates_template ON course_certificate_templates(template_id);

-- ==========================================
-- Assessments (see migrations/0019_assessments.sql)
-- ==========================================

-- Passing a published final exam is required before the course certificate can be claimed.
ALTER TABLE courses ADD COLUMN requires_final_exam INTEGER NOT NULL DEFAULT 0;

-- Reusable questions per course. answer_json is the answer key and never reaches learners.
CREATE TABLE IF NOT EXISTS question_bank (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('single', 'multiple', 'true_false', 'short', 'fill_blank', 'matching', 'ordering', 'essay')),
    prompt TEXT NOT NULL,
    options_json TEXT,              -- choices, {left,right} pairs or items in the correct order
    answer_json TEXT,               -- option indexes, accepted texts or per-blank accepted texts
    explanation TEXT,
    points REAL NOT NULL DEFAULT 1 CHECK(points > 0),
    tags_json TEXT NOT NULL DEFAULT '[]',
    difficulty TEXT NOT NULL DEFAULT 'medium' CHECK(difficulty IN ('easy', 'medium', 'hard')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_question_bank_course ON question_bank (course_id, created_at);

-- Exams: fixed questions (exam_questions) or a random draw from the bank (draw_rules_json).
CREATE TABLE IF NOT EXISTS exams (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    lesson_id TEXT REFERENCES lessons(id) ON DELETE SET NULL, -- optional: shown as a step of this lesson
    title TEXT NOT NULL,
    description TEXT,
    is_final INTEGER NOT NULL DEFAULT 0,
    selection_mode TEXT NOT NULL DEFAULT 'fixed' CHECK(selection_mode IN ('fixed', 'random')),
    draw_rules_json TEXT,           -- [{tag?, difficulty?, count}]
    shuffle_questions INTEGER NOT NULL DEFAULT 0,
    shuffle_options INTEGER NOT NULL DEFAULT 0,
    time_limit_minutes INTEGER,     -- NULL = no limit; enforced by exam_attempts.deadline_at
    max_attempts INTEGER,           -- NULL = unlimited
    pass_percent REAL NOT NULL DEFAULT 60,
    show_answers TEXT NOT NULL DEFAULT 'after_submit' CHECK(show_answers IN ('never', 'after_submit', 'after_pass')),
    available_from TEXT,
    available_until TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_exams_course ON exams (course_id);

CREATE TABLE IF NOT EXISTS exam_questions (
    exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES question_bank(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (exam_id, question_id)
);

-- One row per attempt; question_set_json snapshots the drawn questions (with answer keys) and display order.
CREATE TABLE IF NOT EXISTS exam_attempts (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attempt_no INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'pending_grading', 'graded')),
    question_set_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    deadline_at TEXT,
    submitted_at TEXT,
    auto_closed INTEGER NOT NULL DEFAULT 0, -- closed by the server when the deadline passed
    score REAL,
    max_score REAL,
    percent REAL,
    passed INTEGER,                 -- NULL while essays wait for grading
    feedback TEXT,
    graded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    graded_at TEXT,
    UNIQUE (exam_id, user_id, attempt_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_attempts_open ON exam_attempts (exam_id, user_id) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_exam_attempts_user ON exam_attempts (user_id, exam_id);
CREATE INDEX IF NOT EXISTS idx_exam_attempts_status ON exam_attempts (status);

CREATE TABLE IF NOT EXISTS exam_answers (
    attempt_id TEXT NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,      -- id inside the attempt snapshot (bank row may be gone)
    response_json TEXT,
    is_correct INTEGER,             -- NULL until graded (essays: manual)
    points_awarded REAL,
    max_points REAL NOT NULL DEFAULT 0,
    feedback TEXT,
    saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (attempt_id, question_id)
);

-- Assignments per lesson; files live in private R2 under assignments/.
CREATE TABLE IF NOT EXISTS assignments (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    instructions TEXT,
    max_score REAL NOT NULL DEFAULT 100,
    due_at TEXT,
    late_policy TEXT NOT NULL DEFAULT 'accept' CHECK(late_policy IN ('accept', 'penalty', 'reject')),
    late_penalty_percent REAL NOT NULL DEFAULT 0,
    allow_text INTEGER NOT NULL DEFAULT 1,
    allow_files INTEGER NOT NULL DEFAULT 1,
    rubric_json TEXT NOT NULL DEFAULT '[]', -- [{criterion, max_points}]
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments (course_id);
CREATE INDEX IF NOT EXISTS idx_assignments_lesson ON assignments (lesson_id);

-- The learner's current submission; resubmitting after "returned" bumps version.
CREATE TABLE IF NOT EXISTS assignment_submissions (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    text_content TEXT,
    files_json TEXT NOT NULL DEFAULT '[]', -- [{key, name, size, content_type}]
    status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted', 'graded', 'returned')),
    is_late INTEGER NOT NULL DEFAULT 0,
    submitted_at TEXT NOT NULL,
    score REAL,                     -- as graded
    final_score REAL,               -- after the late penalty
    rubric_scores_json TEXT,
    feedback TEXT,
    graded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    graded_at TEXT,
    UNIQUE (assignment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_assignment_submissions_status ON assignment_submissions (status, submitted_at);

-- Questions that pause a video lesson at a timestamp.
CREATE TABLE IF NOT EXISTS video_questions (
    id TEXT PRIMARY KEY,
    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    timestamp_seconds REAL NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('single', 'multiple', 'true_false')),
    prompt TEXT NOT NULL,
    options_json TEXT NOT NULL,
    answer_json TEXT NOT NULL,
    explanation TEXT,
    must_answer INTEGER NOT NULL DEFAULT 0, -- player blocks playback until answered
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_video_questions_lesson ON video_questions (lesson_id, timestamp_seconds);

CREATE TABLE IF NOT EXISTS video_question_answers (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES video_questions(id) ON DELETE CASCADE,
    response_json TEXT NOT NULL,
    is_correct INTEGER NOT NULL CHECK(is_correct IN (0, 1)),
    tries INTEGER NOT NULL DEFAULT 1,
    answered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, question_id)
);

-- ==========================================
-- Course structure & content (see migrations/0018_course_content.sql)
-- ==========================================

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

-- AI assistants: usage log and cached lesson summaries (see migrations/0027_ai.sql).
CREATE TABLE IF NOT EXISTS ai_usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature TEXT NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    input_chars INTEGER NOT NULL DEFAULT 0,
    output_chars INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER,
    mock INTEGER NOT NULL DEFAULT 0 CHECK(mock IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok', 'refused')),
    counted INTEGER NOT NULL DEFAULT 1 CHECK(counted IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_log(created_at);
CREATE TABLE IF NOT EXISTS ai_lesson_summaries (
    lesson_id TEXT PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('lesson', 'instructor')),
    source_text TEXT,
    summary TEXT NOT NULL,
    key_points_json TEXT NOT NULL,
    mock INTEGER NOT NULL DEFAULT 0 CHECK(mock IN (0, 1)),
    generated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Marketing: affiliates, signup attribution, lead forms, reviews, voucher campaigns (see migrations/0024_marketing.sql)
-- Commission programs; the default one is offered to every learner on "join".
CREATE TABLE IF NOT EXISTS affiliate_programs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    commission_percent REAL NOT NULL CHECK(commission_percent >= 0 AND commission_percent <= 100),
    auto_approve INTEGER NOT NULL DEFAULT 1 CHECK(auto_approve IN (0, 1)), -- 0 = staff approve each affiliate
    window_days INTEGER NOT NULL DEFAULT 90 CHECK(window_days BETWEEN 1 AND 3650), -- orders this long after signup earn commission
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS affiliates (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    program_id TEXT NOT NULL REFERENCES affiliate_programs(id),
    code TEXT NOT NULL UNIQUE,                  -- ?ref=CODE
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'suspended')),
    approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    approved_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_affiliates_status ON affiliates (status);

-- One row per visitor per affiliate per day (visitor_hash = hashed IP + user agent + date).
CREATE TABLE IF NOT EXISTS affiliate_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    affiliate_id TEXT NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
    path TEXT,
    visitor_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_affiliate ON affiliate_clicks (affiliate_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_affiliate_clicks_visitor ON affiliate_clicks (affiliate_id, visitor_hash);

-- First-touch source of each signup: referral code and UTM tags captured by the public site.
CREATE TABLE IF NOT EXISTS signup_attributions (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    affiliate_id TEXT REFERENCES affiliates(id) ON DELETE SET NULL,
    ref_code TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    landing_path TEXT,
    blocked_reason TEXT,                        -- e.g. self_referral; affiliate_id stays NULL
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_signup_attributions_affiliate ON signup_attributions (affiliate_id);
CREATE INDEX IF NOT EXISTS idx_signup_attributions_created ON signup_attributions (created_at);

-- Manual payouts: staff transfer the money outside the system, then record it here.
CREATE TABLE IF NOT EXISTS affiliate_payouts (
    id TEXT PRIMARY KEY,
    affiliate_id TEXT NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    reference TEXT,
    note TEXT,
    paid_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    paid_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_affiliate_payouts_affiliate ON affiliate_payouts (affiliate_id, paid_at);

-- Commission per paid course order of a referred learner (pending → approved → paid, or rejected).
CREATE TABLE IF NOT EXISTS affiliate_conversions (
    id TEXT PRIMARY KEY,
    affiliate_id TEXT NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
    order_id TEXT NOT NULL UNIQUE REFERENCES course_orders(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    order_amount REAL NOT NULL,
    commission_percent REAL NOT NULL,
    commission_amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'paid', 'rejected')),
    payout_id TEXT REFERENCES affiliate_payouts(id) ON DELETE SET NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_affiliate_conversions_affiliate ON affiliate_conversions (affiliate_id, status);

-- Lead capture forms (embedded blocks and popups).
CREATE TABLE IF NOT EXISTS lead_forms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,                         -- internal name
    title TEXT NOT NULL,                        -- shown to visitors
    description TEXT,
    fields_json TEXT NOT NULL,                  -- [{key,label,type,required,options?}]
    submit_label TEXT,
    success_message TEXT,
    consent_text TEXT,
    auto_tag TEXT,                              -- user_tags tag added when the email matches an account
    notify_emails TEXT,                         -- comma separated; empty = site notification recipients
    popup_json TEXT,                            -- {enabled,trigger,delay_seconds,scroll_percent,frequency_days,pages}
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    form_id TEXT REFERENCES lead_forms(id) ON DELETE SET NULL,
    name TEXT,
    email TEXT NOT NULL,
    phone TEXT,
    company TEXT,
    data_json TEXT,                             -- custom field answers
    consent INTEGER NOT NULL DEFAULT 1 CHECK(consent IN (0, 1)),
    consent_text TEXT,                          -- wording the visitor agreed to (PDPA record)
    page_path TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'contacted', 'qualified', 'converted', 'lost')),
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_leads_form ON leads (form_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads (email);

-- Learner ratings; only approved reviews count toward the public average.
CREATE TABLE IF NOT EXISTS course_reviews (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    body TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'hidden')),
    moderated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    moderated_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (course_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_course_reviews_course ON course_reviews (course_id, status);
CREATE INDEX IF NOT EXISTS idx_course_reviews_status ON course_reviews (status, created_at);

-- Bulk single-use voucher codes; the codes themselves are ordinary rows in vouchers.
CREATE TABLE IF NOT EXISTS voucher_campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    discount_type TEXT NOT NULL CHECK(discount_type IN ('percent', 'fixed')),
    discount_value REAL NOT NULL,
    course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
    expires_at TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS voucher_campaign_codes (
    campaign_id TEXT NOT NULL REFERENCES voucher_campaigns(id) ON DELETE CASCADE,
    voucher_id TEXT NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE CASCADE,
    PRIMARY KEY (campaign_id, voucher_id)
);

INSERT OR IGNORE INTO affiliate_programs (id, name, commission_percent, auto_approve, window_days, active, is_default)
VALUES ('aff_default', 'โปรแกรมแนะนำเพื่อน', 10, 1, 90, 1, 1);

-- Communication & community (see migrations/0022_communication.sql)
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

-- ==========================================
-- Platform: webhooks, API keys, enterprise SSO, live meetings (see migrations/0026_platform.sql)
-- ==========================================
-- Outgoing webhook endpoints. secret_enc is AES-GCM encrypted (utils/secretbox.ts); never returned.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    secret_enc TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '["*"]',  -- JSON array of event names, or ["*"]
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Delivery log and retry queue (pending rows are retried with backoff; kept 30 days).
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'success', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    response_code INTEGER,
    duration_ms INTEGER,
    error TEXT,
    response_excerpt TEXT,
    next_attempt_at TEXT,
    locked_until TEXT,
    last_attempt_at TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);

-- Public REST API keys: only the SHA-256 hash is stored; the key is shown once.
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scopes TEXT NOT NULL,  -- JSON array
    rate_limit_per_minute INTEGER NOT NULL DEFAULT 120 CHECK(rate_limit_per_minute BETWEEN 1 AND 10000),
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Enterprise SSO identity providers (OIDC). partner_id maps an organization's own IdP.
CREATE TABLE IF NOT EXISTS sso_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    issuer TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_secret_enc TEXT NOT NULL,
    allowed_domains TEXT NOT NULL,  -- comma-separated lower-case email domains
    default_role TEXT NOT NULL DEFAULT 'student' CHECK(default_role IN ('student', 'instructor')),
    auto_create INTEGER NOT NULL DEFAULT 1 CHECK(auto_create IN (0, 1)),
    jit_tags TEXT,                  -- comma-separated tags added to auto-created users
    partner_id TEXT REFERENCES partners(id) ON DELETE SET NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    last_login_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sso_identities (
    provider_id TEXT NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT,
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider_id, subject),
    UNIQUE (provider_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_sso_identities_user ON sso_identities (user_id);

-- Online meeting of an online/hybrid training session (one per session).
CREATE TABLE IF NOT EXISTS session_meetings (
    session_id TEXT PRIMARY KEY REFERENCES training_sessions(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK(provider IN ('zoom', 'teams', 'meet', 'manual')),
    join_url TEXT NOT NULL,
    external_id TEXT,
    passcode TEXT,
    starts_at TEXT NOT NULL,        -- ISO UTC
    duration_minutes INTEGER NOT NULL DEFAULT 120,
    attendance_imported_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Live classes scheduled inside an online course (shown on the learner calendar).
CREATE TABLE IF NOT EXISTS course_live_sessions (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    starts_at TEXT NOT NULL,        -- ISO UTC
    duration_minutes INTEGER NOT NULL DEFAULT 60,
    provider TEXT NOT NULL CHECK(provider IN ('zoom', 'teams', 'meet', 'manual')),
    join_url TEXT NOT NULL,
    external_id TEXT,
    passcode TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'cancelled')),
    attendance_imported_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_course_live_sessions_course ON course_live_sessions (course_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_course_live_sessions_start ON course_live_sessions (starts_at);

CREATE TABLE IF NOT EXISTS live_attendance (
    live_session_id TEXT NOT NULL REFERENCES course_live_sessions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'zoom', 'join')),
    minutes INTEGER,
    marked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (live_session_id, user_id)
);

-- ==========================================
-- Dangerous deletions: email confirmation codes (see migrations/0029_delete_confirmations.sql)
-- ==========================================
CREATE TABLE IF NOT EXISTS danger_confirmations (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,                 -- e.g. course.delete, webhook.delete, privacy.approve
    target_id TEXT NOT NULL,
    requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    approver_kind TEXT NOT NULL CHECK(approver_kind IN ('owner', 'admin')),
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,             -- ISO UTC
    attempts INTEGER NOT NULL DEFAULT 0,  -- wrong tries; 5 = invalidated
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_danger_confirmations_lookup ON danger_confirmations (action, target_id, requested_by, created_at);
