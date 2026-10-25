import { Hono, Context } from "hono";
import { Env, rbac, UserPayload } from "../middleware/rbac";
import { currentPermissions } from "../utils/permissions";
import { parseSegmentRules, resolveSegmentUserIds, SegmentRules } from "../utils/segments";
import { renderMarkdown, markdownToText, sanitizeHtml, isSafeUrl } from "../utils/richtext";
import {
  EMAIL_TEMPLATES, EmailTemplateKey, isEmailTemplateKey, renderTemplate, renderTemplateText, sendEmailBatch, escapeHtml, appUrl, BatchEmail
} from "../utils/email";
import {
  CommBindings, createNotification, getPreferences, preferencesFor, savePreferences, pushToUser, lineToUser, NotificationPreferences
} from "./notifications";
import { vapidFromEnv, isAllowedPushEndpoint, validSubscriptionKeys, b64urlEncode } from "../utils/webpush";
import { verifyLineSignature, lineReplyText, lineConfigured } from "../utils/line";
import { rateLimited, tooManyRequests } from "../utils/ratelimit";

/**
 * Communication (mounted at /api):
 * - Broadcasts to segments over email / in-app / web push / LINE, scheduled or immediate, sent in chunks of 100.
 * - Course announcements, editable email templates, notification preferences and signed unsubscribe links.
 * - Web push subscriptions and LINE account linking (webhook).
 */
export const communicationRouter = new Hono<Env>();

// ---------- Shared helpers (also used by handlers/community.ts) ----------

export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
export const nowIso = () => new Date().toISOString();
export const isStaff = (user: UserPayload) => user.roles.some(r => r === "admin" || r === "coordinator");
export const commEnv = (c: Context<Env>) => c.env as CommBindings;

/** Runs work after the response (ctx.waitUntil); errors are logged only. */
export function runLater(c: Context<Env>, task: Promise<unknown>, label: string) {
  const guarded = task.catch(error => console.error(`${label} failed:`, error));
  try { c.executionCtx.waitUntil(guarded); } catch { /* No execution context: fire and forget. */ }
}

export async function courseOwner(db: D1Database, courseId: string): Promise<{ id: string; title: string; instructor_id: string } | null> {
  return db.prepare("SELECT id, title, instructor_id FROM courses WHERE id = ?").bind(courseId).first();
}

export async function getSetting(db: D1Database, key: string, fallback: string): Promise<string> {
  try {
    const row = await db.prepare("SELECT value FROM communication_settings WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

async function readJson(c: Context<Env>): Promise<Record<string, any>> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? body : {};
}

const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

// ---------- Unsubscribe links (HMAC with JWT_SECRET, domain separated) ----------

export type UnsubscribeCategory = "marketing" | "course";

async function unsubscribeSignature(secret: string, userId: string, category: UnsubscribeCategory): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`unsubscribe:v1:${userId}:${category}`));
  return b64urlEncode(new Uint8Array(sig).slice(0, 18));
}

export async function unsubscribeToken(secret: string, userId: string, category: UnsubscribeCategory): Promise<string> {
  return `${userId}.${category}.${await unsubscribeSignature(secret, userId, category)}`;
}

export async function verifyUnsubscribeToken(secret: string, token: string): Promise<{ userId: string; category: UnsubscribeCategory } | null> {
  const parts = token.split(".");
  if (parts.length < 3 || token.length > 300) return null;
  const sig = parts.pop()!;
  const category = parts.pop()!;
  const userId = parts.join(".");
  if (category !== "marketing" && category !== "course") return null;
  const expected = await unsubscribeSignature(secret, userId, category);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? { userId, category } : null;
}

export async function unsubscribeUrl(env: Env["Bindings"], origin: string, userId: string, category: UnsubscribeCategory): Promise<string> {
  return `${origin.replace(/\/+$/, "")}/api/communication/unsubscribe?token=${encodeURIComponent(await unsubscribeToken(env.JWT_SECRET, userId, category))}`;
}

const apiOrigin = (c: Context<Env>) => new URL(c.req.url).origin;

