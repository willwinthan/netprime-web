-- Security / correctness fixes (October 2026).
-- Orders freeze what they buy when created, so editing a product later never changes what a confirmation
-- opens or what a refund takes back (handlers/orders.ts grantSnapshot / loadGrants).
ALTER TABLE course_orders ADD COLUMN grant_snapshot_json TEXT;  -- {v, course_ids, all_courses, access_days, membership_days, installment_access, grace_days}
ALTER TABLE course_orders ADD COLUMN granted_days INTEGER;      -- membership days this order actually added on confirmation
