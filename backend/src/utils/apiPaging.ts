import type { Context } from "hono";
import type { ApiEnv } from "../middleware/apikey";

/** Cursor pagination shared by /api/v1 lists: ?limit=1..200 (default 50) and ?cursor=<next_cursor>. */
export function encodeCursor(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeCursor(value: string | undefined): string | null | false {
  if (!value) return null;
  if (value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try { return atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4)); } catch { return false; }
}

/** Cursor = the last row's id (all v1 lists are ordered by id). */
export function page(c: Context<ApiEnv>): { limit: number; after: string } | Response {
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1), 200);
  const cursor = decodeCursor(c.req.query("cursor"));
  if (cursor === false) return c.json({ error: "cursor ไม่ถูกต้อง", code: "invalid_cursor" }, 400);
  return { limit, after: cursor ?? "" };
}

export function listResponse<T extends { id: string }>(c: Context<ApiEnv>, rows: T[], limit: number) {
  const more = rows.length > limit;
  const data = more ? rows.slice(0, limit) : rows;
  return c.json({ data, next_cursor: more ? encodeCursor(data[data.length - 1].id) : null });
}