/** Builds personal emails with List-Unsubscribe headers for one category (course updates / marketing). */
async function categoryEmails(
  env: Env["Bindings"], origin: string, category: UnsubscribeCategory | null,
  users: Array<{ id: string; name: string; email: string }>,
  build: (user: { id: string; name: string; email: string }, unsubscribe: string | null) => { subject: string; html: string }
): Promise<BatchEmail[]> {
  const out: BatchEmail[] = [];
  for (const user of users) {
    const unsubscribe = category ? await unsubscribeUrl(env, origin, user.id, category) : null;
    const { subject, html } = build(user, unsubscribe);
    out.push({
      to: user.email, subject, html,
      headers: unsubscribe ? { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined
    });
  }
  return out;
}

function defaultBroadcastHtml(vars: { name: string; email: string; title: string; content: string; link?: string | null; unsubscribe_link?: string | null }): string {
  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eaeaea; padding: 20px; border-radius: 10px;">
      <h2 style="color: #6366f1;">${escapeHtml(vars.title)}</h2>
      <p>สวัสดีคุณ ${escapeHtml(vars.name)}</p>
      <div style="line-height: 1.6;">${vars.content}</div>
      ${vars.link ? `<div style="margin: 20px 0; text-align: center;"><a href="${escapeHtml(vars.link)}" style="background-color: #6366f1; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">ดูรายละเอียด</a></div>` : ""}
      <p style="color: #666; font-size: 12px; border-top: 1px solid #eaeaea; padding-top: 10px; margin-top: 20px;">
        ส่งถึง: ${escapeHtml(vars.email)} • Netprime Learning Inc.
        ${vars.unsubscribe_link ? `<br><a href="${escapeHtml(vars.unsubscribe_link)}" style="color:#666">ยกเลิกการรับอีเมลลักษณะนี้</a>` : ""}
      </p>
    </div>`;
}

/** Loads the "broadcast" layout override once; returns a renderer for many recipients. */
async function broadcastRenderer(db: D1Database) {
  const override = await db.prepare("SELECT subject, body_html FROM email_templates WHERE key = 'broadcast'").first<{ subject: string; body_html: string }>()
    .catch(() => null);
  return (vars: { name: string; email: string; title: string; subject: string; content: string; link?: string | null; unsubscribe_link?: string | null }) => {
    if (!override) return { subject: vars.subject, html: defaultBroadcastHtml(vars) };
    const rendered = renderTemplateText(override.subject, override.body_html, { ...vars, link: vars.link ?? "", unsubscribe_link: vars.unsubscribe_link ?? "" }, "broadcast");
    // The override subject defaults to {{title}}; keep the broadcast's own subject when it is that.
    return { subject: /^\s*\{\{\s*title\s*\}\}\s*$/.test(override.subject) ? vars.subject : rendered.subject, html: rendered.html };
  };
}

// ---------- Broadcasts ----------

const CHANNELS = ["email", "in_app", "push", "line"] as const;
type Channel = typeof CHANNELS[number];
type Category = "marketing" | "course" | "system";
const BATCH_SIZE = 100;

interface BroadcastRow {
  id: string; title: string; subject: string; body_markdown: string; body_html: string; category: Category;
  channels_json: string; audience_json: string; course_id: string | null; link: string | null; status: string;
  scheduled_at: string | null; api_origin: string | null; recipient_count: number; created_by: string | null;
  created_at: string; updated_at: string; started_at: string | null; sent_at: string | null;
}
interface Audience { segment_id?: string; rules?: SegmentRules }

async function broadcastAccess(c: Context<Env>): Promise<"manage" | "instructor" | null> {
  if ((await currentPermissions(c)).has("communication.manage")) return "manage";
  return c.get("user").roles.includes("instructor") ? "instructor" : null;
}

async function loadBroadcast(c: Context<Env>, access: "manage" | "instructor"): Promise<BroadcastRow | null> {
  const row = await c.env.DB.prepare("SELECT * FROM broadcasts WHERE id = ?").bind(c.req.param("id")).first<BroadcastRow>();
  if (!row) return null;
  if (access === "instructor" && row.created_by !== c.get("user").id) return null;
  return row;
}

async function resolveAudience(db: D1Database, audience: Audience): Promise<string[]> {
  if (audience.segment_id) return resolveSegmentUserIds(db, audience.segment_id);
  return resolveSegmentUserIds(db, audience.rules ?? {});
}

/** Validates a broadcast body; instructors are limited to the learners of a course they own. */
async function parseBroadcast(c: Context<Env>, body: Record<string, any>, access: "manage" | "instructor") {
  const title = text(body.title, 200);
  const markdown = typeof body.body === "string" ? body.body.slice(0, 20000) : "";
  if (!title) return "กรุณากรอกหัวข้อ";
  if (!markdown.trim()) return "กรุณากรอกเนื้อหา";
  const subject = text(body.subject, 200) || title;
  const channels = Array.isArray(body.channels) ? Array.from(new Set(body.channels.filter((ch: unknown) => CHANNELS.includes(ch as Channel)))) as Channel[] : [];
  if (!channels.length) return "กรุณาเลือกช่องทางอย่างน้อย 1 ช่องทาง";
  const link = text(body.link, 500) || null;
  if (link && !isSafeUrl(link)) return "ลิงก์ต้องขึ้นต้นด้วย https:// หรือ /";
  let category: Category = ["marketing", "course", "system"].includes(body.category) ? body.category : "marketing";
  let courseId: string | null = text(body.course_id, 100) || null;
  let audience: Audience;
  if (access === "instructor") {
    if (!courseId) return "กรุณาเลือกคอร์สของคุณ";
    const course = await courseOwner(c.env.DB, courseId);
    if (!course || course.instructor_id !== c.get("user").id) return "ส่งได้เฉพาะผู้เรียนในคอร์สของคุณ";
    category = "course";
    audience = { rules: { enrolled_course_ids: [courseId] } };
  } else {
    if (courseId && !(await courseOwner(c.env.DB, courseId))) return "ไม่พบคอร์ส";
    const raw = body.audience && typeof body.audience === "object" ? body.audience : {};
    if (typeof raw.segment_id === "string" && raw.segment_id) {
      const exists = await c.env.DB.prepare("SELECT id FROM segments WHERE id = ?").bind(raw.segment_id).first().catch(() => null);
      if (!exists) return "ไม่พบกลุ่มเป้าหมายที่บันทึกไว้";
      audience = { segment_id: raw.segment_id };
    } else {
      const rules = parseSegmentRules(raw.rules ?? {});
      if (typeof rules === "string") return rules;
      audience = { rules };
    }
  }
  return { title, subject, markdown, html: renderMarkdown(markdown), channels, link, category, courseId, audience };
}

type Counts = { total: number; by_status: Record<string, number>; by_channel: Record<string, Record<string, number>> };
async function deliveryCounts(db: D1Database, ids: string[]): Promise<Map<string, Counts>> {
  const map = new Map<string, Counts>();
  for (const id of ids) map.set(id, { total: 0, by_status: { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 }, by_channel: {} });
  if (!ids.length) return map;
  const rows = await db.prepare(`SELECT broadcast_id, channel, status, COUNT(*) AS n FROM broadcast_recipients
    WHERE broadcast_id IN (SELECT value FROM json_each(?)) GROUP BY broadcast_id, channel, status`).bind(JSON.stringify(ids))
    .all<{ broadcast_id: string; channel: string; status: string; n: number }>();
  for (const r of rows.results) {
    const counts = map.get(r.broadcast_id)!;
    counts.total += r.n;
    counts.by_status[r.status] = (counts.by_status[r.status] ?? 0) + r.n;
    counts.by_channel[r.channel] ??= { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    counts.by_channel[r.channel][r.status] += r.n;
  }
  return map;
}

function present(row: BroadcastRow, counts?: Counts) {
  const { channels_json, audience_json, body_html, ...rest } = row;
  return { ...rest, body: row.body_markdown, body_html, channels: JSON.parse(channels_json), audience: JSON.parse(audience_json), delivery: counts ?? null };
}

/** Moves a draft/scheduled broadcast to "sending" and creates its recipient rows. Returns the recipient count. */
export async function queueBroadcast(env: Env["Bindings"], id: string): Promise<number | null> {
  const db = env.DB;
  const claimed = await db.prepare("UPDATE broadcasts SET status = 'sending', started_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('draft', 'scheduled') RETURNING *")
    .bind(nowIso(), id).first<BroadcastRow>();
  if (!claimed) return null;
  try {
    const userIds = await resolveAudience(db, JSON.parse(claimed.audience_json));
    const channels = JSON.parse(claimed.channels_json) as Channel[];
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < userIds.length; i += 500) {
      const chunk = JSON.stringify(userIds.slice(i, i + 500));
      for (const channel of channels) {
        statements.push(db.prepare("INSERT OR IGNORE INTO broadcast_recipients (broadcast_id, user_id, channel) SELECT ?, value, ? FROM json_each(?)").bind(id, channel, chunk));
      }
    }
    if (statements.length) await db.batch(statements);
    await db.prepare(`UPDATE broadcasts SET recipient_count = ?, status = CASE WHEN ? = 0 THEN 'sent' ELSE status END,
      sent_at = CASE WHEN ? = 0 THEN CURRENT_TIMESTAMP ELSE sent_at END WHERE id = ?`).bind(userIds.length, userIds.length, userIds.length, id).run();
    return userIds.length;
  } catch (error) {
    console.error("Queue broadcast failed:", error);
    await db.prepare("UPDATE broadcasts SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
    return null;
  }
}

/**
 * Delivers up to `size` queued recipient rows of one broadcast. Returns how many rows were processed.
 *
 * At-most-once per (user, channel): each channel's status is written right after its send (per user for
 * push/LINE), and rows are marked detail='attempting' just before an external send. A run that dies
 * mid-batch leaves never-attempted rows as plain 'sending' (re-queued by the reclaim) and attempted rows
 * as 'attempting' (marked failed/interrupted by the reclaim, never re-sent).
 */
export async function processBroadcastBatch(env: CommBindings, id: string, size = BATCH_SIZE): Promise<number> {
  const db = env.DB;
  const b = await db.prepare("SELECT * FROM broadcasts WHERE id = ?").bind(id).first<BroadcastRow>();
  if (!b || b.status !== "sending") return 0;
  const claimed = await db.prepare(`UPDATE broadcast_recipients SET status = 'sending', detail = NULL, updated_at = ?
    WHERE rowid IN (SELECT rowid FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'queued' ORDER BY user_id, channel LIMIT ?)
    RETURNING user_id, channel`).bind(nowIso(), id, Math.max(1, Math.min(size, BATCH_SIZE))).all<{ user_id: string; channel: Channel }>();
  const rows = claimed.results;
  if (!rows.length) return 0;

  const userIds = Array.from(new Set(rows.map(r => r.user_id)));
  const users = new Map((await db.prepare("SELECT id, name, email FROM users WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(userIds)).all<{ id: string; name: string; email: string }>()).results.map(u => [u.id, u]));
  const prefs = await preferencesFor(db, userIds);
  type Result = { user_id: string; channel: Channel; status: "sent" | "failed" | "skipped"; detail: string | null };
  const byChannel = (channel: Channel) => rows.filter(r => r.channel === channel).map(r => r.user_id);
  const summary = markdownToText(b.body_markdown, 500);

  /** Grouped status updates (one statement per channel/status/detail). */
  const statusUpdates = (results: Result[]) => {
    const groups = new Map<string, { channel: Channel; status: string; detail: string | null; ids: string[] }>();
    for (const r of results) {
      const key = `${r.channel}|${r.status}|${r.detail ?? ""}`;
      if (!groups.has(key)) groups.set(key, { channel: r.channel, status: r.status, detail: r.detail, ids: [] });
      groups.get(key)!.ids.push(r.user_id);
    }
    return [...groups.values()].map(g => db.prepare(`UPDATE broadcast_recipients SET status = ?, detail = ?, updated_at = ?
      WHERE broadcast_id = ? AND channel = ? AND status = 'sending' AND user_id IN (SELECT value FROM json_each(?))`)
      .bind(g.status, g.detail, nowIso(), id, g.channel, JSON.stringify(g.ids)));
  };
  const record = async (results: Result[]) => { const updates = statusUpdates(results); if (updates.length) await db.batch(updates); };
  const markAttempting = (channel: Channel, ids: string[]) => db.prepare(`UPDATE broadcast_recipients SET detail = 'attempting', updated_at = ?
    WHERE broadcast_id = ? AND channel = ? AND status = 'sending' AND user_id IN (SELECT value FROM json_each(?))`)
    .bind(nowIso(), id, channel, JSON.stringify(ids)).run();

  // In-app: notifications and their status rows are written in one atomic batch.
  const inAppAll = byChannel("in_app");
  if (inAppAll.length) {
    const inApp = inAppAll.filter(uid => users.has(uid));
    const results: Result[] = inAppAll.map(uid => ({ user_id: uid, channel: "in_app", status: users.has(uid) ? "sent" : "skipped", detail: users.has(uid) ? null : "no_user" }));
    await db.batch([
      ...inApp.map(uid => db.prepare("INSERT INTO notifications (id, user_id, title, content, is_read, link, category) VALUES (?, ?, ?, ?, 0, ?, 'broadcast')")
        .bind(newId("ntf"), uid, b.title, summary, b.link)),
      ...statusUpdates(results)
    ]);
  }

  // Email (respects the marketing / course-update preference; system messages always go out)
  const emailIds = byChannel("email");
  if (emailIds.length) {
    const results: Result[] = [];
    const allowed: Array<{ id: string; name: string; email: string }> = [];
    for (const uid of emailIds) {
      const user = users.get(uid);
      const pref = prefs.get(uid)!;
      if (!user?.email) results.push({ user_id: uid, channel: "email", status: "skipped", detail: "no_email" });
      else if ((b.category === "marketing" && !pref.email_marketing) || (b.category === "course" && !pref.email_course)) {
        results.push({ user_id: uid, channel: "email", status: "skipped", detail: "unsubscribed" });
      } else allowed.push(user);
    }
    await record(results);
    if (allowed.length) {
      const render = await broadcastRenderer(db);
      const origin = b.api_origin || appUrl(env, "");
      const category: UnsubscribeCategory | null = b.category === "system" ? null : b.category;
      const link = b.link ? (b.link.startsWith("/") ? appUrl(env, b.link) : b.link) : null;
      const messages = await categoryEmails(env, origin, category, allowed, (user, unsubscribe) =>
        render({ name: user.name, email: user.email, title: b.title, subject: b.subject, content: b.body_html, link, unsubscribe_link: unsubscribe }));
      await markAttempting("email", allowed.map(u => u.id));
      const sent = await sendEmailBatch(messages, env.RESEND_API_KEY);
      await record(allowed.map(user => ({ user_id: user.id, channel: "email", status: sent.failed ? "failed" : "sent", detail: sent.failed ? "provider_error" : null })));
    }
  }

  // Web push (status recorded per user right after each send)
  const pushIds = byChannel("push");
  if (pushIds.length) {
    const configured = !!vapidFromEnv(env);
    const subCounts = new Map((await db.prepare("SELECT user_id, COUNT(*) AS n FROM push_subscriptions WHERE user_id IN (SELECT value FROM json_each(?)) GROUP BY user_id")
      .bind(JSON.stringify(pushIds)).all<{ user_id: string; n: number }>()).results.map(r => [r.user_id, r.n]));
    const skipped: Result[] = [];
    const deliver: string[] = [];
    for (const uid of pushIds) {
      if (!configured) skipped.push({ user_id: uid, channel: "push", status: "skipped", detail: "not_configured" });
      else if (!prefs.get(uid)!.push) skipped.push({ user_id: uid, channel: "push", status: "skipped", detail: "unsubscribed" });
      else if (!subCounts.get(uid)) skipped.push({ user_id: uid, channel: "push", status: "skipped", detail: "no_subscription" });
      else deliver.push(uid);
    }
    await record(skipped);
    for (const uid of deliver) {
      await markAttempting("push", [uid]);
      const delivered = await pushToUser(env, uid, { title: b.title, body: summary.slice(0, 200), url: b.link ?? "/dashboard", tag: b.id });
      await record([{ user_id: uid, channel: "push", status: delivered ? "sent" : "failed", detail: delivered ? null : "push_error" }]);
    }
  }

  // LINE (status recorded per user right after each send)
  const lineIds = byChannel("line");
  if (lineIds.length) {
    const configured = lineConfigured(env);
    const linked = new Set((await db.prepare("SELECT user_id FROM line_links WHERE user_id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(lineIds)).all<{ user_id: string }>()).results.map(r => r.user_id));
    const skipped: Result[] = [];
    const deliver: string[] = [];
    for (const uid of lineIds) {
      if (!configured) skipped.push({ user_id: uid, channel: "line", status: "skipped", detail: "not_configured" });
      else if (!prefs.get(uid)!.line) skipped.push({ user_id: uid, channel: "line", status: "skipped", detail: "unsubscribed" });
      else if (!linked.has(uid)) skipped.push({ user_id: uid, channel: "line", status: "skipped", detail: "not_linked" });
      else deliver.push(uid);
    }
    await record(skipped);
    const lineText = `${b.title}\n\n${summary}${b.link ? `\n${b.link.startsWith("/") ? appUrl(env, b.link) : b.link}` : ""}`;
    for (const uid of deliver) {
      await markAttempting("line", [uid]);
      const ok = await lineToUser(env, uid, lineText);
      await record([{ user_id: uid, channel: "line", status: ok ? "sent" : "failed", detail: ok ? null : "line_error" }]);
    }
  }
  return rows.length;
}

/**
 * Rows claimed by a run that died (e.g. the Worker was evicted) are reclaimed after 15 minutes:
 * never-attempted rows go back to the queue; rows whose external send had started are marked
 * failed ("interrupted") instead of being sent a second time.
 */
export async function reclaimStaleBroadcastRows(db: D1Database, olderThanMs = 15 * 60 * 1000) {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  await db.batch([
    db.prepare("UPDATE broadcast_recipients SET status = 'failed', detail = 'interrupted', updated_at = ? WHERE status = 'sending' AND detail = 'attempting' AND updated_at < ?")
      .bind(nowIso(), cutoff),
    db.prepare("UPDATE broadcast_recipients SET status = 'queued', detail = NULL WHERE status = 'sending' AND detail IS NULL AND updated_at < ?").bind(cutoff)
  ]);
}

async function finalizeBroadcast(db: D1Database, id: string): Promise<string> {
  const pending = await db.prepare("SELECT COUNT(*) AS n FROM broadcast_recipients WHERE broadcast_id = ? AND status IN ('queued', 'sending')").bind(id).first<{ n: number }>();
  if (!pending?.n) {
    await db.prepare("UPDATE broadcasts SET status = 'sent', sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'sending'").bind(id).run();
  }
  const row = await db.prepare("SELECT status FROM broadcasts WHERE id = ?").bind(id).first<{ status: string }>();
  return row?.status ?? "missing";
}

/**
 * Queues due scheduled broadcasts and delivers queued recipients in chunks of 100.
 * Called by the daily cron (jobs.ts), right after "send now" (waitUntil) and when staff open the history.
 */
export async function processBroadcastQueue(env: CommBindings, options: { broadcastId?: string; maxBatches?: number; batchSize?: number } = {}) {
  const db = env.DB;
  const maxBatches = options.maxBatches ?? 20;
  let queued = 0;
  if (!options.broadcastId) {
    const due = await db.prepare("SELECT id FROM broadcasts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 20").bind(nowIso()).all<{ id: string }>();
    for (const row of due.results) if ((await queueBroadcast(env, row.id)) !== null) queued++;
    await reclaimStaleBroadcastRows(db);
  }
  const active = options.broadcastId ? [options.broadcastId]
    : (await db.prepare("SELECT id FROM broadcasts WHERE status = 'sending' ORDER BY started_at LIMIT 20").all<{ id: string }>()).results.map(r => r.id);
  let batches = 0;
  let processed = 0;
  for (const id of active) {
    while (batches < maxBatches) {
      const n = await processBroadcastBatch(env, id, options.batchSize ?? BATCH_SIZE);
      if (!n) break;
      batches++;
      processed += n;
    }
    await finalizeBroadcast(db, id);
  }
  return { queued, processed, batches };
}

communicationRouter.get("/communication/meta", rbac(), async (c) => {
  const access = await broadcastAccess(c);
  const perms = await currentPermissions(c);
  const user = c.get("user");
  const env = commEnv(c);
  const courses = access === "manage"
    ? (await c.env.DB.prepare("SELECT id, title FROM courses ORDER BY title LIMIT 500").all()).results
    : access === "instructor"
      ? (await c.env.DB.prepare("SELECT id, title FROM courses WHERE instructor_id = ? ORDER BY title").bind(user.id).all()).results
      : [];
  const segments = access === "manage"
    ? (await c.env.DB.prepare("SELECT id, name FROM segments ORDER BY name LIMIT 200").all().catch(() => ({ results: [] }))).results
    : [];
  const partners = access === "manage" ? (await c.env.DB.prepare("SELECT id, company_name FROM partners ORDER BY company_name").all()).results : [];
  return c.json({
    access, can_manage: access === "manage", can_moderate: perms.has("community.moderate"),
    channels: { email: true, in_app: true, push: !!vapidFromEnv(env), line: lineConfigured(env) },
    courses, segments, partners,
    templates: perms.has("communication.manage") ? Object.keys(EMAIL_TEMPLATES) : []
  });
});

communicationRouter.post("/communication/audience/preview", rbac(), async (c) => {
  const access = await broadcastAccess(c);
  if (!access) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const body = await readJson(c);
  const parsed = await parseBroadcast(c, { title: "preview", body: "preview", channels: ["in_app"], ...body }, access);
  if (typeof parsed === "string") return c.json({ error: parsed }, 400);
  const ids = await resolveAudience(c.env.DB, parsed.audience);
  return c.json({ count: ids.length });
});

communicationRouter.get("/communication/broadcasts", rbac(), async (c) => {
  const access = await broadcastAccess(c);
  if (!access) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const db = c.env.DB;
  const rows = access === "manage"
    ? await db.prepare("SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 100").all<BroadcastRow>()
    : await db.prepare("SELECT * FROM broadcasts WHERE created_by = ? ORDER BY created_at DESC LIMIT 100").bind(c.get("user").id).all<BroadcastRow>();
  // Scheduled broadcasts that are due go out now instead of waiting for the daily cron.
  if (rows.results.some(r => (r.status === "scheduled" && r.scheduled_at && r.scheduled_at <= nowIso()) || r.status === "sending")) {
    runLater(c, processBroadcastQueue(commEnv(c), { maxBatches: 3 }), "Broadcast queue");
  }
  const counts = await deliveryCounts(db, rows.results.map(r => r.id));
  return c.json({ broadcasts: rows.results.map(r => present(r, counts.get(r.id))) });
});

communicationRouter.post("/communication/broadcasts", rbac(), async (c) => {
  const access = await broadcastAccess(c);
  if (!access) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const parsed = await parseBroadcast(c, await readJson(c), access);
  if (typeof parsed === "string") return c.json({ error: parsed }, 400);
  const id = newId("bc");
  await c.env.DB.prepare(`INSERT INTO broadcasts (id, title, subject, body_markdown, body_html, category, channels_json, audience_json, course_id, link, api_origin, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, parsed.title, parsed.subject, parsed.markdown, parsed.html, parsed.category,
    JSON.stringify(parsed.channels), JSON.stringify(parsed.audience), parsed.courseId, parsed.link, apiOrigin(c), c.get("user").id).run();
  const row = await c.env.DB.prepare("SELECT * FROM broadcasts WHERE id = ?").bind(id).first<BroadcastRow>();
  return c.json({ broadcast: present(row!) }, 201);
});

