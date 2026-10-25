import { Hono, Context } from "hono";
import { Env, rbac, UserPayload } from "../middleware/rbac";
import { currentPermissions, parseRoles, rolesColumn, Role } from "../utils/permissions";
import { renderMarkdown, markdownToText } from "../utils/richtext";
import { trackEvent } from "../utils/events";
import { rateLimited, tooManyRequests } from "../utils/ratelimit";
import { createNotification } from "./notifications";
import { newId, nowIso, isStaff, commEnv, runLater, getSetting } from "./communication";

/**
 * Community spaces (school-wide and per course) and 1:1 direct messages (mounted at /api).
 * Learners see public spaces plus the spaces of courses they are enrolled in.
 * Moderation (pin / lock / hide, reports): community.moderate holders who are admin/coordinator everywhere,
 * instructors only in the spaces of their own courses.
 */
export const communityRouter = new Hono<Env>();

const REACTIONS = ["like", "love", "insightful", "thanks"] as const;

async function readJson(c: Context<Env>): Promise<Record<string, any>> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? body : {};
}
const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

interface SpaceRow {
  id: string; course_id: string | null; name: string; description: string | null; visibility: string; posting: string;
  sort_order: number; created_by: string | null; created_at: string; archived_at: string | null;
  instructor_id: string | null; course_title: string | null;
}
interface Rights { canView: boolean; canPost: boolean; canModerate: boolean }

async function globalModerator(c: Context<Env>): Promise<boolean> {
  return isStaff(c.get("user")) && (await currentPermissions(c)).has("community.moderate");
}

async function loadSpace(db: D1Database, id: string): Promise<SpaceRow | null> {
  return db.prepare(`SELECT s.*, co.instructor_id, co.title AS course_title FROM community_spaces s
    LEFT JOIN courses co ON co.id = s.course_id WHERE s.id = ?`).bind(id).first<SpaceRow>();
}

async function spaceRights(c: Context<Env>, space: SpaceRow): Promise<Rights> {
  const user = c.get("user");
  const perms = await currentPermissions(c);
  const owner = !!space.course_id && space.instructor_id === user.id;
  const canModerate = perms.has("community.moderate") && (isStaff(user) || owner);
  let canView = canModerate || owner || (!space.course_id && space.visibility === "public");
  if (!canView && space.course_id) {
    canView = isStaff(user) || !!(await c.env.DB.prepare("SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ? AND status IN ('active', 'completed')")
      .bind(user.id, space.course_id).first());
  }
  if (space.archived_at && !canModerate) canView = false;
  const canPost = canView && !space.archived_at && (space.posting === "everyone" || canModerate || owner);
  return { canView, canPost, canModerate };
}

interface PostRow {
  id: string; space_id: string; author_id: string | null; title: string; body_markdown: string; body_html: string;
  pinned: number; locked: number; hidden: number; created_at: string; updated_at: string; last_activity_at: string;
}

async function postContext(c: Context<Env>, postId: string) {
  const post = await c.env.DB.prepare("SELECT * FROM community_posts WHERE id = ?").bind(postId).first<PostRow>();
  if (!post) return null;
  const space = await loadSpace(c.env.DB, post.space_id);
  if (!space) return null;
  const rights = await spaceRights(c, space);
  if (!rights.canView) return null;
  // Hidden posts stay visible to moderators and their author only.
  if (post.hidden && !rights.canModerate && post.author_id !== c.get("user").id) return null;
  return { post, space, rights };
}

/** Notifies followers (except `exceptUserId`) after the response. */
function notifyFollowers(c: Context<Env>, targetType: "space" | "post", targetId: string, exceptUserId: string, title: string, content: string, link: string) {
  const env = commEnv(c);
  runLater(c, (async () => {
    const rows = await env.DB.prepare("SELECT user_id FROM community_follows WHERE target_type = ? AND target_id = ? AND user_id <> ? LIMIT 500")
      .bind(targetType, targetId, exceptUserId).all<{ user_id: string }>();
    for (const row of rows.results) {
      await createNotification(env.DB, row.user_id, title, content, { env, link, category: "community", channels: ["push"] });
    }
  })(), "Community follower notification");
}

async function follow(db: D1Database, targetType: "space" | "post", targetId: string, userId: string) {
  await db.prepare("INSERT OR IGNORE INTO community_follows (target_type, target_id, user_id) VALUES (?, ?, ?)").bind(targetType, targetId, userId).run();
}

// ---------- Spaces ----------

communityRouter.get("/community/spaces", rbac(), async (c) => {
  const user = c.get("user");
  const global = await globalModerator(c);
  const staff = isStaff(user);
  const rows = await c.env.DB.prepare(`SELECT s.*, co.instructor_id, co.title AS course_title,
      (SELECT COUNT(*) FROM community_posts p WHERE p.space_id = s.id AND p.hidden = 0) AS post_count,
      (SELECT MAX(p.last_activity_at) FROM community_posts p WHERE p.space_id = s.id AND p.hidden = 0) AS last_activity_at,
      EXISTS (SELECT 1 FROM community_follows f WHERE f.target_type = 'space' AND f.target_id = s.id AND f.user_id = ?) AS following
    FROM community_spaces s LEFT JOIN courses co ON co.id = s.course_id
    WHERE (s.archived_at IS NULL OR ? = 1)
      AND (s.course_id IS NULL OR ? = 1 OR co.instructor_id = ?
        OR EXISTS (SELECT 1 FROM enrollments e WHERE e.user_id = ? AND e.course_id = s.course_id AND e.status IN ('active', 'completed')))
    ORDER BY s.course_id IS NOT NULL, s.sort_order, s.created_at`).bind(user.id, global ? 1 : 0, staff ? 1 : 0, user.id, user.id).all<SpaceRow & Record<string, unknown>>();
  const perms = await currentPermissions(c);
  return c.json({
    spaces: rows.results.map(s => ({ ...s, can_moderate: perms.has("community.moderate") && (staff || s.instructor_id === user.id) })),
    can_create: global || (perms.has("community.moderate") && user.roles.includes("instructor"))
  });
});

