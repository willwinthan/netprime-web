import { Hono, Context } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { currentPermissions, Permission } from "../utils/permissions";
import { draftKey, isVersionedKey, VersionedKey } from "../utils/siteVersions";
import { DEFAULT_THEME, Invalid, parseNav, parseTheme, sanitizeKeys } from "./website";
import { parseHome } from "./site";

/**
 * Drafts and history for the website builder's theme, homepage content and menus.
 *
 * A draft is saved under site_settings "draft:<key>" and is never shown on the public site; publishing
 * goes through the existing PUT endpoints (/website/theme, /website/nav, /admin/site/home), which also
 * record the version and drop the draft. Restoring an old version loads it into the editor, where it
 * is previewed and then published like any other edit.
 */
export const siteDraftsRouter = new Hono<Env>();

const PERMISSION: Record<VersionedKey, Permission> = { theme: "website.design", nav: "website.design", home: "site.settings" };

type Validated = { value?: unknown; error?: string };

/** Same checks as publishing, so a draft can always be published. */
function validateDraft(key: VersionedKey, body: Record<string, unknown>): Validated {
  try {
    if (key === "theme") return { value: parseTheme(sanitizeKeys(Object.keys(DEFAULT_THEME), body)) };
    if (key === "nav") return { value: parseNav(body) };
    const { home, error } = parseHome(body);
    return error ? { error } : { value: home };
  } catch (error) {
    if (error instanceof Invalid) return { error: error.message };
    throw error;
  }
}

async function allowed(c: Context<Env>): Promise<VersionedKey | Response> {
  const key = c.req.param("key") ?? "";
  if (!isVersionedKey(key)) return c.json({ error: "ไม่พบส่วนนี้" }, 404);
  if (!(await currentPermissions(c)).has(PERMISSION[key])) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  c.header("Cache-Control", "no-store");
  return key;
}

/** GET /api/site-drafts/:key — the saved draft, or null. */
siteDraftsRouter.get("/site-drafts/:key", rbac(), async (c) => {
  const key = await allowed(c);
  if (key instanceof Response) return key;
  const row = await c.env.DB.prepare(`SELECT s.value, s.updated_at, u.name AS updated_by_name FROM site_settings s
    LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = ?`).bind(draftKey(key)).first<{ value: string; updated_at: string; updated_by_name: string | null }>();
  if (!row) return c.json({ draft: null });
  try {
    return c.json({ draft: JSON.parse(row.value), updated_at: row.updated_at, updated_by_name: row.updated_by_name });
  } catch {
    return c.json({ draft: null });
  }
});

/** PUT /api/site-drafts/:key — save work in progress (checked like a publish). */
siteDraftsRouter.put("/site-drafts/:key", rbac(), async (c) => {
  const key = await allowed(c);
  if (key instanceof Response) return key;
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const { value, error } = validateDraft(key, body);
  if (error || value === undefined) return c.json({ error: error || "ข้อมูลไม่ถูกต้อง" }, 400);
  await c.env.DB.prepare(`INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
    .bind(draftKey(key), JSON.stringify(value), c.get("user").id).run();
  return c.json({ draft: value });
});

/** DELETE /api/site-drafts/:key — discard the draft (the published version stays). */
siteDraftsRouter.delete("/site-drafts/:key", rbac(), async (c) => {
  const key = await allowed(c);
  if (key instanceof Response) return key;
  await c.env.DB.prepare("DELETE FROM site_settings WHERE key = ?").bind(draftKey(key)).run();
  return c.json({ deleted: true });
});

/** GET /api/site-drafts/:key/versions — published versions, newest first (without values). */
siteDraftsRouter.get("/site-drafts/:key/versions", rbac(), async (c) => {
  const key = await allowed(c);
  if (key instanceof Response) return key;
  const rows = await c.env.DB.prepare(`SELECT v.id, v.published_at, u.name AS published_by_name FROM site_setting_versions v
    LEFT JOIN users u ON u.id = v.published_by WHERE v.key = ? ORDER BY v.published_at DESC, v.rowid DESC LIMIT 30`).bind(key).all();
  return c.json({ versions: rows.results });
});

/** GET /api/site-drafts/:key/versions/:id — one version's value, to load into the editor. */
siteDraftsRouter.get("/site-drafts/:key/versions/:id", rbac(), async (c) => {
  const key = await allowed(c);
  if (key instanceof Response) return key;
  const row = await c.env.DB.prepare("SELECT value, published_at FROM site_setting_versions WHERE id = ? AND key = ?")
    .bind(c.req.param("id"), key).first<{ value: string; published_at: string }>();
  if (!row) return c.json({ error: "ไม่พบฉบับนี้" }, 404);
  return c.json({ value: JSON.parse(row.value), published_at: row.published_at });
});