communicationRouter.get("/communication/broadcasts/:id", rbac(), async (c) => {
  const access = await broadcastAccess(c);
  if (!access) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const row = await loadBroadcast(c, access);
  if (!row) return c.json({ error: "ไม่พบประกาศ" }, 404);
  const counts = await deliveryCounts(c.env.DB, [row.id]);
  const failures = (await c.env.DB.prepare(`SELECT r.user_id, u.name, u.email, r.channel, r.status, r.detail FROM broadcast_recipients r
    LEFT JOIN users u ON u.id = r.user_id WHERE r.broadcast_id = ? AND r.status IN ('failed', 'skipped') ORDER BY r.updated_at DESC LIMIT 100`).bind(row.id).all()).results;
  return c.json({ broadcast: present(row, counts.get(row.id)), issues: failures });
});

communicationRouter.put("/communication/broadcasts/:id", rbac(), async (c) => {
  const access = await broadcastAccess(c);
  if (!access) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const row = await loadBroadcast(c, access);
  if (!row) return c.json({ error: "ไม่พบประกาศ" }, 404);
  if (row.status !== "draft" && row.status !== "scheduled") return c.json({ error: "แก้ไขได้เฉพาะฉบับร่างหรือที่ตั้งเวลาไว้" }, 409);
  const parsed = await parseBroadcast(c, await readJson(c), access);
  if (typeof parsed === "string") return c.json({ error: parsed }, 400);
  await c.env.DB.prepare(`UPDATE broadcasts SET title = ?, subject = ?, body_markdown = ?, body_html = ?, category = ?, channels_json = ?, audience_json = ?,
    course_id = ?, link = ?, api_origin = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('draft', 'scheduled')`)
    .bind(parsed.title, parsed.subject, parsed.markdown, parsed.html, parsed.category, JSON.stringify(parsed.channels), JSON.stringify(parsed.audience),
      parsed.courseId, parsed.link, apiOrigin(c), row.id).run();
  const fresh = await c.env.DB.prepare("SELECT * FROM broadcasts WHERE id = ?").bind(row.id).first<BroadcastRow>();
  return c.json({ broadcast: present(fresh!) });
});

