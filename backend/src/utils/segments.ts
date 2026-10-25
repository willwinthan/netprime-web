import { isRole, Role } from "./permissions";

/**
 * Audience segments: a set of rules evaluated against users. Every rule that is set must match
 * (AND); list rules match when the user matches ANY listed value (except `tags_all`).
 * Saved segments live in table `segments` (rules_json); broadcasts, reports and imports reuse them.
 *
 * Dates accept YYYY-MM-DD or a full ISO timestamp and are compared in UTC.
 * "Last active" is the newest of users.last_login_at and the user's latest user_events row;
 * accounts that were never active match `last_active_before` (they are inactive) but not `last_active_after`.
 */
export interface SegmentRules {
  /** Holds any of these roles. */
  roles?: Role[];
  /** Has any of these tags. */
  tags?: string[];
  /** Has every one of these tags. */
  tags_all?: string[];
  /** Has none of these tags. */
  exclude_tags?: string[];
  /** Belongs to any of these organizations (partners.id). */
  partner_ids?: string[];
  /** Enrolled (any status) in any of these courses. */
  enrolled_course_ids?: string[];
  /** Completed any of these courses (enrollment status completed or completed_at set). */
  completed_course_ids?: string[];
  signed_up_after?: string;
  signed_up_before?: string;
  last_active_after?: string;
  last_active_before?: string;
  /** true: has at least one paid order/completed payment; false: has none. */
  has_paid_order?: boolean;
  /** Account status filter; default "active" so broadcasts skip suspended accounts. */
  status?: "active" | "suspended" | "any";
}

const LIST_KEYS = ["tags", "tags_all", "exclude_tags", "partner_ids", "enrolled_course_ids", "completed_course_ids"] as const;
const DATE_KEYS = ["signed_up_after", "signed_up_before", "last_active_after", "last_active_before"] as const;
const MAX_LIST = 200;

export const normalizeTag = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const tag = value.trim().replace(/\s+/g, " ").toLowerCase();
  // Commas and pipes separate tags in lists and CSV cells.
  return tag && tag.length <= 50 && !/[,|]/.test(tag) ? tag : null;
};

/** "2026-01-31" or ISO → "2026-01-31 00:00:00" (SQLite datetime() format, UTC); null when invalid. */
export function toSqlDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + "T00:00:00Z" : v);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** Validates untrusted input; returns cleaned rules or a Thai error message. */
export function parseSegmentRules(raw: unknown): SegmentRules | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "เงื่อนไขกลุ่มไม่ถูกต้อง";
  const input = raw as Record<string, unknown>;
  const rules: SegmentRules = {};
  if (input.roles !== undefined) {
    if (!Array.isArray(input.roles) || !input.roles.every(isRole)) return "บทบาทในเงื่อนไขไม่ถูกต้อง";
    if (input.roles.length) rules.roles = Array.from(new Set(input.roles as Role[]));
  }
  for (const key of LIST_KEYS) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value) || value.length > MAX_LIST) return `เงื่อนไข ${key} ไม่ถูกต้อง`;
    const isTag = key === "tags" || key === "tags_all" || key === "exclude_tags";
    const cleaned = value.map(v => isTag ? normalizeTag(v) : (typeof v === "string" && v.trim() && v.length <= 100 ? v.trim() : null));
    if (cleaned.some(v => v === null)) return `เงื่อนไข ${key} ไม่ถูกต้อง`;
    if (cleaned.length) rules[key] = Array.from(new Set(cleaned as string[]));
  }
  for (const key of DATE_KEYS) {
    const value = input[key];
    if (value === undefined || value === null || value === "") continue;
    if (!toSqlDate(value)) return "วันที่ในเงื่อนไขไม่ถูกต้อง";
    rules[key] = String(value).trim();
  }
  if (input.has_paid_order !== undefined && input.has_paid_order !== null) {
    if (typeof input.has_paid_order !== "boolean") return "เงื่อนไขคำสั่งซื้อไม่ถูกต้อง";
    rules.has_paid_order = input.has_paid_order;
  }
  if (input.status !== undefined && input.status !== null) {
    if (input.status !== "active" && input.status !== "suspended" && input.status !== "any") return "สถานะในเงื่อนไขไม่ถูกต้อง";
    rules.status = input.status;
  }
  return rules;
}

