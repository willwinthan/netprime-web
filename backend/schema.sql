-- Disable foreign keys temporarily during schema reset and seeding
PRAGMA foreign_keys = OFF;

-- Clean up existing tables (dependencies first)
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

CREATE TABLE oauth_identities (
    provider TEXT NOT NULL CHECK(provider IN ('google', 'github', 'microsoft')),
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider, subject),
    UNIQUE (user_id, provider)
);

-- Course Catalog
CREATE TABLE courses (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    instructor_id TEXT NOT NULL,
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

-- Bank-transfer course orders confirmed by staff (see migrations/0013_manual_payments.sql)
CREATE TABLE course_orders (
    id TEXT PRIMARY KEY,
    reference TEXT UNIQUE NOT NULL,             -- NP-260001, quoted in the transfer note
    user_id TEXT NOT NULL REFERENCES users(id),
    course_id TEXT NOT NULL REFERENCES courses(id),
    list_price REAL NOT NULL,
    amount REAL NOT NULL,                       -- amount due after voucher, whole baht
    voucher_id TEXT REFERENCES vouchers(id) ON DELETE SET NULL,
    voucher_code TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'rejected', 'cancelled', 'expired', 'refunded')),
    expires_at TEXT NOT NULL,
    slip_r2_key TEXT,                           -- private R2 object under slips/
    slip_content_type TEXT,
    slip_uploaded_at TEXT,
    amount_received REAL,
    paid_at TEXT,
    confirmed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    receipt_no TEXT UNIQUE,                     -- RC-2026-000001
    enrollment_id TEXT,
    voucher_note TEXT,
    staff_note TEXT,
    refunded_at TEXT,
    refunded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX idx_course_orders_open ON course_orders (user_id, course_id) WHERE status = 'pending';
CREATE INDEX idx_course_orders_status ON course_orders (status, created_at);
CREATE INDEX idx_course_orders_user ON course_orders (user_id);

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
DROP TABLE IF EXISTS article_revisions;
DROP TABLE IF EXISTS privacy_requests;
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