/** Draft: deleted. Scheduled/sending: cancelled (recipients not yet sent are skipped). */
communicationRouter.delete("/communication/broadcasts/:id", rbac(), async (c) => {
  const access = await broadcastAccess(c);
  if (!access) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const row = await loadBroadcast(c, access);
  if (!row) return c.json({ error: "ไม่พบประกาศ" }, 404);
  const db = c.env.DB;
  if (row.status === "draft") {
    await db.prepare("DELETE FROM broadcasts WHERE id = ? AND status = 'draft'").bind(row.id).run();
    return c.json({ message: "ลบฉบับร่างแล้ว", deleted: true });
  }
  if (row.status === "scheduled" || row.status === "sending") {
    await db.batch([
      db.prepare("UPDATE broadcasts SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(row.id),
      db.prepare("UPDATE broadcast_recipients SET status = 'skipped', detail = 'cancelled', updated_at = ? WHERE broadcast_id = ? AND status = 'queued'").bind(nowIso(), row.id)
    ]);
    return c.json({ message: "ยกเลิกการส่งแล้ว", cancelled: true });
  }
  return c.json({ error: "ประกาศนี้ส่งไปแล้ว" }, 409);
});

/** Sends the broadcast only to the signed-in user (email + in-app, plus push/LINE when selected). */
communicationRouter.post("/communication/broadcasts/:id/test", rbac(), async (c) => {
  const access = await broadcastAccess(c);
  if (!access) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const row = await loadBroadcast(c, access);
  if (!row) return c.json({ error: "ไม่พบประกาศ" }, 404);
  const user = c.get("user");
  if (await rateLimited(c.env.SESSIONS, "broadcast-test", user.id, 20)) return tooManyRequests(c);
  const env = commEnv(c);
  const channels = JSON.parse(row.channels_json) as Channel[];
  const render = await broadcastRenderer(c.env.DB);
  const link = row.link ? (row.link.startsWith("/") ? appUrl(env, row.link) : row.link) : null;
  const category: UnsubscribeCategory | null = row.category === "system" ? null : row.category;
  const [message] = await categoryEmails(env, apiOrigin(c), category, [{ id: user.id, name: user.name, email: user.email }], (u, unsubscribe) =>
    render({ name: u.name, email: u.email, title: row.title, subject: `[ทดสอบ] ${row.subject}`, content: row.body_html, link, unsubscribe_link: unsubscribe }));
  const email = await sendEmailBatch([message], env.RESEND_API_KEY);
  const summary = markdownToText(row.body_markdown, 500);
  await createNotification(c.env.DB, user.id, `[ทดสอบ] ${row.title}`, summary, { link: row.link, category: "broadcast" });
  const push = channels.includes("push") ? await pushToUser(env, user.id, { title: `[ทดสอบ] ${row.title}`, body: summary.slice(0, 200), url: row.link ?? "/dashboard" }) : 0;
  const line = channels.includes("line") ? await lineToUser(env, user.id, `[ทดสอบ] ${row.title}\n\n${summary}`) : false;
  return c.json({ message: `ส่งทดสอบถึง ${user.email} แล้ว`, sent: { email: email.sent, in_app: 1, push, line: line ? 1 : 0 } });
});

/**
 * POST /communication/broadcasts/:id/send { scheduled_at?: ISO, defer?: boolean }
 * Future scheduled_at → "scheduled" (sent by the daily cron, or when staff open the history after that time).
 * Otherwise queued now and delivered in chunks of 100 after the response; `defer` leaves delivery to the cron / process endpoint.
 */
communicationRouter.post("/communication/broadcasts/:id/send", rbac(), async (c) => {
  const access = await broadcastAccess(c);
  if (!access) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const row = await loadBroadcast(c, access);
  if (!row) return c.json({ error: "ไม่พบประกาศ" }, 404);
  if (row.status !== "draft" && row.status !== "scheduled") return c.json({ error: "ประกาศนี้ส่งหรือยกเลิกไปแล้ว" }, 409);
  const body = await readJson(c);
  const db = c.env.DB;
  if (body.scheduled_at) {
    const at = Date.parse(String(body.scheduled_at));
    if (!Number.isFinite(at)) return c.json({ error: "วันเวลาที่ตั้งส่งไม่ถูกต้อง" }, 400);
    if (at > Date.now() + 60 * 1000) {
      if (at > Date.now() + 366 * 24 * 3600 * 1000) return c.json({ error: "ตั้งเวลาได้ไม่เกิน 1 ปี" }, 400);
      await db.prepare("UPDATE broadcasts SET status = 'scheduled', scheduled_at = ?, api_origin = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(new Date(at).toISOString(), apiOrigin(c), row.id).run();
      return c.json({ status: "scheduled", scheduled_at: new Date(at).toISOString(), message: "ตั้งเวลาส่งแล้ว" });
    }
  }
  await db.prepare("UPDATE broadcasts SET api_origin = ? WHERE id = ?").bind(apiOrigin(c), row.id).run();
  const count = await queueBroadcast(c.env, row.id);
  if (count === null) return c.json({ error: "เริ่มส่งไม่สำเร็จ กรุณาลองใหม่" }, 409);
  if (count > 0 && !body.defer) runLater(c, processBroadcastQueue(commEnv(c), { broadcastId: row.id, maxBatches: 3 }), "Broadcast delivery");
  return c.json({ status: count === 0 ? "sent" : "sending", recipient_count: count, message: count === 0 ? "ไม่มีผู้รับตามเงื่อนไข" : `กำลังส่งถึง ${count} คน` });
});

/** Delivers one more chunk now (instead of waiting for the cron). { limit?: 1..100 } */
communicationRouter.post("/communication/broadcasts/:id/process", rbac(), async (c) => {
  const access = await broadcastAccess(c);
  if (!access) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const row = await loadBroadcast(c, access);
  if (!row) return c.json({ error: "ไม่พบประกาศ" }, 404);
  const body = await readJson(c);
  const limit = Math.max(1, Math.min(BATCH_SIZE, Number(body.limit) || BATCH_SIZE));
  const processed = await processBroadcastBatch(commEnv(c), row.id, limit);
  const status = await finalizeBroadcast(c.env.DB, row.id);
  const remaining = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'queued'").bind(row.id).first<{ n: number }>();
  const counts = await deliveryCounts(c.env.DB, [row.id]);
  return c.json({ processed, remaining: remaining?.n ?? 0, status, delivery: counts.get(row.id) });
});

// ---------- Email templates ----------

communicationRouter.get("/communication/templates", rbac(), async (c) => {
  if (!(await currentPermissions(c)).has("communication.manage")) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const rows = await c.env.DB.prepare("SELECT t.key, t.subject, t.body_html, t.updated_at, u.name AS updated_by_name FROM email_templates t LEFT JOIN users u ON u.id = t.updated_by")
    .all<{ key: string; subject: string; body_html: string; updated_at: string; updated_by_name: string | null }>();
  const saved = new Map(rows.results.map(r => [r.key, r]));
  return c.json({
    templates: (Object.keys(EMAIL_TEMPLATES) as EmailTemplateKey[]).map(key => ({
      key, label: EMAIL_TEMPLATES[key].label, variables: EMAIL_TEMPLATES[key].variables,
      default_subject: EMAIL_TEMPLATES[key].subject, default_body: EMAIL_TEMPLATES[key].body,
      override: saved.get(key) ?? null
    }))
  });
});

/** Account-security emails (password reset, invitation, verification, password-changed): only admins may override them. */
export const SECURITY_TEMPLATE_KEYS: ReadonlySet<EmailTemplateKey> = new Set<EmailTemplateKey>(["reset", "invite", "verification", "password_changed"]);
const LINK_VARIABLE = /\{\{\s*(?:link|unsubscribe_link)\s*\}\}/i;

/**
 * {{link}} / {{unsubscribe_link}} carry one-time tokens: they may appear only as the whole href value of
 * an <a> tag (href="{{link}}"), never inside another URL, another attribute, plain text or the subject.
 */
export function linkPlacementError(subject: string, html: string): string | null {
  if (LINK_VARIABLE.test(subject)) return "หัวเรื่องอีเมลใส่ {{link}} ไม่ได้";
  const stripped = html.replace(/<a\b[^>]*>/gi, tag => tag.replace(/\shref\s*=\s*(["'])\s*\{\{\s*(?:link|unsubscribe_link)\s*\}\}\s*\1/gi, ""));
  if (LINK_VARIABLE.test(stripped)) return "ใส่ {{link}} ได้เฉพาะเป็นค่าทั้งหมดของ href ในลิงก์ เช่น <a href=\"{{link}}\">…</a> เท่านั้น";
  return null;
}

const isAdmin = (c: Context<Env>) => c.get("user").roles.includes("admin");

communicationRouter.put("/communication/templates/:key", rbac(), async (c) => {
  if (!(await currentPermissions(c)).has("communication.manage")) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const key = c.req.param("key");
  if (!isEmailTemplateKey(key)) return c.json({ error: "ไม่พบแม่แบบอีเมล" }, 404);
  if (SECURITY_TEMPLATE_KEYS.has(key) && !isAdmin(c)) return c.json({ error: "แม่แบบอีเมลด้านความปลอดภัยของบัญชีแก้ไขได้เฉพาะผู้ดูแลระบบ" }, 403);
  const body = await readJson(c);
  const subject = text(body.subject, 300);
  const html = typeof body.body === "string" ? sanitizeHtml(body.body.slice(0, 50000)).trim() : "";
  if (!subject || !html) return c.json({ error: "กรุณากรอกหัวเรื่องและเนื้อหา" }, 400);
  const placement = linkPlacementError(subject, html);
  if (placement) return c.json({ error: placement }, 400);
  await c.env.DB.prepare(`INSERT INTO email_templates (key, subject, body_html, updated_by, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET subject = excluded.subject, body_html = excluded.body_html, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
    .bind(key, subject, html, c.get("user").id).run();
  return c.json({ message: "บันทึกแม่แบบแล้ว", template: { key, subject, body_html: html } });
});

communicationRouter.delete("/communication/templates/:key", rbac(), async (c) => {
  if (!(await currentPermissions(c)).has("communication.manage")) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const key = c.req.param("key");
  if (!isEmailTemplateKey(key)) return c.json({ error: "ไม่พบแม่แบบอีเมล" }, 404);
  if (SECURITY_TEMPLATE_KEYS.has(key) && !isAdmin(c)) return c.json({ error: "แม่แบบอีเมลด้านความปลอดภัยของบัญชีแก้ไขได้เฉพาะผู้ดูแลระบบ" }, 403);
  await c.env.DB.prepare("DELETE FROM email_templates WHERE key = ?").bind(key).run();
  return c.json({ message: "กลับไปใช้แม่แบบมาตรฐานแล้ว" });
});

/**
 * Preview with sample values (+ optional `vars`). With `subject`/`body` it previews unsaved edits;
 * without them it renders what would be sent now (saved override, or the default text).
 */
communicationRouter.post("/communication/templates/:key/preview", rbac(), async (c) => {
  if (!(await currentPermissions(c)).has("communication.manage")) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const key = c.req.param("key");
  if (!isEmailTemplateKey(key)) return c.json({ error: "ไม่พบแม่แบบอีเมล" }, 404);
  const body = await readJson(c);
  const template = EMAIL_TEMPLATES[key];
  const vars: Record<string, string> = { ...template.sample };
  if (body.vars && typeof body.vars === "object") {
    for (const name of template.variables) {
      if (typeof body.vars[name] === "string") vars[name] = body.vars[name].slice(0, 2000);
    }
  }
  // {{content}} is inserted as HTML, so a value from the editor is sanitized first.
  if (vars.content !== undefined) vars.content = sanitizeHtml(vars.content);
  if (typeof body.subject === "string" || typeof body.body === "string") {
    const rendered = renderTemplateText(text(body.subject, 300) || template.subject, sanitizeHtml(String(body.body ?? template.body).slice(0, 50000)), vars, key);
    return c.json(rendered);
  }
  const fallback = renderTemplateText(template.subject, template.body, vars, key);
  return c.json(await renderTemplate(c.env.DB, key, vars, { subject: fallback.subject, html: fallback.html }));
});

// ---------- Course announcements ----------

async function courseAccess(c: Context<Env>, courseId: string) {
  const course = await courseOwner(c.env.DB, courseId);
  if (!course) return null;
  const user = c.get("user");
  const perms = await currentPermissions(c);
  const canPost = course.instructor_id === user.id || perms.has("communication.manage");
  const canRead = canPost || isStaff(user) || !!(await c.env.DB.prepare("SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ? AND status IN ('active', 'completed')")
    .bind(user.id, courseId).first());
  return { course, canPost, canRead };
}

communicationRouter.get("/communication/courses/:courseId/announcements", rbac(), async (c) => {
  const access = await courseAccess(c, c.req.param("courseId"));
  if (!access) return c.json({ error: "ไม่พบคอร์ส" }, 404);
  if (!access.canRead) return c.json({ error: "เฉพาะผู้เรียนในคอร์สนี้" }, 403);
  const rows = await c.env.DB.prepare(`SELECT a.id, a.course_id, a.title, a.body_markdown AS body, a.body_html, a.pinned, a.email_sent, a.recipient_count, a.created_at,
      u.name AS author_name FROM course_announcements a LEFT JOIN users u ON u.id = a.author_id
    WHERE a.course_id = ? ORDER BY a.pinned DESC, a.created_at DESC LIMIT 50`).bind(access.course.id).all();
  return c.json({ announcements: rows.results, can_post: access.canPost });
});

communicationRouter.post("/communication/courses/:courseId/announcements", rbac(), async (c) => {
  const access = await courseAccess(c, c.req.param("courseId"));
  if (!access) return c.json({ error: "ไม่พบคอร์ส" }, 404);
  if (!access.canPost) return c.json({ error: "ประกาศได้เฉพาะผู้สอนของคอร์สนี้" }, 403);
  const user = c.get("user");
  if (await rateLimited(c.env.SESSIONS, "announcement", user.id, 30)) return tooManyRequests(c);
  const body = await readJson(c);
  const title = text(body.title, 200);
  const markdown = typeof body.body === "string" ? body.body.slice(0, 20000) : "";
  if (!title || !markdown.trim()) return c.json({ error: "กรุณากรอกหัวข้อและเนื้อหา" }, 400);
  const db = c.env.DB;
  const id = newId("ann");
  const html = renderMarkdown(markdown);
  const sendEmail = body.send_email === true;
  const summary = markdownToText(markdown, 300);
  const link = `/dashboard?course=${encodeURIComponent(access.course.id)}`;
  await db.prepare("INSERT INTO course_announcements (id, course_id, author_id, title, body_markdown, body_html, pinned, email_sent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, access.course.id, user.id, title, markdown, html, body.pinned ? 1 : 0, sendEmail ? 1 : 0).run();
  // In-app notifications for every active learner of the course, in one statement.
  const learners = `FROM enrollments e JOIN users u ON u.id = e.user_id WHERE e.course_id = ? AND e.status IN ('active', 'completed') AND u.status = 'active' AND u.id <> ?`;
  const inserted = await db.prepare(`INSERT INTO notifications (id, user_id, title, content, is_read, link, category)
    SELECT 'ntf_' || lower(hex(randomblob(8))), e.user_id, ?, ?, 0, ?, 'announcement' ${learners}`)
    .bind(`ประกาศ: ${access.course.title} — ${title}`.slice(0, 250), summary, link, access.course.id, user.id).run();
  const recipients = inserted.meta.changes ?? 0;
  await db.prepare("UPDATE course_announcements SET recipient_count = ? WHERE id = ?").bind(recipients, id).run();

  const env = commEnv(c);
  const origin = apiOrigin(c);
  runLater(c, (async () => {
    const people = (await db.prepare(`SELECT u.id, u.name, u.email ${learners}`).bind(access.course.id, user.id).all<{ id: string; name: string; email: string }>()).results;
    const prefs = await preferencesFor(db, people.map(p => p.id));
    if (sendEmail) {
      const allowed = people.filter(p => p.email && prefs.get(p.id)!.email_course);
      const courseLink = appUrl(env, link);
      for (let i = 0; i < allowed.length; i += BATCH_SIZE) {
        const messages = await categoryEmails(env, origin, "course", allowed.slice(i, i + BATCH_SIZE), (p, unsubscribe) => ({
          subject: `ประกาศจากคอร์ส ${access.course.title}: ${title}`.slice(0, 250),
          html: defaultBroadcastHtml({ name: p.name, email: p.email, title, content: html, link: courseLink, unsubscribe_link: unsubscribe })
        }));
        await sendEmailBatch(messages, env.RESEND_API_KEY);
      }
    }
    for (const p of people.slice(0, 500)) {
      const pref = prefs.get(p.id)!;
      if (pref.push) await pushToUser(env, p.id, { title: `ประกาศ: ${title}`, body: summary.slice(0, 200), url: link, tag: id });
      if (pref.line) await lineToUser(env, p.id, `ประกาศจากคอร์ส ${access.course.title}\n${title}\n\n${summary}`);
    }
  })(), "Announcement delivery");
  return c.json({ announcement: { id, course_id: access.course.id, title, body: markdown, body_html: html, pinned: body.pinned ? 1 : 0 }, recipients }, 201);
});

communicationRouter.delete("/communication/announcements/:id", rbac(), async (c) => {
  const row = await c.env.DB.prepare("SELECT a.id, a.course_id, c.instructor_id FROM course_announcements a JOIN courses c ON c.id = a.course_id WHERE a.id = ?")
    .bind(c.req.param("id")).first<{ id: string; course_id: string; instructor_id: string }>();
  if (!row) return c.json({ error: "ไม่พบประกาศ" }, 404);
  if (row.instructor_id !== c.get("user").id && !(await currentPermissions(c)).has("communication.manage")) return c.json({ error: "ไม่มีสิทธิ์ลบประกาศนี้" }, 403);
  await c.env.DB.prepare("DELETE FROM course_announcements WHERE id = ?").bind(row.id).run();
  return c.json({ message: "ลบประกาศแล้ว" });
});

/** Latest announcements from the signed-in learner's courses (dashboard). */
communicationRouter.get("/communication/my-announcements", rbac(), async (c) => {
  const rows = await c.env.DB.prepare(`SELECT a.id, a.course_id, co.title AS course_title, a.title, a.body_markdown AS body, a.body_html, a.pinned, a.created_at, u.name AS author_name
    FROM course_announcements a JOIN courses co ON co.id = a.course_id LEFT JOIN users u ON u.id = a.author_id
    WHERE a.course_id IN (SELECT course_id FROM enrollments WHERE user_id = ? AND status IN ('active', 'completed'))
    ORDER BY a.created_at DESC LIMIT 20`).bind(c.get("user").id).all();
  return c.json({ announcements: rows.results });
});

// ---------- Notification preferences & unsubscribe ----------

communicationRouter.get("/me/notification-preferences", rbac(), async (c) => {
  const user = c.get("user");
  const env = commEnv(c);
  const db = c.env.DB;
  const subs = await db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?").bind(user.id).first<{ n: number }>();
  const link = await db.prepare("SELECT linked_at FROM line_links WHERE user_id = ?").bind(user.id).first<{ linked_at: string }>();
  const vapid = vapidFromEnv(env);
  return c.json({
    preferences: await getPreferences(db, user.id),
    push: { configured: !!vapid, public_key: vapid?.publicKey ?? null, subscriptions: subs?.n ?? 0 },
    line: { configured: lineConfigured(env) && !!env.LINE_CHANNEL_SECRET, linked: !!link, linked_at: link?.linked_at ?? null, oa_id: env.LINE_OA_ID ?? null }
  });
});

communicationRouter.put("/me/notification-preferences", rbac(), async (c) => {
  const body = await readJson(c);
  const changes: Partial<NotificationPreferences> = {};
  for (const key of ["email_marketing", "email_course", "push", "line"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") return c.json({ error: "ค่าการตั้งค่าไม่ถูกต้อง" }, 400);
    changes[key] = body[key];
  }
  return c.json({ preferences: await savePreferences(c.env.DB, c.get("user").id, changes), message: "บันทึกการตั้งค่าการแจ้งเตือนแล้ว" });
});

function unsubscribePage(title: string, message: string, form?: string): string {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head>
<body style="font-family:sans-serif;background:#f8fafc;margin:0;padding:40px 16px">
<div style="max-width:480px;margin:auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px;text-align:center">
<h1 style="font-size:20px;color:#0f172a">${escapeHtml(title)}</h1><p style="color:#475569;line-height:1.6">${escapeHtml(message)}</p>${form ?? ""}
</div></body></html>`;
}

const CATEGORY_LABEL: Record<UnsubscribeCategory, string> = { marketing: "ข่าวสารและโปรโมชั่น", course: "อัปเดตจากคอร์สเรียน" };

/** Confirmation page (link scanners must not unsubscribe people, so GET never changes anything). */
communicationRouter.get("/communication/unsubscribe", async (c) => {
  c.header("Cache-Control", "no-store");
  const token = c.req.query("token") || "";
  const parsed = await verifyUnsubscribeToken(c.env.JWT_SECRET, token);
  if (!parsed) return c.html(unsubscribePage("ลิงก์ไม่ถูกต้อง", "ลิงก์ยกเลิกการรับอีเมลไม่ถูกต้องหรือไม่สมบูรณ์ คุณยังตั้งค่าได้ที่หน้าโปรไฟล์หลังเข้าสู่ระบบ"), 400);
  const form = `<form method="post" action="?token=${escapeHtml(encodeURIComponent(token))}"><button type="submit"
    style="background:#6366f1;color:#fff;border:0;border-radius:8px;padding:10px 20px;font-size:15px;cursor:pointer">ยืนยันยกเลิกการรับอีเมล</button></form>`;
  return c.html(unsubscribePage("ยกเลิกการรับอีเมล", `ต้องการหยุดรับอีเมลประเภท "${CATEGORY_LABEL[parsed.category]}" ใช่หรือไม่`, form));
});

/** Confirm button and RFC 8058 one-click (List-Unsubscribe-Post). */
communicationRouter.post("/communication/unsubscribe", async (c) => {
  c.header("Cache-Control", "no-store");
  const parsed = await verifyUnsubscribeToken(c.env.JWT_SECRET, c.req.query("token") || "");
  if (!parsed) return c.html(unsubscribePage("ลิงก์ไม่ถูกต้อง", "ลิงก์ยกเลิกการรับอีเมลไม่ถูกต้องหรือไม่สมบูรณ์"), 400);
  const exists = await c.env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(parsed.userId).first();
  if (exists) await savePreferences(c.env.DB, parsed.userId, parsed.category === "marketing" ? { email_marketing: false } : { email_course: false });
  return c.html(unsubscribePage("ยกเลิกการรับอีเมลแล้ว", `คุณจะไม่ได้รับอีเมลประเภท "${CATEGORY_LABEL[parsed.category]}" อีก เปิดรับใหม่ได้ที่หน้าโปรไฟล์`));
});

// ---------- Web push subscriptions ----------

communicationRouter.get("/push/public-key", (c) => {
  const vapid = vapidFromEnv(commEnv(c));
  return c.json({ configured: !!vapid, public_key: vapid?.publicKey ?? null });
});

communicationRouter.get("/push/subscriptions", rbac(), async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, endpoint, user_agent, created_at, last_used_at FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC")
    .bind(c.get("user").id).all<{ id: string; endpoint: string; user_agent: string | null; created_at: string; last_used_at: string | null }>();
  return c.json({
    configured: !!vapidFromEnv(commEnv(c)),
    subscriptions: rows.results.map(r => ({ id: r.id, service: new URL(r.endpoint).hostname, user_agent: r.user_agent, created_at: r.created_at, last_used_at: r.last_used_at }))
  });
});

communicationRouter.post("/push/subscriptions", rbac(), async (c) => {
  const user = c.get("user");
  if (await rateLimited(c.env.SESSIONS, "push-sub", user.id, 30)) return tooManyRequests(c);
  const body = await readJson(c);
  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint || endpoint.length > 1024 || !isAllowedPushEndpoint(endpoint)) return c.json({ error: "ที่อยู่การแจ้งเตือนของเบราว์เซอร์ไม่ถูกต้อง" }, 400);
  if (!validSubscriptionKeys(body.keys?.p256dh, body.keys?.auth)) return c.json({ error: "คีย์การแจ้งเตือนของเบราว์เซอร์ไม่ถูกต้อง" }, 400);
  const db = c.env.DB;
  const id = newId("push");
  await db.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`)
    .bind(id, user.id, endpoint, body.keys.p256dh, body.keys.auth, (c.req.header("User-Agent") || "").slice(0, 200) || null).run();
  // Keep the newest 10 devices per user.
  await db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN
    (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10)`).bind(user.id, user.id).run();
  const row = await db.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).first<{ id: string }>();
  return c.json({ subscription: { id: row?.id ?? id }, configured: !!vapidFromEnv(commEnv(c)), message: "เปิดการแจ้งเตือนบนอุปกรณ์นี้แล้ว" }, 201);
});

communicationRouter.delete("/push/subscriptions", rbac(), async (c) => {
  const body = await readJson(c);
  const user = c.get("user");
  const result = typeof body.endpoint === "string"
    ? await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").bind(user.id, body.endpoint).run()
    : typeof body.id === "string"
      ? await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND id = ?").bind(user.id, body.id).run()
      : null;
  if (!result) return c.json({ error: "กรุณาระบุอุปกรณ์" }, 400);
  return c.json({ removed: result.meta.changes ?? 0, message: "ปิดการแจ้งเตือนบนอุปกรณ์นี้แล้ว" });
});

communicationRouter.post("/push/test", rbac(), async (c) => {
  const user = c.get("user");
  if (await rateLimited(c.env.SESSIONS, "push-test", user.id, 10)) return tooManyRequests(c);
  const env = commEnv(c);
  const delivered = await pushToUser(env, user.id, { title: "ทดสอบการแจ้งเตือน", body: "การแจ้งเตือนบนอุปกรณ์นี้ใช้งานได้แล้ว", url: "/dashboard" });
  return c.json({ configured: !!vapidFromEnv(env), delivered });
});

// ---------- LINE linking ----------

/** Unambiguous alphabet (no 0/O, 1/I/L): 8 characters ≈ 39 bits per code. */
const LINE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const LINE_CODE_LENGTH = 8;
const LINE_CODE = new RegExp(`^NP-?([${LINE_CODE_ALPHABET}]{${LINE_CODE_LENGTH}})$`, "i");
/** Link attempts per LINE user and per code within 15 minutes (brute-force guard). */
const LINE_ATTEMPTS = 5;
const LINE_ATTEMPT_WINDOW = 15 * 60;

export function newLineLinkCode(): string {
  let out = "";
  while (out.length < LINE_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // Rejection sampling keeps every character equally likely.
      if (byte < 248 && out.length < LINE_CODE_LENGTH) out += LINE_CODE_ALPHABET[byte % LINE_CODE_ALPHABET.length];
    }
  }
  return `NP-${out}`;
}

communicationRouter.post("/line/link-code", rbac(), async (c) => {
  const user = c.get("user");
  if (await rateLimited(c.env.SESSIONS, "line-code", user.id, 10)) return tooManyRequests(c);
  const env = commEnv(c);
  const code = newLineLinkCode();
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM line_link_codes WHERE user_id = ? OR expires_at < ?").bind(user.id, nowIso()),
    c.env.DB.prepare("INSERT OR REPLACE INTO line_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)").bind(code, user.id, expires)
  ]);
  return c.json({
    code, expires_at: expires, configured: lineConfigured(env) && !!env.LINE_CHANNEL_SECRET, oa_id: env.LINE_OA_ID ?? null,
    instructions: `เพิ่มเพื่อน LINE Official Account${env.LINE_OA_ID ? ` ${env.LINE_OA_ID}` : ""} แล้วพิมพ์รหัส ${code} ในแชท ภายใน 15 นาที`
  });
});

communicationRouter.delete("/line/link", rbac(), async (c) => {
  const result = await c.env.DB.prepare("DELETE FROM line_links WHERE user_id = ?").bind(c.get("user").id).run();
  return c.json({ removed: result.meta.changes ?? 0, message: "ยกเลิกการเชื่อม LINE แล้ว" });
});

/** LINE webhook: verifies X-Line-Signature, links accounts from one-time codes, unlinks on unfollow. */
communicationRouter.post("/line/webhook", async (c) => {
  const env = commEnv(c);
  const secret = env.LINE_CHANNEL_SECRET?.trim();
  if (!secret) return c.json({ error: "ยังไม่ได้ตั้งค่า LINE" }, 503);
  const raw = await c.req.text();
  if (raw.length > 1_000_000 || !(await verifyLineSignature(secret, raw, c.req.header("X-Line-Signature")))) {
    return c.json({ error: "ลายเซ็นไม่ถูกต้อง" }, 401);
  }
  let payload: { events?: any[] };
  try { payload = JSON.parse(raw); } catch { return c.json({ error: "รูปแบบ JSON ไม่ถูกต้อง" }, 400); }
  const db = c.env.DB;
  let linked = 0;
  let unlinked = 0;
  let limited = 0;
  for (const event of (Array.isArray(payload.events) ? payload.events : []).slice(0, 50)) {
    const lineUserId = typeof event?.source?.userId === "string" ? event.source.userId : null;
    if (!lineUserId) continue;
    if (event.type === "unfollow") {
      unlinked += (await db.prepare("DELETE FROM line_links WHERE line_user_id = ?").bind(lineUserId).run()).meta.changes ?? 0;
      continue;
    }
    if (event.type !== "message" || event.message?.type !== "text") continue;
    const match = LINE_CODE.exec(String(event.message.text || "").trim());
    if (!match) continue;
    const code = `NP-${match[1].toUpperCase()}`;
    if (await rateLimited(c.env.SESSIONS, "line-link-user", lineUserId, LINE_ATTEMPTS, LINE_ATTEMPT_WINDOW)
      || await rateLimited(c.env.SESSIONS, "line-link-code", code, LINE_ATTEMPTS, LINE_ATTEMPT_WINDOW)) {
      limited++;
      if (event.replyToken) await lineReplyText(env, event.replyToken, "ลองกรอกรหัสหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วขอรหัสใหม่จากหน้าโปรไฟล์");
      continue;
    }
    const row = await db.prepare("SELECT user_id FROM line_link_codes WHERE code = ? AND expires_at > ?").bind(code, nowIso()).first<{ user_id: string }>();
    if (!row) {
      if (event.replyToken) await lineReplyText(env, event.replyToken, "รหัสไม่ถูกต้องหรือหมดอายุ กรุณาขอรหัสใหม่จากหน้าโปรไฟล์");
      continue;
    }
    await db.batch([
      db.prepare("DELETE FROM line_links WHERE line_user_id = ? AND user_id <> ?").bind(lineUserId, row.user_id),
      db.prepare(`INSERT INTO line_links (user_id, line_user_id) VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET line_user_id = excluded.line_user_id, linked_at = CURRENT_TIMESTAMP`).bind(row.user_id, lineUserId),
      db.prepare("DELETE FROM line_link_codes WHERE code = ?").bind(code)
    ]);
    linked++;
    if (event.replyToken) await lineReplyText(env, event.replyToken, "เชื่อมบัญชี Netprime LMS เรียบร้อยแล้ว คุณจะได้รับการแจ้งเตือนทาง LINE");
  }
  return c.json({ ok: true, linked, unlinked, limited });
});

// ---------- Settings ----------

communicationRouter.get("/communication/settings", rbac(), async (c) => {
  if (!(await currentPermissions(c)).has("communication.manage")) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  return c.json({ settings: { dm_learner_to_learner: (await getSetting(c.env.DB, "dm_learner_to_learner", "0")) === "1" } });
});

communicationRouter.put("/communication/settings", rbac(), async (c) => {
  if (!(await currentPermissions(c)).has("communication.manage")) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const body = await readJson(c);
  if (typeof body.dm_learner_to_learner !== "boolean") return c.json({ error: "ค่าการตั้งค่าไม่ถูกต้อง" }, 400);
  await c.env.DB.prepare(`INSERT INTO communication_settings (key, value, updated_at) VALUES ('dm_learner_to_learner', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind(body.dm_learner_to_learner ? "1" : "0").run();
  return c.json({ settings: { dm_learner_to_learner: body.dm_learner_to_learner }, message: "บันทึกการตั้งค่าแล้ว" });
});
