-- Agent platform, phases 2–4: MCP access per agent key and auto-approval rules.
-- See docs/AGENT-PLATFORM.md.

-- What the key may do over MCP (/mcp): off, read tools only, or read + draft/act tools (still queued).
ALTER TABLE api_keys ADD COLUMN mcp_access TEXT NOT NULL DEFAULT 'read' CHECK(mcp_access IN ('off', 'read', 'write'));

-- Auto-approval rules: an act tool request from this key that meets the conditions runs at once,
-- as the person who created the rule (their permissions still apply), up to max_per_day a day.
CREATE TABLE IF NOT EXISTS agent_autonomy_rules (
    id TEXT PRIMARY KEY,
    api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    tool TEXT NOT NULL,
    conditions_json TEXT NOT NULL DEFAULT '{}',
    max_per_day INTEGER NOT NULL DEFAULT 20 CHECK(max_per_day BETWEEN 1 AND 1000),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    note TEXT,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_autonomy_rules_key ON agent_autonomy_rules (api_key_id, tool);

-- Which rule approved an action (NULL = a person decided).
ALTER TABLE agent_actions ADD COLUMN auto_rule_id TEXT;
