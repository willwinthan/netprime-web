-- Apply to existing databases before deploying payment verification.
ALTER TABLE payments ADD COLUMN provider_charge_id TEXT;
ALTER TABLE payments ADD COLUMN currency TEXT NOT NULL DEFAULT 'THB';
CREATE UNIQUE INDEX payments_provider_charge_unique ON payments(provider_charge_id) WHERE provider_charge_id IS NOT NULL;