communityRouter.post("/community/spaces", rbac(), async (c) => {
  const user = c.get("user");
  const body = await readJson(c);
  const name = text(body.name, 120);
  if (!name) return c.json({ error: "กรุณาตั้งชื่อห้อง" }, 400);
  const courseId = text(body.course_id, 100) || null;
  const global = await globalModerator(c);
  if (courseId) {
    const course = await c.env.DB.prepare("SELECT instructor_id FROM courses WHERE id = ?").bind(courseId).first<{ instructor_id: string }>();
    if (!course) return c.json({ error: "ไม่พบคอร์ส" }, 404);
    if (!global && !(course.instructor_id === user.id && (await currentPermissions(c)).has("community.moderate"))) {
      return c.json({ error: "สร้างห้องได้เฉพาะผู้สอนของคอร์สหรือผู้ดูแลชุมชน" }, 403);
    }
  } else if (!global) {
    return c.json({ error: "สร้างห้องรวมได้เฉพาะผู้ดูแลชุมชน" }, 403);
  }
  const id = newId("space");
  await c.env.DB.prepare(`INSERT INTO community_spaces (id, course_id, name, description, visibility, posting, sort_order, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, courseId, name, text(body.description, 500) || null, courseId ? "course" : "public",
    body.posting === "staff" ? "staff" : "everyone", Number.isInteger(body.sort_order) ? body.sort_order : 0, user.id).run();
  return c.json({ space: await loadSpace(c.env.DB, id) }, 201);
});

communityRouter.patch("/community/spaces/:id", rbac(), async (c) => {
  const space = await loadSpace(c.env.DB, c.req.param("id"));
  if (!space) return c.json({ error: "ไม่พบห้อง" }, 404);
  if (!(await spaceRights(c, space)).canModerate) return c.json({ error: "ไม่มีสิทธิ์แก้ไขห้องนี้" }, 403);
  const body = await readJson(c);
  const name = body.name === undefined ? space.name : text(body.name, 120);
  if (!name) return c.json({ error: "กรุณาตั้งชื่อห้อง" }, 400);
  const description = body.description === undefined ? space.description : (text(body.description, 500) || null);
  const posting = body.posting === "staff" || body.posting === "everyone" ? body.posting : space.posting;
  const archived = body.archived === undefined ? space.archived_at : (body.archived ? (space.archived_at ?? nowIso()) : null);
  await c.env.DB.prepare("UPDATE community_spaces SET name = ?, description = ?, posting = ?, archived_at = ? WHERE id = ?")
    .bind(name, description, posting, archived, space.id).run();
  return c.json({ space: await loadSpace(c.env.DB, space.id) });
});

/** The course's space (created on first use) for enrolled learners, the instructor and staff. */
communityRouter.get("/community/courses/:courseId/space", rbac(), async (c) => {
  const db = c.env.DB;
  const courseId = c.req.param("courseId");
  const course = await db.prepare("SELECT id, title, instructor_id FROM courses WHERE id = ?").bind(courseId).first<{ id: string; title: string; instructor_id: string }>();
  if (!course) return c.json({ error: "ไม่พบคอร์ส" }, 404);
  let space = await db.prepare("SELECT id FROM community_spaces WHERE course_id = ? ORDER BY created_at LIMIT 1").bind(courseId).first<{ id: string }>();
  if (!space) {
    const probe: SpaceRow = { id: "", course_id: courseId, name: "", description: null, visibility: "course", posting: "everyone", sort_order: 0,
      created_by: null, created_at: "", archived_at: null, instructor_id: course.instructor_id, course_title: course.title };
    if (!(await spaceRights(c, probe)).canView) return c.json({ error: "เฉพาะผู้เรียนในคอร์สนี้" }, 403);
    const id = newId("space");
    await db.prepare(`INSERT INTO community_spaces (id, course_id, name, description, visibility, posting, created_by)
      VALUES (?, ?, ?, ?, 'course', 'everyone', ?)`).bind(id, courseId, `ชุมชนคอร์ส ${course.title}`.slice(0, 120), "พูดคุยและถามตอบในคอร์สนี้", course.instructor_id).run();
    space = { id };
  }
  const full = (await loadSpace(db, space.id))!;
  const rights = await spaceRights(c, full);
  if (!rights.canView) return c.json({ error: "เฉพาะผู้เรียนในคอร์สนี้" }, 403);
  return c.json({ space: { ...full, can_moderate: rights.canModerate, can_post: rights.canPost } });
});

// ---------- Posts ----------

const POST_FIELDS = `p.id, p.space_id, p.author_id, u.name AS author_name, p.title, p.body_markdown AS body, p.body_html, p.pinned, p.locked, p.hidden,
  p.created_at, p.updated_at, p.last_activity_at,
  (SELECT COUNT(*) FROM community_comments cm WHERE cm.post_id = p.id AND cm.hidden = 0) AS comment_count,
  (SELECT COUNT(*) FROM community_reactions r WHERE r.target_type = 'post' AND r.target_id = p.id) AS reaction_count,
  (SELECT GROUP_CONCAT(r.reaction) FROM community_reactions r WHERE r.target_type = 'post' AND r.target_id = p.id AND r.user_id = ?) AS my_reactions`;

communityRouter.get("/community/spaces/:id/posts", rbac(), async (c) => {
  const space = await loadSpace(c.env.DB, c.req.param("id"));
  if (!space) return c.json({ error: "ไม่พบห้อง" }, 404);
  const rights = await spaceRights(c, space);
  if (!rights.canView) return c.json({ error: "คุณไม่มีสิทธิ์เข้าห้องนี้" }, 403);
  const user = c.get("user");
  const offset = Math.max(0, Math.min(10000, Number(c.req.query("offset")) || 0));
  const rows = await c.env.DB.prepare(`SELECT ${POST_FIELDS} FROM community_posts p LEFT JOIN users u ON u.id = p.author_id
    WHERE p.space_id = ? AND (p.hidden = 0 OR ? = 1 OR p.author_id = ?)
    ORDER BY p.pinned DESC, p.last_activity_at DESC LIMIT 30 OFFSET ?`).bind(user.id, space.id, rights.canModerate ? 1 : 0, user.id, offset).all();
  const following = await c.env.DB.prepare("SELECT 1 FROM community_follows WHERE target_type = 'space' AND target_id = ? AND user_id = ?").bind(space.id, user.id).first();
  return c.json({
    space: { ...space, can_post: rights.canPost, can_moderate: rights.canModerate, following: !!following },
    posts: rows.results
  });
});

communityRouter.post("/community/spaces/:id/posts", rbac(), async (c) => {
  const db = c.env.DB;
  const space = await loadSpace(db, c.req.param("id"));
  if (!space) return c.json({ error: "ไม่พบห้อง" }, 404);
  const rights = await spaceRights(c, space);
  if (!rights.canView) return c.json({ error: "คุณไม่มีสิทธิ์เข้าห้องนี้" }, 403);
  if (!rights.canPost) return c.json({ error: "ห้องนี้เปิดให้เฉพาะทีมงานโพสต์" }, 403);
  const user = c.get("user");
  if (await rateLimited(c.env.SESSIONS, "community-post", user.id, 10)) return tooManyRequests(c);
  const body = await readJson(c);
  const title = text(body.title, 200);
  const markdown = typeof body.body === "string" ? body.body.slice(0, 20000) : "";
  if (!title || !markdown.trim()) return c.json({ error: "กรุณากรอกหัวข้อและเนื้อหา" }, 400);
  const id = newId("post");
  await db.prepare("INSERT INTO community_posts (id, space_id, author_id, title, body_markdown, body_html) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, space.id, user.id, title, markdown, renderMarkdown(markdown)).run();
  await follow(db, "post", id, user.id);
  await trackEvent(db, user.id, "post_created", { courseId: space.course_id, data: { post_id: id, space_id: space.id } });
  notifyFollowers(c, "space", space.id, user.id, `โพสต์ใหม่ใน ${space.name}`, `${user.name}: ${title}`, `/dashboard?community=${id}`);
  const post = await db.prepare(`SELECT ${POST_FIELDS} FROM community_posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.id = ?`).bind(user.id, id).first();
  return c.json({ post }, 201);
});

communityRouter.get("/community/posts/:id", rbac(), async (c) => {
  const ctx = await postContext(c, c.req.param("id"));
  if (!ctx) return c.json({ error: "ไม่พบโพสต์" }, 404);
  const user = c.get("user");
  const db = c.env.DB;
  const post = await db.prepare(`SELECT ${POST_FIELDS} FROM community_posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.id = ?`).bind(user.id, ctx.post.id).first();
  const comments = await db.prepare(`SELECT cm.id, cm.post_id, cm.author_id, u.name AS author_name, cm.body_markdown AS body, cm.body_html, cm.hidden, cm.created_at,
      (SELECT COUNT(*) FROM community_reactions r WHERE r.target_type = 'comment' AND r.target_id = cm.id) AS reaction_count,
      (SELECT GROUP_CONCAT(r.reaction) FROM community_reactions r WHERE r.target_type = 'comment' AND r.target_id = cm.id AND r.user_id = ?) AS my_reactions
    FROM community_comments cm LEFT JOIN users u ON u.id = cm.author_id
    WHERE cm.post_id = ? AND (cm.hidden = 0 OR ? = 1 OR cm.author_id = ?) ORDER BY cm.created_at LIMIT 500`)
    .bind(user.id, ctx.post.id, ctx.rights.canModerate ? 1 : 0, user.id).all();
  const following = await db.prepare("SELECT 1 FROM community_follows WHERE target_type = 'post' AND target_id = ? AND user_id = ?").bind(ctx.post.id, user.id).first();
  return c.json({
    post: { ...post, following: !!following },
    comments: comments.results,
    space: { id: ctx.space.id, name: ctx.space.name, course_id: ctx.space.course_id, can_moderate: ctx.rights.canModerate, can_post: ctx.rights.canPost }
  });
});

communityRouter.patch("/community/posts/:id", rbac(), async (c) => {
  const ctx = await postContext(c, c.req.param("id"));
  if (!ctx) return c.json({ error: "ไม่พบโพสต์" }, 404);
  if (ctx.post.author_id !== c.get("user").id && !ctx.rights.canModerate) return c.json({ error: "แก้ไขได้เฉพาะโพสต์ของคุณ" }, 403);
  if (ctx.post.locked && !ctx.rights.canModerate) return c.json({ error: "โพสต์นี้ถูกล็อก" }, 409);
  const body = await readJson(c);
  const title = body.title === undefined ? ctx.post.title : text(body.title, 200);
  const markdown = body.body === undefined ? ctx.post.body_markdown : (typeof body.body === "string" ? body.body.slice(0, 20000) : "");
  if (!title || !markdown.trim()) return c.json({ error: "กรุณากรอกหัวข้อและเนื้อหา" }, 400);
  await c.env.DB.prepare("UPDATE community_posts SET title = ?, body_markdown = ?, body_html = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(title, markdown, renderMarkdown(markdown), ctx.post.id).run();
  return c.json({ message: "บันทึกแล้ว" });
});

communityRouter.delete("/community/posts/:id", rbac(), async (c) => {
  const ctx = await postContext(c, c.req.param("id"));
  if (!ctx) return c.json({ error: "ไม่พบโพสต์" }, 404);
  if (ctx.post.author_id !== c.get("user").id && !ctx.rights.canModerate) return c.json({ error: "ลบได้เฉพาะโพสต์ของคุณ" }, 403);
  const db = c.env.DB;
  await db.batch([
    db.prepare("DELETE FROM community_reactions WHERE (target_type = 'post' AND target_id = ?) OR (target_type = 'comment' AND target_id IN (SELECT id FROM community_comments WHERE post_id = ?))").bind(ctx.post.id, ctx.post.id),
    db.prepare("DELETE FROM community_follows WHERE target_type = 'post' AND target_id = ?").bind(ctx.post.id),
    db.prepare("UPDATE community_reports SET status = 'resolved', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP WHERE status = 'open' AND ((target_type = 'post' AND target_id = ?) OR (target_type = 'comment' AND target_id IN (SELECT id FROM community_comments WHERE post_id = ?)))")
      .bind(c.get("user").id, ctx.post.id, ctx.post.id),
    db.prepare("DELETE FROM community_posts WHERE id = ?").bind(ctx.post.id)
  ]);
  return c.json({ message: "ลบโพสต์แล้ว" });
});

/** { pinned?, locked?, hidden? } — moderators of the space only. */
communityRouter.post("/community/posts/:id/moderate", rbac(), async (c) => {
  const ctx = await postContext(c, c.req.param("id"));
  if (!ctx) return c.json({ error: "ไม่พบโพสต์" }, 404);
  if (!ctx.rights.canModerate) return c.json({ error: "เฉพาะผู้ดูแลชุมชนของห้องนี้" }, 403);
  const body = await readJson(c);
  const flag = (key: "pinned" | "locked" | "hidden") => typeof body[key] === "boolean" ? (body[key] ? 1 : 0) : ctx.post[key];
  const next = { pinned: flag("pinned"), locked: flag("locked"), hidden: flag("hidden") };
  await c.env.DB.prepare("UPDATE community_posts SET pinned = ?, locked = ?, hidden = ? WHERE id = ?").bind(next.pinned, next.locked, next.hidden, ctx.post.id).run();
  return c.json({ post: { id: ctx.post.id, ...next }, message: "อัปเดตโพสต์แล้ว" });
});

// ---------- Comments ----------

communityRouter.post("/community/posts/:id/comments", rbac(), async (c) => {
  const ctx = await postContext(c, c.req.param("id"));
  if (!ctx) return c.json({ error: "ไม่พบโพสต์" }, 404);
  const user = c.get("user");
  if (ctx.space.archived_at) return c.json({ error: "ห้องนี้ถูกปิดแล้ว" }, 409);
  if ((ctx.post.locked || ctx.post.hidden) && !ctx.rights.canModerate) return c.json({ error: "โพสต์นี้ปิดการแสดงความคิดเห็น" }, 409);
  if (await rateLimited(c.env.SESSIONS, "community-comment", user.id, 30)) return tooManyRequests(c);
  const body = await readJson(c);
  const markdown = typeof body.body === "string" ? body.body.slice(0, 5000) : "";
  if (!markdown.trim()) return c.json({ error: "กรุณาพิมพ์ความคิดเห็น" }, 400);
  const db = c.env.DB;
  const id = newId("cmt");
  await db.batch([
    db.prepare("INSERT INTO community_comments (id, post_id, author_id, body_markdown, body_html) VALUES (?, ?, ?, ?, ?)").bind(id, ctx.post.id, user.id, markdown, renderMarkdown(markdown)),
    db.prepare("UPDATE community_posts SET last_activity_at = CURRENT_TIMESTAMP, comment_count = comment_count + 1 WHERE id = ?").bind(ctx.post.id),
    db.prepare("INSERT OR IGNORE INTO community_follows (target_type, target_id, user_id) VALUES ('post', ?, ?)").bind(ctx.post.id, user.id)
  ]);
  notifyFollowers(c, "post", ctx.post.id, user.id, `ความคิดเห็นใหม่: ${ctx.post.title}`.slice(0, 200), `${user.name}: ${markdownToText(markdown, 200)}`, `/dashboard?community=${ctx.post.id}`);
  return c.json({ comment: { id, post_id: ctx.post.id, author_id: user.id, author_name: user.name, body: markdown, body_html: renderMarkdown(markdown), hidden: 0, created_at: nowIso() } }, 201);
});

async function commentContext(c: Context<Env>, commentId: string) {
  const comment = await c.env.DB.prepare("SELECT * FROM community_comments WHERE id = ?").bind(commentId)
    .first<{ id: string; post_id: string; author_id: string | null; hidden: number }>();
  if (!comment) return null;
  const ctx = await postContext(c, comment.post_id);
  if (!ctx) return null;
  if (comment.hidden && !ctx.rights.canModerate && comment.author_id !== c.get("user").id) return null;
  return { comment, ...ctx };
}

communityRouter.delete("/community/comments/:id", rbac(), async (c) => {
  const ctx = await commentContext(c, c.req.param("id"));
  if (!ctx) return c.json({ error: "ไม่พบความคิดเห็น" }, 404);
  if (ctx.comment.author_id !== c.get("user").id && !ctx.rights.canModerate) return c.json({ error: "ลบได้เฉพาะความคิดเห็นของคุณ" }, 403);
  const db = c.env.DB;
  await db.batch([
    db.prepare("DELETE FROM community_reactions WHERE target_type = 'comment' AND target_id = ?").bind(ctx.comment.id),
    db.prepare("DELETE FROM community_comments WHERE id = ?").bind(ctx.comment.id),
    db.prepare("UPDATE community_posts SET comment_count = MAX(comment_count - 1, 0) WHERE id = ?").bind(ctx.comment.post_id)
  ]);
  return c.json({ message: "ลบความคิดเห็นแล้ว" });
});

communityRouter.post("/community/comments/:id/moderate", rbac(), async (c) => {
  const ctx = await commentContext(c, c.req.param("id"));
  if (!ctx) return c.json({ error: "ไม่พบความคิดเห็น" }, 404);
  if (!ctx.rights.canModerate) return c.json({ error: "เฉพาะผู้ดูแลชุมชนของห้องนี้" }, 403);
  const body = await readJson(c);
  if (typeof body.hidden !== "boolean") return c.json({ error: "กรุณาระบุการซ่อน" }, 400);
  await c.env.DB.prepare("UPDATE community_comments SET hidden = ? WHERE id = ?").bind(body.hidden ? 1 : 0, ctx.comment.id).run();
  return c.json({ comment: { id: ctx.comment.id, hidden: body.hidden ? 1 : 0 }, message: body.hidden ? "ซ่อนความคิดเห็นแล้ว" : "แสดงความคิดเห็นแล้ว" });
});

// ---------- Reactions, follows, reports ----------

async function targetContext(c: Context<Env>, targetType: unknown, targetId: unknown) {
  if (typeof targetId !== "string") return null;
  if (targetType === "post") return postContext(c, targetId);
  if (targetType === "comment") return commentContext(c, targetId);
  return null;
}

/** Toggles a reaction. */
communityRouter.post("/community/reactions", rbac(), async (c) => {
  const body = await readJson(c);
  if (!REACTIONS.includes(body.reaction)) return c.json({ error: "รีแอกชันไม่ถูกต้อง" }, 400);
  const ctx = await targetContext(c, body.target_type, body.target_id);
  if (!ctx) return c.json({ error: "ไม่พบเนื้อหา" }, 404);
  const user = c.get("user");
  if (await rateLimited(c.env.SESSIONS, "community-react", user.id, 120)) return tooManyRequests(c);
  const db = c.env.DB;
  const removed = await db.prepare("DELETE FROM community_reactions WHERE target_type = ? AND target_id = ? AND user_id = ? AND reaction = ?")
    .bind(body.target_type, body.target_id, user.id, body.reaction).run();
  if (!removed.meta.changes) {
    await db.prepare("INSERT OR IGNORE INTO community_reactions (target_type, target_id, user_id, reaction) VALUES (?, ?, ?, ?)")
      .bind(body.target_type, body.target_id, user.id, body.reaction).run();
  }
  const count = await db.prepare("SELECT COUNT(*) AS n FROM community_reactions WHERE target_type = ? AND target_id = ?").bind(body.target_type, body.target_id).first<{ n: number }>();
  return c.json({ reacted: !removed.meta.changes, count: count?.n ?? 0 });
});

communityRouter.post("/community/follow", rbac(), async (c) => {
  const body = await readJson(c);
  const user = c.get("user");
  const db = c.env.DB;
  if (body.target_type === "space") {
    const space = typeof body.target_id === "string" ? await loadSpace(db, body.target_id) : null;
    if (!space || !(await spaceRights(c, space)).canView) return c.json({ error: "ไม่พบห้อง" }, 404);
  } else if (body.target_type === "post") {
    if (!(await postContext(c, String(body.target_id ?? "")))) return c.json({ error: "ไม่พบโพสต์" }, 404);
  } else {
    return c.json({ error: "กรุณาระบุสิ่งที่ต้องการติดตาม" }, 400);
  }
  if (body.follow === false) {
    await db.prepare("DELETE FROM community_follows WHERE target_type = ? AND target_id = ? AND user_id = ?").bind(body.target_type, body.target_id, user.id).run();
  } else {
    await follow(db, body.target_type, body.target_id, user.id);
  }
  return c.json({ following: body.follow !== false });
});

communityRouter.post("/community/reports", rbac(), async (c) => {
  const body = await readJson(c);
  const reason = text(body.reason, 1000);
  if (!reason) return c.json({ error: "กรุณาระบุเหตุผลที่รายงาน" }, 400);
  const ctx = await targetContext(c, body.target_type, body.target_id);
  if (!ctx) return c.json({ error: "ไม่พบเนื้อหา" }, 404);
  const user = c.get("user");
  if (await rateLimited(c.env.SESSIONS, "community-report", user.id, 20)) return tooManyRequests(c);
  const id = newId("rpt");
  try {
    await c.env.DB.prepare("INSERT INTO community_reports (id, target_type, target_id, space_id, reporter_id, reason) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, body.target_type, body.target_id, ctx.space.id, user.id, reason).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) return c.json({ error: "คุณรายงานเนื้อหานี้ไปแล้ว ทีมงานกำลังตรวจสอบ" }, 409);
    throw error;
  }
  return c.json({ report: { id, status: "open" }, message: "ส่งรายงานแล้ว ขอบคุณที่ช่วยดูแลชุมชน" }, 201);
});

/** Open reports: everything for global moderators, own courses' spaces for instructors. */
communityRouter.get("/community/reports", rbac(), async (c) => {
  const perms = await currentPermissions(c);
  if (!perms.has("community.moderate")) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const user = c.get("user");
  const global = isStaff(user);
  const status = ["open", "resolved", "dismissed"].includes(c.req.query("status") || "") ? c.req.query("status")! : "open";
  const rows = await c.env.DB.prepare(`SELECT r.*, ru.name AS reporter_name, s.name AS space_name,
      CASE r.target_type WHEN 'post' THEN (SELECT p.title FROM community_posts p WHERE p.id = r.target_id)
        ELSE (SELECT substr(cm.body_markdown, 1, 200) FROM community_comments cm WHERE cm.id = r.target_id) END AS target_excerpt,
      CASE r.target_type WHEN 'post' THEN (SELECT p.hidden FROM community_posts p WHERE p.id = r.target_id)
        ELSE (SELECT cm.hidden FROM community_comments cm WHERE cm.id = r.target_id) END AS target_hidden,
      CASE r.target_type WHEN 'post' THEN r.target_id ELSE (SELECT cm.post_id FROM community_comments cm WHERE cm.id = r.target_id) END AS post_id
    FROM community_reports r LEFT JOIN users ru ON ru.id = r.reporter_id
    LEFT JOIN community_spaces s ON s.id = r.space_id LEFT JOIN courses co ON co.id = s.course_id
    WHERE r.status = ? AND (? = 1 OR co.instructor_id = ?) ORDER BY r.created_at DESC LIMIT 200`).bind(status, global ? 1 : 0, user.id).all();
  return c.json({ reports: rows.results });
});

/** { status: "resolved" | "dismissed", hide?: boolean } */
communityRouter.patch("/community/reports/:id", rbac(), async (c) => {
  const db = c.env.DB;
  const report = await db.prepare("SELECT * FROM community_reports WHERE id = ?").bind(c.req.param("id"))
    .first<{ id: string; target_type: string; target_id: string; space_id: string | null; status: string }>();
  if (!report) return c.json({ error: "ไม่พบรายงาน" }, 404);
  const space = report.space_id ? await loadSpace(db, report.space_id) : null;
  if (!space || !(await spaceRights(c, space)).canModerate) return c.json({ error: "เฉพาะผู้ดูแลชุมชนของห้องนี้" }, 403);
  const body = await readJson(c);
  if (body.status !== "resolved" && body.status !== "dismissed") return c.json({ error: "สถานะไม่ถูกต้อง" }, 400);
  const statements = [db.prepare("UPDATE community_reports SET status = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?").bind(body.status, c.get("user").id, report.id)];
  if (body.hide === true) {
    statements.push(report.target_type === "post"
      ? db.prepare("UPDATE community_posts SET hidden = 1 WHERE id = ?").bind(report.target_id)
      : db.prepare("UPDATE community_comments SET hidden = 1 WHERE id = ?").bind(report.target_id));
  }
  await db.batch(statements);
  return c.json({ message: body.hide ? "ซ่อนเนื้อหาและปิดรายงานแล้ว" : "ปิดรายงานแล้ว" });
});

// ---------- Images (posts) ----------

const IMAGE_TYPES: Record<string, { ext: string; magic: number[] }> = {
  "image/png": { ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  "image/jpeg": { ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  "image/gif": { ext: "gif", magic: [0x47, 0x49, 0x46, 0x38] },
  "image/webp": { ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] }
};
const MAX_IMAGE = 5 * 1024 * 1024;

async function readImage(c: Context<Env>): Promise<{ bytes: Uint8Array; type: string; ext: string } | string> {
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!(file instanceof File)) return "กรุณาเลือกไฟล์รูปภาพ";
  const type = IMAGE_TYPES[file.type];
  if (!type) return "รองรับเฉพาะไฟล์ PNG, JPG, WEBP หรือ GIF";
  if (file.size > MAX_IMAGE) return "ไฟล์รูปต้องไม่เกิน 5 MB";
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!type.magic.every((byte, i) => bytes[i] === byte)) return "ไฟล์ไม่ใช่รูปภาพตามชนิดที่ระบุ";
  return { bytes, type: file.type, ext: type.ext };
}

/** Post images are public by unguessable URL (they are embedded with <img>). */
communityRouter.post("/community/images", rbac(), async (c) => {
  const user = c.get("user");
  if (await rateLimited(c.env.SESSIONS, "community-image", user.id, 20)) return tooManyRequests(c);
  const image = await readImage(c);
  if (typeof image === "string") return c.json({ error: image }, 400);
  const name = `${crypto.randomUUID().replace(/-/g, "")}.${image.ext}`;
  await c.env.ASSETS.put(`community/${name}`, image.bytes, { httpMetadata: { contentType: image.type }, customMetadata: { user_id: user.id } });
  return c.json({ url: `${new URL(c.req.url).origin}/api/community/images/${name}` }, 201);
});

communityRouter.get("/community/images/:name", async (c) => {
  const name = c.req.param("name");
  if (!/^[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(name)) return c.json({ error: "ไม่พบรูปภาพ" }, 404);
  const object = await c.env.ASSETS.get(`community/${name}`);
  if (!object) return c.json({ error: "ไม่พบรูปภาพ" }, 404);
  c.header("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  c.header("X-Content-Type-Options", "nosniff");
  return c.body(object.body);
});

// ---------- Direct messages ----------

const STAFF_ROLES: Role[] = ["admin", "coordinator", "instructor"];
const hasStaffRole = (roles: readonly Role[]) => roles.some(r => STAFF_ROLES.includes(r));
/** Admins and coordinators may contact anyone; instructors only their own learners and other staff. */
const isOfficeStaff = (roles: readonly Role[]) => roles.includes("admin") || roles.includes("coordinator");

/** Learners (active/completed enrollment) in courses taught by `instructorId`. */
const OWN_LEARNERS_SQL = `SELECT e.user_id FROM enrollments e JOIN courses co ON co.id = e.course_id
  WHERE co.instructor_id = ? AND e.status IN ('active', 'completed')`;

async function accountOf(db: D1Database, userId: string) {
  const row = await db.prepare(`SELECT u.id, u.name, u.status, COALESCE(u.staff_role, u.role) AS primary_role, ${rolesColumn("u")} AS role_list FROM users u WHERE u.id = ?`)
    .bind(userId).first<{ id: string; name: string; status: string; primary_role: string; role_list: string | null }>();
  return row ? { id: row.id, name: row.name, status: row.status, roles: parseRoles(row.role_list, row.primary_role) } : null;
}

/** Null when `me` may open a thread with `otherId`, else the reason (Thai). */
async function startThreadError(db: D1Database, me: UserPayload, otherId: string): Promise<string | null> {
  if (otherId === me.id) return "ส่งข้อความหาตัวเองไม่ได้";
  const other = await accountOf(db, otherId);
  if (!other || other.status !== "active") return "ไม่พบผู้ใช้";
  if (isOfficeStaff(me.roles)) return null;
  if (me.roles.includes("instructor")) {
    if (hasStaffRole(other.roles)) return null;
    const ownLearner = await db.prepare(`SELECT 1 FROM (${OWN_LEARNERS_SQL}) WHERE user_id = ? LIMIT 1`).bind(me.id, otherId).first();
    if (ownLearner) return null;
    // An instructor who also studies falls through to the learner rules below.
  }
  if (other.roles.includes("admin") || other.roles.includes("coordinator")) return null;
  if (other.roles.includes("instructor")) {
    const teaches = await db.prepare(`SELECT 1 FROM enrollments e JOIN courses co ON co.id = e.course_id
      WHERE e.user_id = ? AND co.instructor_id = ? AND e.status IN ('active', 'completed') LIMIT 1`).bind(me.id, otherId).first();
    return teaches ? null : "ส่งข้อความได้เฉพาะผู้สอนของคอร์สที่คุณเรียน";
  }
  return (await getSetting(db, "dm_learner_to_learner", "0")) === "1" ? null : "ระบบไม่อนุญาตให้ผู้เรียนส่งข้อความหากันโดยตรง";
}

interface ThreadRow { id: string; user1_id: string; user2_id: string; created_at: string; last_message_at: string | null; user1_read_at: string | null; user2_read_at: string | null }

async function threadFor(c: Context<Env>): Promise<ThreadRow | null> {
  const me = c.get("user").id;
  const thread = await c.env.DB.prepare("SELECT * FROM dm_threads WHERE id = ?").bind(c.req.param("id")).first<ThreadRow>();
  return thread && (thread.user1_id === me || thread.user2_id === me) ? thread : null;
}

const otherOf = (thread: ThreadRow, me: string) => thread.user1_id === me ? thread.user2_id : thread.user1_id;

const THREAD_LIST = `SELECT t.id, t.created_at, t.last_message_at,
    CASE WHEN t.user1_id = ?1 THEN t.user2_id ELSE t.user1_id END AS other_id, ou.name AS other_name,
    COALESCE(ou.staff_role, ou.role) AS other_role,
    (SELECT m.body FROM dm_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
    (SELECT COUNT(*) FROM dm_messages m WHERE m.thread_id = t.id AND m.sender_id <> ?1
      AND m.created_at > COALESCE(CASE WHEN t.user1_id = ?1 THEN t.user1_read_at ELSE t.user2_read_at END, '')) AS unread_count
  FROM dm_threads t JOIN users ou ON ou.id = CASE WHEN t.user1_id = ?1 THEN t.user2_id ELSE t.user1_id END
  WHERE (t.user1_id = ?1 OR t.user2_id = ?1)`;

communityRouter.get("/inbox/threads", rbac(), async (c) => {
  const rows = await c.env.DB.prepare(`${THREAD_LIST} ORDER BY COALESCE(t.last_message_at, t.created_at) DESC LIMIT 100`).bind(c.get("user").id).all<{ unread_count: number }>();
  return c.json({ threads: rows.results, unread: rows.results.reduce((n, t) => n + (t.unread_count || 0), 0) });
});

communityRouter.get("/inbox/unread", rbac(), async (c) => {
  const me = c.get("user").id;
  const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM dm_messages m JOIN dm_threads t ON t.id = m.thread_id
    WHERE (t.user1_id = ?1 OR t.user2_id = ?1) AND m.sender_id <> ?1
      AND m.created_at > COALESCE(CASE WHEN t.user1_id = ?1 THEN t.user1_read_at ELSE t.user2_read_at END, '')`).bind(me).first<{ n: number }>();
  return c.json({ unread: row?.n ?? 0 });
});

/**
 * People the user may message: admins/coordinators search everyone (?q=, with email); instructors search
 * learners of their own courses and staff (no email); learners get their instructors and the staff team.
 */
communityRouter.get("/inbox/contacts", rbac(), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const q = text(c.req.query("q"), 100);
  if (hasStaffRole(user.roles)) {
    if (q.length < 2) return c.json({ contacts: [] });
    const like = `%${q.replace(/[%_\\]/g, ch => "\\" + ch)}%`;
    if (isOfficeStaff(user.roles)) {
      const rows = await db.prepare(`SELECT id, name, email, COALESCE(staff_role, role) AS role FROM users
        WHERE status = 'active' AND id <> ? AND (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\') ORDER BY name LIMIT 20`).bind(user.id, like, like).all();
      return c.json({ contacts: rows.results });
    }
    const rows = await db.prepare(`SELECT u.id, u.name, COALESCE(u.staff_role, u.role) AS role FROM users u
      WHERE u.status = 'active' AND u.id <> ? AND u.name LIKE ? ESCAPE '\\'
        AND (u.id IN (${OWN_LEARNERS_SQL}) OR u.id IN (SELECT user_id FROM user_roles WHERE role IN ('admin', 'coordinator', 'instructor')))
      ORDER BY u.name LIMIT 20`).bind(user.id, like, user.id).all();
    return c.json({ contacts: rows.results });
  }
  const rows = await db.prepare(`SELECT DISTINCT u.id, u.name, 'instructor' AS role, co.title AS context FROM enrollments e
      JOIN courses co ON co.id = e.course_id JOIN users u ON u.id = co.instructor_id
      WHERE e.user_id = ? AND e.status IN ('active', 'completed') AND u.status = 'active'
    UNION SELECT u.id, u.name, r.role, 'ทีมงาน' AS context FROM user_roles r JOIN users u ON u.id = r.user_id
      WHERE r.role IN ('coordinator') AND u.status = 'active'
    LIMIT 50`).bind(user.id).all<{ id: string }>();
  const seen = new Set<string>();
  return c.json({ contacts: rows.results.filter(r => r.id !== user.id && !seen.has(r.id) && !!seen.add(r.id)) });
});

