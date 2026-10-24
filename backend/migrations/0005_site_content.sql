-- Website content managed by coordinators (admin role) without code changes.
-- Additive only: safe to apply to an existing database.

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
CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    category TEXT,
    excerpt TEXT,
    body TEXT NOT NULL,         -- Plain text; blank lines separate paragraphs
    cover_url TEXT,
    status TEXT NOT NULL CHECK(status IN ('draft', 'published')) DEFAULT 'draft',
    published_at TEXT,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_articles_status_published ON articles (status, published_at);

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
