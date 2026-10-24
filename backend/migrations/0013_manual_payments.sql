-- Manual bank-transfer payments replace card checkout (no Omise for now).
-- A learner creates an order, transfers money and uploads a slip; staff with payments.manage confirm it.
-- The old `payments` table stays for history; new purchases live in `course_orders`.
CREATE TABLE IF NOT EXISTS course_orders (
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
    voucher_note TEXT,                          -- e.g. voucher ran out before confirmation
    staff_note TEXT,                            -- reject / refund reason shown to the learner
    refunded_at TEXT,
    refunded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- One open order per learner and course.
CREATE UNIQUE INDEX IF NOT EXISTS idx_course_orders_open ON course_orders (user_id, course_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_course_orders_status ON course_orders (status, created_at);
CREATE INDEX IF NOT EXISTS idx_course_orders_user ON course_orders (user_id);

-- Sequential numbers (order references and receipts) per year.
CREATE TABLE IF NOT EXISTS order_counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
);

-- Bank-transfer instructions edited by payments.manage holders.
CREATE TABLE IF NOT EXISTS payment_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO payment_settings (key, value) VALUES
('bank_transfer', '{"bank_name":"","account_name":"","account_number":"","promptpay_id":"","note":""}');

-- Certificate revocation; a reissue creates a new code and revokes the old one.
ALTER TABLE certificates ADD COLUMN revoked_at TEXT;
ALTER TABLE certificates ADD COLUMN revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE certificates ADD COLUMN revoke_reason TEXT;
ALTER TABLE certificates ADD COLUMN reissued_from TEXT;