/** { user_id, body? } — opens (or reuses) the 1:1 thread; staff use it to start a conversation from a user's profile. */
communityRouter.post("/inbox/threads", rbac(), async (c) => {
  const me = c.get("user");
  const body = await readJson(c);
  const otherId = text(body.user_id, 100);
  if (!otherId) return c.json({ error: "กรุณาเลือกผู้รับ" }, 400);
  const db = c.env.DB;
  const [a, b] = [me.id, otherId].sort();
  let thread = await db.prepare("SELECT * FROM dm_threads WHERE user1_id = ? AND user2_id = ?").bind(a, b).first<ThreadRow>();
  if (!thread) {
    const reason = await startThreadError(db, me, otherId);
    if (reason) return c.json({ error: reason }, 403);
    await db.prepare("INSERT OR IGNORE INTO dm_threads (id, user1_id, user2_id, created_by) VALUES (?, ?, ?, ?)").bind(newId("dm"), a, b, me.id).run();
    thread = await db.prepare("SELECT * FROM dm_threads WHERE user1_id = ? AND user2_id = ?").bind(a, b).first<ThreadRow>();
  }
  return c.json({ thread: { id: thread!.id, other_id: otherId } }, 201);
});

async function mayMessage(db: D1Database, me: UserPayload, thread: ThreadRow): Promise<string | null> {
  if (hasStaffRole(me.roles)) return null;
  const other = await accountOf(db, otherOf(thread, me.id));
  if (!other || other.status !== "active") return "ผู้รับไม่ได้ใช้งานบัญชีนี้แล้ว";
  if (hasStaffRole(other.roles)) return null;
  return (await getSetting(db, "dm_learner_to_learner", "0")) === "1" ? null : "ระบบไม่อนุญาตให้ผู้เรียนส่งข้อความหากันโดยตรง";
}

