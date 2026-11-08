-- Agent-ready platform, phase 1: agent keys, an approval queue for "act" tools and an activity log.
-- Agents are external (Claude, a self-hosted model on the office DGX Spark, ...); the school only
-- issues them keys. See docs/AGENT-PLATFORM.md.

-- Agent keys are api_keys rows with kind = 'agent'. They also get a daily quota, an allowed time
-- window (Asia/Bangkok), an optional IP allowlist and a reversible pause (revoke stays permanent).
ALTER TABLE api_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'integration' CHECK(kind IN ('integration', 'agent'));
ALTER TABLE api_keys ADD COLUMN description TEXT;
ALTER TABLE api_keys ADD COLUMN daily_limit INTEGER CHECK(daily_limit IS NULL OR daily_limit BETWEEN 1 AND 1000000);
ALTER TABLE api_keys ADD COLUMN allowed_hours TEXT;  -- "HH:MM-HH:MM" Asia/Bangkok; NULL = any time
ALTER TABLE api_keys ADD COLUMN allowed_days TEXT;   -- ISO weekdays "1,2,3,4,5" (1 = Monday); NULL = every day
ALTER TABLE api_keys ADD COLUMN allowed_ips TEXT;    -- comma-separated IPs or IPv4 CIDRs; NULL = anywhere
ALTER TABLE api_keys ADD COLUMN paused_at TEXT;

-- Audit entries written on behalf of an agent name its key (user_id is the approver, or NULL).
ALTER TABLE admin_audit_log ADD COLUMN api_key_id TEXT;

-- Work an agent asked for. "act" tools wait here for a person to approve; "draft" tools run at once
-- and are recorded here too, so idempotency keys and the history cover both.
CREATE TABLE IF NOT EXISTS agent_actions (
    id TEXT PRIMARY KEY,
    api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    tool TEXT NOT NULL,
    tier TEXT NOT NULL CHECK(tier IN ('draft', 'act')),
    input_json TEXT NOT NULL,
    input_hash TEXT NOT NULL,           -- SHA-256 of tool + input, compared on idempotent replays
    idempotency_key TEXT,
    summary TEXT NOT NULL,              -- what will happen, in Thai, for the approver
    preview_json TEXT,                  -- target state when the action was submitted
    reason TEXT,                        -- why the agent wants this (shown to the approver)
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'executing', 'executed', 'failed', 'rejected', 'cancelled', 'expired')),
    result_json TEXT,
    error TEXT,
    decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    decided_at TEXT,
    decision_note TEXT,
    executed_at TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_actions_idempotency ON agent_actions (api_key_id, idempotency_key); -- NULL keys never collide
CREATE INDEX IF NOT EXISTS idx_agent_actions_status ON agent_actions (status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_actions_key ON agent_actions (api_key_id, created_at);

-- Every request an agent key makes (kept 90 days by the daily job).
CREATE TABLE IF NOT EXISTS agent_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER NOT NULL,
    ip TEXT,
    action_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_activity_key ON agent_activity (api_key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_activity_created ON agent_activity (created_at);
