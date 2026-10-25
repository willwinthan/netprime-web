-- Commerce v0.5: tax invoices, products (single course / bundle or learning path / membership),
-- installments, organization quotes, abandoned-order reminders and sales reports.
-- Everything is still paid by bank transfer and confirmed by staff (payments.manage).

PRAGMA defer_foreign_keys = on;

-- Products sold besides plain courses. Bundles enroll into every course at once (an ordered bundle
-- with is_path = 1 is shown as a learning path); memberships open a set of courses (or every
-- published course) for access_days and are renewed with a new order.
CREATE TABLE IF NOT EXISTS products (
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
CREATE INDEX IF NOT EXISTS idx_products_status ON products (status, kind);

CREATE TABLE IF NOT EXISTS product_courses (
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, course_id)
);
CREATE INDEX IF NOT EXISTS idx_product_courses_course ON product_courses (course_id);

-- Quotations for organizations (commerce.manage). Accepting creates an organization order; its
-- confirmation adds the seats to the partner and sponsors the courses (partner_courses).
CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    quote_no TEXT UNIQUE NOT NULL,                        -- QT-2026-0001
    partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    contact_name TEXT,
    contact_email TEXT,
    buyer_address TEXT,
    buyer_branch TEXT,
    seats INTEGER NOT NULL DEFAULT 0 CHECK(seats >= 0),
    price INTEGER NOT NULL CHECK(price >= 0),             -- whole baht, VAT included
    valid_until TEXT NOT NULL,                            -- YYYY-MM-DD
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'sent', 'accepted', 'expired', 'cancelled')),
    note TEXT,
    order_id TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    sent_at TEXT,
    accepted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes (status, created_at);

CREATE TABLE IF NOT EXISTS quote_courses (
    quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    PRIMARY KEY (quote_id, course_id)
);

-- course_orders is rebuilt: course_id becomes optional (product and organization orders), the status
-- gains 'partial' (some installments paid) and the order carries product, tax invoice, installment,
-- credit note and reminder fields.
CREATE TABLE course_orders_v2 (
    id TEXT PRIMARY KEY,
    reference TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    course_id TEXT REFERENCES courses(id),
    product_id TEXT REFERENCES products(id),
    kind TEXT NOT NULL DEFAULT 'course' CHECK(kind IN ('course', 'bundle', 'membership', 'organization')),
    item_title TEXT,
    partner_id TEXT REFERENCES partners(id) ON DELETE SET NULL,
    quote_id TEXT,
    seats INTEGER,
    list_price REAL NOT NULL,
    amount REAL NOT NULL,
    voucher_id TEXT REFERENCES vouchers(id) ON DELETE SET NULL,
    voucher_code TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'partial', 'paid', 'rejected', 'cancelled', 'expired', 'refunded')),
    expires_at TEXT NOT NULL,
    installment_count INTEGER NOT NULL DEFAULT 1 CHECK(installment_count BETWEEN 1 AND 6),
    access_granted_at TEXT,
    suspended_at TEXT,
    slip_r2_key TEXT,
    slip_content_type TEXT,
    slip_uploaded_at TEXT,
    amount_received REAL,
    paid_at TEXT,
    confirmed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    receipt_no TEXT UNIQUE,
    vat_rate REAL,
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
    tax_invoice_no TEXT UNIQUE,
    tax_invoice_at TEXT,
    credit_note_no TEXT UNIQUE,
    credit_note_at TEXT,
    credit_note_amount REAL,
    reminder_sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO course_orders_v2 (id, reference, user_id, course_id, kind, list_price, amount, voucher_id, voucher_code, status, expires_at,
    access_granted_at, slip_r2_key, slip_content_type, slip_uploaded_at, amount_received, paid_at, confirmed_by, receipt_no, enrollment_id,
    voucher_note, staff_note, refunded_at, refunded_by, created_at, updated_at)
SELECT id, reference, user_id, course_id, 'course', list_price, amount, voucher_id, voucher_code, status, expires_at,
    CASE WHEN receipt_no IS NOT NULL THEN COALESCE(paid_at, updated_at) END, slip_r2_key, slip_content_type, slip_uploaded_at,
    amount_received, paid_at, confirmed_by, receipt_no, enrollment_id, voucher_note, staff_note, refunded_at, refunded_by, created_at, updated_at
FROM course_orders;
DROP TABLE course_orders;
ALTER TABLE course_orders_v2 RENAME TO course_orders;
CREATE UNIQUE INDEX IF NOT EXISTS idx_course_orders_open ON course_orders (user_id, course_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_course_orders_open_product ON course_orders (user_id, product_id) WHERE status = 'pending' AND product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_course_orders_status ON course_orders (status, created_at);
CREATE INDEX IF NOT EXISTS idx_course_orders_user ON course_orders (user_id);
CREATE INDEX IF NOT EXISTS idx_course_orders_paid ON course_orders (paid_at);

-- Courses an order opened (bundle, membership, course); refunds and overdue installments suspend these.
CREATE TABLE IF NOT EXISTS order_items (
    order_id TEXT NOT NULL REFERENCES course_orders(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    PRIMARY KEY (order_id, course_id)
);
CREATE INDEX IF NOT EXISTS idx_order_items_course ON order_items (course_id);
INSERT OR IGNORE INTO order_items (order_id, course_id)
SELECT id, course_id FROM course_orders WHERE course_id IS NOT NULL AND receipt_no IS NOT NULL;

-- Installment plan of an order (2–6 payments, each confirmed by staff with its own receipt).
CREATE TABLE IF NOT EXISTS order_installments (
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
CREATE INDEX IF NOT EXISTS idx_order_installments_due ON order_installments (status, due_at);

-- Membership periods per learner and product; enrollments of covered courses carry the same expires_at.
CREATE TABLE IF NOT EXISTS memberships (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'expired', 'cancelled')),
    last_order_id TEXT,
    reminder_sent_for TEXT,                               -- expires_at value the 7-day reminder was sent for
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_expiry ON memberships (status, expires_at);

-- Learning path completion certificates (products with is_path = 1 and path_certificate = 1).
CREATE TABLE IF NOT EXISTS path_certificates (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    certificate_code TEXT UNIQUE NOT NULL,
    issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (product_id, user_id)
);