async function markRead(db: D1Database, thread: ThreadRow, me: string) {
  const column = thread.user1_id === me ? "user1_read_at" : "user2_read_at";
  await db.prepare(`UPDATE dm_threads SET ${column} = ? WHERE id = ?`).bind(nowIso(), thread.id).run();
}

communityRouter.get("/inbox/threads/:id/messages", rbac(), async (c) => {
  const thread = await threadFor(c);
  if (!thread) return c.json({ error: "ไม่พบบทสนทนา" }, 404);
  const me = c.get("user");
  const rows = await c.env.DB.prepare(`SELECT * FROM (SELECT m.id, m.sender_id, u.name AS sender_name, m.body, m.attachment_type, m.attachment_key IS NOT NULL AS has_attachment, m.created_at
    FROM dm_messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.thread_id = ? ORDER BY m.created_at DESC LIMIT 200) ORDER BY created_at`).bind(thread.id).all();
  await markRead(c.env.DB, thread, me.id);
  const other = await accountOf(c.env.DB, otherOf(thread, me.id));
  return c.json({
    thread: { id: thread.id, other: other ? { id: other.id, name: other.name, roles: other.roles } : null, can_reply: !(await mayMessage(c.env.DB, me, thread)) },
    messages: rows.results
  });
});

communityRouter.post("/inbox/threads/:id/read", rbac(), async (c) => {
  const thread = await threadFor(c);
  if (!thread) return c.json({ error: "ไม่พบบทสนทนา" }, 404);
  await markRead(c.env.DB, thread, c.get("user").id);
  return c.json({ success: true });
});

