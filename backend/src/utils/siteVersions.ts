import type { Context } from "hono";
import type { Env } from "../middleware/rbac";

/** Website builder settings that have drafts and a version history. */
export const VERSIONED_KEYS = ["theme", "home", "nav"] as const;
export type VersionedKey = typeof VERSIONED_KEYS[number];
export const isVersionedKey = (value: string): value is VersionedKey => (VERSIONED_KEYS as readonly string[]).includes(value);

const KEEP = 30;
export const draftKey = (key: VersionedKey) => `draft:${key}`;

/**
 * After a setting is published: keep a copy in the history (newest 30 per key) and drop the draft,
 * which the published value replaces.
 */
export async function recordPublished(c: Context<Env>, key: VersionedKey, value: unknown, previous?: { value: unknown; updated_at: string | null }) {
  const db = c.env.DB;
  // The first publish with history also keeps what was live before, so it can be restored.
  if (previous) {
    const any = await db.prepare("SELECT 1 FROM site_setting_versions WHERE key = ? LIMIT 1").bind(key).first();
    if (!any) {
      await db.prepare(`INSERT INTO site_setting_versions (id, key, value, published_by, published_at)
        VALUES (?, ?, ?, NULL, COALESCE(?, datetime('now', '-1 second')))`)
        .bind(crypto.randomUUID(), key, JSON.stringify(previous.value), previous.updated_at).run();
    }
  }
  await db.batch([
    db.prepare("INSERT INTO site_setting_versions (id, key, value, published_by) VALUES (?, ?, ?, ?)")
      .bind(crypto.randomUUID(), key, JSON.stringify(value), c.get("user").id),
    db.prepare(`DELETE FROM site_setting_versions WHERE key = ? AND id NOT IN
      (SELECT id FROM site_setting_versions WHERE key = ? ORDER BY published_at DESC, rowid DESC LIMIT ?)`).bind(key, key, KEEP),
    db.prepare("DELETE FROM site_settings WHERE key = ?").bind(draftKey(key))
  ]);
}