const LAST_ACTIVE = `MAX(COALESCE(datetime(u.last_login_at), ''),
  COALESCE((SELECT datetime(MAX(e.created_at)) FROM user_events e WHERE e.user_id = u.id), ''))`;
const PAID = `(EXISTS (SELECT 1 FROM course_orders o WHERE o.user_id = u.id AND o.status = 'paid')
  OR EXISTS (SELECT 1 FROM payments pay WHERE pay.user_id = u.id AND pay.status = 'completed'))`;

/** Builds the WHERE clause (alias `u` = users). Lists are bound as one JSON parameter to stay under D1's bind limit. */
export function segmentWhere(rules: SegmentRules): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const list = (values: readonly string[]) => { params.push(JSON.stringify(values)); return "(SELECT value FROM json_each(?))"; };
  const status = rules.status ?? "active";
  if (status !== "any") { parts.push("u.status = ?"); params.push(status); }
  if (rules.roles?.length) parts.push(`EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role IN ${list(rules.roles)})`);
  if (rules.tags?.length) parts.push(`EXISTS (SELECT 1 FROM user_tags t WHERE t.user_id = u.id AND t.tag IN ${list(rules.tags)})`);
  if (rules.tags_all?.length) {
    parts.push(`(SELECT COUNT(*) FROM user_tags t WHERE t.user_id = u.id AND t.tag IN ${list(rules.tags_all)}) = ?`);
    params.push(rules.tags_all.length);
  }
  if (rules.exclude_tags?.length) parts.push(`NOT EXISTS (SELECT 1 FROM user_tags t WHERE t.user_id = u.id AND t.tag IN ${list(rules.exclude_tags)})`);
  if (rules.partner_ids?.length) parts.push(`u.partner_id IN ${list(rules.partner_ids)}`);
  if (rules.enrolled_course_ids?.length) parts.push(`EXISTS (SELECT 1 FROM enrollments en WHERE en.user_id = u.id AND en.course_id IN ${list(rules.enrolled_course_ids)})`);
  if (rules.completed_course_ids?.length) {
    parts.push(`EXISTS (SELECT 1 FROM enrollments en WHERE en.user_id = u.id AND en.course_id IN ${list(rules.completed_course_ids)}
      AND (en.status = 'completed' OR en.completed_at IS NOT NULL))`);
  }
  const date = (key: typeof DATE_KEYS[number]) => { params.push(toSqlDate(rules[key])); return "?"; };
  if (rules.signed_up_after) parts.push(`datetime(u.created_at) >= ${date("signed_up_after")}`);
  if (rules.signed_up_before) parts.push(`datetime(u.created_at) < ${date("signed_up_before")}`);
  if (rules.last_active_after) parts.push(`${LAST_ACTIVE} >= ${date("last_active_after")}`);
  if (rules.last_active_before) parts.push(`${LAST_ACTIVE} < ${date("last_active_before")}`);
  if (rules.has_paid_order === true) parts.push(PAID);
  if (rules.has_paid_order === false) parts.push(`NOT ${PAID}`);
  return { sql: parts.length ? parts.join(" AND ") : "1 = 1", params };
}

async function rulesOf(db: D1Database, rulesOrSegmentId: SegmentRules | string): Promise<SegmentRules | null> {
  if (typeof rulesOrSegmentId !== "string") return rulesOrSegmentId;
  const row = await db.prepare("SELECT rules_json FROM segments WHERE id = ?").bind(rulesOrSegmentId).first<{ rules_json: string }>();
  if (!row) return null;
  try {
    const parsed = parseSegmentRules(JSON.parse(row.rules_json));
    return typeof parsed === "string" ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * User ids matching the rules (or a saved segment id), ordered by sign-up time.
 * An unknown segment id or unreadable stored rules resolve to an empty list.
 */
export async function resolveSegmentUserIds(db: D1Database, rules: SegmentRules | string): Promise<string[]> {
  const resolved = await rulesOf(db, rules);
  if (!resolved) return [];
  const where = segmentWhere(resolved);
  const rows = await db.prepare(`SELECT u.id FROM users u WHERE ${where.sql} ORDER BY u.created_at, u.id`).bind(...where.params).all<{ id: string }>();
  return rows.results.map(r => r.id);
}

export async function countSegment(db: D1Database, rules: SegmentRules): Promise<number> {
  const where = segmentWhere(rules);
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${where.sql}`).bind(...where.params).first<{ n: number }>();
  return row?.n ?? 0;
}