/** JSON { body } or multipart (body, file: image ≤ 5 MB stored privately in R2). */
communityRouter.post("/inbox/threads/:id/messages", rbac(), async (c) => {
  const thread = await threadFor(c);
  if (!thread) return c.json({ error: "ไม่พบบทสนทนา" }, 404);
  const me = c.get("user");
  const db = c.env.DB;
  const reason = await mayMessage(db, me, thread);
  if (reason) return c.json({ error: reason }, 403);
  const limit = hasStaffRole(me.roles) ? 200 : 20;
  if (await rateLimited(c.env.SESSIONS, "dm", me.id, limit)) return tooManyRequests(c);

  let message = "";
  let attachment: { bytes: Uint8Array; type: string; ext: string } | null = null;
  if ((c.req.header("Content-Type") || "").includes("multipart/form-data")) {
    const form = await c.req.parseBody().catch(() => null);
    message = typeof form?.body === "string" ? form.body.trim().slice(0, 5000) : "";
    if (form?.file instanceof File) {
      const type = IMAGE_TYPES[form.file.type];
      if (!type) return c.json({ error: "แนบได้เฉพาะรูป PNG, JPG, WEBP หรือ GIF" }, 400);
      if (form.file.size > MAX_IMAGE) return c.json({ error: "ไฟล์แนบต้องไม่เกิน 5 MB" }, 400);
      const bytes = new Uint8Array(await form.file.arrayBuffer());
      if (!type.magic.every((byte, i) => bytes[i] === byte)) return c.json({ error: "ไฟล์ไม่ใช่รูปภาพตามชนิดที่ระบุ" }, 400);
      attachment = { bytes, type: form.file.type, ext: type.ext };
    }
  } else {
    const body = await readJson(c);
    message = text(body.body, 5000);
  }
  if (!message && !attachment) return c.json({ error: "กรุณาพิมพ์ข้อความ" }, 400);

  const id = newId("msg");
  let key: string | null = null;
  if (attachment) {
    key = `dm/${thread.id}/${crypto.randomUUID().replace(/-/g, "")}.${attachment.ext}`;
    await c.env.ASSETS.put(key, attachment.bytes, { httpMetadata: { contentType: attachment.type } });
  }
  const created = nowIso();
  const otherId = otherOf(thread, me.id);
  const otherRead = thread.user1_id === otherId ? thread.user1_read_at : thread.user2_read_at;
  // Notify only on the first unread message, so a burst of messages is one notification.
  const notify = !thread.last_message_at || (!!otherRead && otherRead >= thread.last_message_at);
  await db.batch([
    db.prepare("INSERT INTO dm_messages (id, thread_id, sender_id, body, attachment_key, attachment_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, thread.id, me.id, message, key, attachment?.type ?? null, created),
    db.prepare(`UPDATE dm_threads SET last_message_at = ?, ${thread.user1_id === me.id ? "user1_read_at" : "user2_read_at"} = ? WHERE id = ?`).bind(created, created, thread.id)
  ]);
  if (notify) {
    const env = commEnv(c);
    runLater(c, createNotification(db, otherId, `ข้อความใหม่จาก ${me.name}`, message ? markdownToText(message, 200) : "ส่งรูปภาพ",
      { env, link: `/dashboard?inbox=${thread.id}`, category: "message", channels: ["push", "line"] }), "DM notification");
  }
  return c.json({ message: { id, sender_id: me.id, sender_name: me.name, body: message, attachment_type: attachment?.type ?? null, has_attachment: attachment ? 1 : 0, created_at: created } }, 201);
});

communityRouter.get("/inbox/messages/:id/attachment", rbac(), async (c) => {
  const me = c.get("user").id;
  const row = await c.env.DB.prepare(`SELECT m.attachment_key, m.attachment_type FROM dm_messages m JOIN dm_threads t ON t.id = m.thread_id
    WHERE m.id = ? AND (t.user1_id = ? OR t.user2_id = ?)`).bind(c.req.param("id"), me, me).first<{ attachment_key: string | null; attachment_type: string | null }>();
  if (!row?.attachment_key) return c.json({ error: "ไม่พบไฟล์แนบ" }, 404);
  const object = await c.env.ASSETS.get(row.attachment_key);
  if (!object) return c.json({ error: "ไม่พบไฟล์แนบ" }, 404);
  c.header("Content-Type", row.attachment_type || object.httpMetadata?.contentType || "application/octet-stream");
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Disposition", "inline");
  return c.body(object.body);
});
