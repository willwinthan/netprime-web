import { Hono } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { sendWebPush, vapidFromEnv } from "../utils/webpush";
import { linePushText, lineConfigured } from "../utils/line";

export const notificationsRouter = new Hono<Env>();

/** Optional secrets used by the communication features (not declared in middleware/rbac.ts Env). */
export type CommBindings = Env["Bindings"] & {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  LINE_CHANNEL_SECRET?: string;
  /** Basic ID of the LINE Official Account (e.g. "@netprime") shown on the linking screen. */
  LINE_OA_ID?: string;
};

// Get notifications for user
notificationsRouter.get("/notifications", rbac(), async (c) => {
  const user = c.get("user");
  try {
    const notifications = await c.env.DB
      .prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
      .bind(user.id)
      .all<any>();
    return c.json(notifications.results);
  } catch (error) {
    console.error("Fetch notifications failed:", error);
    return c.json({ error: "โหลดการแจ้งเตือนไม่สำเร็จ" }, 500);
  }
});

notificationsRouter.get("/notifications/unread-count", rbac(), async (c) => {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0")
    .bind(c.get("user").id).first<{ n: number }>();
  return c.json({ unread: row?.n ?? 0 });
});

// Mark all notifications as read
notificationsRouter.post("/notifications/read-all", rbac(), async (c) => {
  try {
    await c.env.DB.prepare("UPDATE notifications SET is_read = 1 WHERE user_id = ?").bind(c.get("user").id).run();
    return c.json({ success: true });
  } catch (error) {
    console.error("Mark notifications read failed:", error);
    return c.json({ error: "อัปเดตการแจ้งเตือนไม่สำเร็จ" }, 500);
  }
});

notificationsRouter.post("/notifications/:id/read", rbac(), async (c) => {
  await c.env.DB.prepare("UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.get("user").id).run();
  return c.json({ success: true });
});

// ---------- Preferences ----------

export interface NotificationPreferences { email_marketing: boolean; email_course: boolean; push: boolean; line: boolean }
export const DEFAULT_PREFERENCES: NotificationPreferences = { email_marketing: true, email_course: true, push: true, line: true };

type PrefRow = { user_id: string; email_marketing: number; email_course: number; push: number; line: number };
const toPrefs = (row?: PrefRow | null): NotificationPreferences => row
  ? { email_marketing: !!row.email_marketing, email_course: !!row.email_course, push: !!row.push, line: !!row.line }
  : { ...DEFAULT_PREFERENCES };

export async function getPreferences(db: D1Database, userId: string): Promise<NotificationPreferences> {
  return toPrefs(await db.prepare("SELECT * FROM notification_preferences WHERE user_id = ?").bind(userId).first<PrefRow>());
}

/** Preferences of many users at once (missing users get the defaults). */
export async function preferencesFor(db: D1Database, userIds: string[]): Promise<Map<string, NotificationPreferences>> {
  const map = new Map<string, NotificationPreferences>();
  if (!userIds.length) return map;
  const rows = await db.prepare("SELECT * FROM notification_preferences WHERE user_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(userIds)).all<PrefRow>();
  for (const row of rows.results) map.set(row.user_id, toPrefs(row));
  for (const id of userIds) if (!map.has(id)) map.set(id, { ...DEFAULT_PREFERENCES });
  return map;
}

export async function savePreferences(db: D1Database, userId: string, changes: Partial<NotificationPreferences>): Promise<NotificationPreferences> {
  const next = { ...(await getPreferences(db, userId)), ...changes };
  await db.prepare(`INSERT INTO notification_preferences (user_id, email_marketing, email_course, push, line, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET email_marketing = excluded.email_marketing, email_course = excluded.email_course,
      push = excluded.push, line = excluded.line, updated_at = CURRENT_TIMESTAMP`)
    .bind(userId, next.email_marketing ? 1 : 0, next.email_course ? 1 : 0, next.push ? 1 : 0, next.line ? 1 : 0).run();
  return next;
}

// ---------- External channels ----------

/**
 * Web push to every subscription of a user; expired subscriptions are removed.
 * Returns how many devices accepted it (0 when VAPID is not configured).
 */
export async function pushToUser(env: CommBindings, userId: string, message: { title: string; body: string; url?: string; tag?: string }): Promise<number> {
  const vapid = vapidFromEnv(env);
  if (!vapid) return 0;
  const subs = await env.DB.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? LIMIT 10")
    .bind(userId).all<{ id: string; endpoint: string; p256dh: string; auth: string }>();
  let delivered = 0;
  for (const sub of subs.results) {
    const result = await sendWebPush(sub, message, vapid);
    if (result.ok) {
      delivered++;
      await env.DB.prepare("UPDATE push_subscriptions SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?").bind(sub.id).run();
    } else if (result.gone) {
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(sub.id).run();
    }
  }
  return delivered;
}

/** LINE push to a linked account; false when LINE is not configured or not linked. */
export async function lineToUser(env: CommBindings, userId: string, text: string): Promise<boolean> {
  if (!lineConfigured(env)) return false;
  const link = await env.DB.prepare("SELECT line_user_id FROM line_links WHERE user_id = ?").bind(userId).first<{ line_user_id: string }>();
  return link ? linePushText(env, link.line_user_id, text) : false;
}

export interface NotifyOptions {
  /** Pass the Worker env to also send web push / LINE (each respects the user's preferences). */
  env?: CommBindings;
  link?: string | null;
  category?: string | null;
  channels?: Array<"push" | "line">;
}

// Helper utility function to create a notification. Existing callers (db, userId, title, content) keep the
// in-app-only behaviour; pass options.env to fan out to web push and LINE as well.
export async function createNotification(
  db: any,
  userId: string,
  title: string,
  content: string,
  options: NotifyOptions = {}
): Promise<boolean> {
  try {
    const id = "ntf_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    if (options.link || options.category) {
      await db.prepare("INSERT INTO notifications (id, user_id, title, content, is_read, link, category) VALUES (?, ?, ?, ?, 0, ?, ?)")
        .bind(id, userId, title, content, options.link ?? null, options.category ?? null).run();
    } else {
      await db.prepare("INSERT INTO notifications (id, user_id, title, content, is_read) VALUES (?, ?, ?, ?, 0)")
        .bind(id, userId, title, content).run();
    }
  } catch (error) {
    console.error("Failed to create notification:", error);
    return false;
  }
  if (options.env) {
    const env = options.env;
    const channels = options.channels ?? ["push", "line"];
    try {
      const prefs = await getPreferences(env.DB, userId);
      if (channels.includes("push") && prefs.push) await pushToUser(env, userId, { title, body: content.slice(0, 300), url: options.link ?? undefined });
      if (channels.includes("line") && prefs.line) await lineToUser(env, userId, `${title}\n${content}`.slice(0, 1000));
    } catch (error) {
      console.error("External notification delivery failed:", error);
    }
  }
  return true;
}
