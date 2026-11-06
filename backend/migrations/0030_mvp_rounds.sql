-- MVP rounds: instructors own rounds, rounds may run on non-consecutive days, and a registration
-- carries the payment details staff used to keep in the old Google Sheet. Handlers: src/handlers/site.ts.

-- The instructor account behind a round; instructor_name stays as the public label.
ALTER TABLE training_sessions ADD COLUMN instructor_id TEXT REFERENCES users(id) ON DELETE SET NULL;
-- JSON array of YYYY-MM-DD class days. NULL = every day from start_date to end_date.
ALTER TABLE training_sessions ADD COLUMN session_dates TEXT;

-- Transfer slip sent with the public form; private R2 key under slips/registrations/.
ALTER TABLE session_registrations ADD COLUMN slip_r2_key TEXT;
ALTER TABLE session_registrations ADD COLUMN slip_content_type TEXT;
ALTER TABLE session_registrations ADD COLUMN slip_uploaded_at TEXT;
-- Payment record kept by staff. Amounts are per registration, in satang, and may differ between people.
ALTER TABLE session_registrations ADD COLUMN buyer_type TEXT CHECK(buyer_type IS NULL OR buyer_type IN ('individual', 'company'));
ALTER TABLE session_registrations ADD COLUMN sales_stage TEXT CHECK(sales_stage IS NULL OR sales_stage IN ('quote_sent', 'po_received'));
ALTER TABLE session_registrations ADD COLUMN paid_amount_satang INTEGER CHECK(paid_amount_satang IS NULL OR paid_amount_satang >= 0);
ALTER TABLE session_registrations ADD COLUMN paid_on TEXT;       -- YYYY-MM-DD
ALTER TABLE session_registrations ADD COLUMN paid_account TEXT;  -- Receiving account, as staff name it
ALTER TABLE session_registrations ADD COLUMN receipt_nos TEXT;   -- One receipt may cover several people, and one person several receipts

CREATE INDEX IF NOT EXISTS idx_training_sessions_instructor ON training_sessions(instructor_id);
