-- Marketing (v0.5): affiliates/referrals, first-touch signup attribution (UTM), lead forms and popups,
-- course reviews, voucher campaigns. Tracking ids live in site_settings (key 'marketing_tracking').
-- See handlers/marketing.ts.

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
