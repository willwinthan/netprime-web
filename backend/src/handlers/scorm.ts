import { Hono, Context } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { allowedOrigins } from "../utils/origins";
import { trackEvent } from "../utils/events";
import { readZipEntries, readZipEntry, r2RangeReader, safeEntryPath, ZipEntry, ZipError } from "../utils/zip";
import { activeEnrollmentId, completeLesson, isCourseStaff, lessonGateFor, lessonLockResponse } from "../utils/courseContent";

/**
 * SCORM 1.2 (basic). Instructors upload a .zip; the Worker unzips it into R2 under
 * scorm/<lessonId>/<uploadId>/ and reads the launch page from imsmanifest.xml. Learners open
 * /api/scorm/<lessonId>/<launch token>/player: our own page that defines window.API (LMSInitialize,
 * LMSGetValue, LMSSetValue, LMSCommit, LMSFinish…) and frames the package from the same origin, so
 * the SCO finds the API in its parent. Package files are served from that path (never a public R2
 * URL); the launch token in the path is an HMAC of user, lesson and expiry.
 */
export const scormRouter = new Hono<Env>();

const PACKAGE_LIMIT = 100 * 1024 * 1024;
// A Worker has 128 MB; extracting one entry holds its compressed and inflated bytes (plus the 8 MB read window),
// so a single file is capped at 20 MB. Files are extracted one at a time, so the total only bounds R2 use / CPU.
const ZIP_LIMITS = { maxEntries: 1000, maxEntryBytes: 20 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024 };
const MAX_FILES = 600;
const LAUNCH_TTL_SECONDS = 8 * 60 * 60;

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", xhtml: "application/xhtml+xml",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  json: "application/json", xml: "application/xml", xsd: "application/xml", dtd: "application/xml-dtd",
  txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8", vtt: "text/vtt", srt: "text/plain; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon", bmp: "image/bmp",
  mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject",
  pdf: "application/pdf", swf: "application/x-shockwave-flash", wasm: "application/wasm"
};
const contentTypeFor = (path: string) => CONTENT_TYPES[(path.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase()] || "application/octet-stream";

// ---------- Launch tokens ----------

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const textBytes = (text: string) => new TextEncoder().encode(text);

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", textBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, textBytes(message))));
}

async function launchToken(secret: string, lessonId: string, userId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + LAUNCH_TTL_SECONDS;
  return `${b64url(textBytes(userId))}.${exp}.${await hmac(secret, `scorm|${lessonId}|${userId}|${exp}`)}`;
}

/** Returns the user id of a valid, unexpired launch token for this lesson, or null. */
async function verifyLaunchToken(secret: string | undefined, lessonId: string, token: string): Promise<string | null> {
  if (!secret || secret.length < 32) return null;
  const [user, exp, sig] = token.split(".");
  if (!user || !exp || !sig || !/^\d{1,12}$/.test(exp) || Number(exp) <= Date.now() / 1000) return null;
  let userId: string;
  try { userId = new TextDecoder().decode(Uint8Array.from(atob(user.replace(/-/g, "+").replace(/_/g, "/")), ch => ch.charCodeAt(0))); }
  catch { return null; }
  const expected = await hmac(secret, `scorm|${lessonId}|${userId}|${exp}`);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? userId : null;
}

// ---------- imsmanifest.xml ----------

interface XmlNode { name: string; attrs: Record<string, string>; children: XmlNode[] }

const decodeEntities = (value: string) => value
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([\da-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");

/** Tiny element-tree parser (names and attributes only, namespace prefixes dropped, lowercased). */
function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  const cleaned = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<[?!][\s\S]*?>/g, "");
  const tag = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const attr = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const local = (name: string) => name.split(":").pop()!.toLowerCase();
  let match: RegExpExecArray | null;
  while ((match = tag.exec(cleaned))) {
    const [, closing, rawName, rawAttrs, selfClosing] = match;
    const name = local(rawName);
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === name) { stack.length = i; break; }
      continue;
    }
    const node: XmlNode = { name, attrs: {}, children: [] };
    let a: RegExpExecArray | null;
    attr.lastIndex = 0;
    while ((a = attr.exec(rawAttrs))) node.attrs[local(a[1])] = decodeEntities(a[2] ?? a[3] ?? "");
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

const findAll = (node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] => {
  for (const child of node.children) {
    if (child.name === name) out.push(child);
    findAll(child, name, out);
  }
  return out;
};

const joinBase = (...parts: (string | undefined)[]) => parts.filter(Boolean).join("");

/**
 * Launch href (relative to the package root, may carry a query) of the default organization's
 * first item with a resource, falling back to the first SCO / resource with an href.
 */
export function scormLaunchHref(xml: string): { href: string } | { error: string } {
  const doc = parseXml(xml);
  const version = findAll(doc, "schemaversion")[0];
  if (/2004|cam\s*1\.3/i.test(xml.match(/<(?:\w+:)?schemaversion>([^<]*)</i)?.[1] || "") || (version && /2004/.test(JSON.stringify(version.attrs))))
    return { error: "รองรับเฉพาะแพ็กเกจ SCORM 1.2 (แพ็กเกจนี้เป็น SCORM 2004)" };
  const manifest = findAll(doc, "manifest")[0];
  const resourcesNode = findAll(doc, "resources")[0];
  const resources = resourcesNode ? resourcesNode.children.filter(n => n.name === "resource") : [];
  const resourceBase = joinBase(manifest?.attrs.base, resourcesNode?.attrs.base);
  const hrefOf = (resource: XmlNode, parameters?: string) => {
    if (!resource.attrs.href) return null;
    let href = joinBase(resourceBase, resource.attrs.base, resource.attrs.href);
    if (parameters) href += (href.includes("?") ? "&" : "?") + parameters.replace(/^[?&]/, "");
    return href;
  };

  const organizationsNode = findAll(doc, "organizations")[0];
  const organizations = organizationsNode ? organizationsNode.children.filter(n => n.name === "organization") : [];
  const organization = organizations.find(o => o.attrs.identifier === organizationsNode?.attrs.default) || organizations[0];
  if (organization) {
    for (const item of findAll(organization, "item")) {
      const resource = item.attrs.identifierref && resources.find(r => r.attrs.identifier === item.attrs.identifierref);
      const href = resource && hrefOf(resource, item.attrs.parameters);
      if (href) return { href };
    }
  }
  const sco = resources.find(r => (r.attrs.scormtype || "").toLowerCase() === "sco" && r.attrs.href) || resources.find(r => r.attrs.href);
  const href = sco && hrefOf(sco);
  return href ? { href } : { error: "ไม่พบหน้าเริ่มต้น (launch) ใน imsmanifest.xml" };
}

// ---------- Upload ----------

async function deletePrefix(bucket: R2Bucket, prefix: string, keep?: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = listed.objects.map(o => o.key).filter(k => !keep || !k.startsWith(keep));
    if (keys.length) await bucket.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

/**
 * Unzips a stored package into `base`. Every entry path is checked before anything is written,
 * so a zip-slip or oversized package leaves no files behind. Returns the launch href.
 */
async function extractPackage(bucket: R2Bucket, zipKey: string, size: number, base: string): Promise<string> {
  const reader = r2RangeReader(bucket, zipKey, size);
  const entries = await readZipEntries(reader, ZIP_LIMITS);
  const files: { entry: ZipEntry; path: string }[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const path = safeEntryPath(entry.name);
    if (!path) throw new ZipError(`แพ็กเกจมีชื่อไฟล์ที่ไม่ปลอดภัย: ${entry.name.slice(0, 120)}`);
    if (entry.isDirectory) continue;
    if (seen.has(path.toLowerCase())) throw new ZipError(`แพ็กเกจมีไฟล์ชื่อซ้ำ: ${path}`);
    seen.add(path.toLowerCase());
    files.push({ entry, path });
  }
  if (files.length > MAX_FILES) throw new ZipError(`แพ็กเกจมีไฟล์มากเกิน ${MAX_FILES} ไฟล์`);
  const manifest = files.find(f => f.path.toLowerCase() === "imsmanifest.xml");
  if (!manifest) throw new ZipError("ไม่พบไฟล์ imsmanifest.xml ที่ระดับบนสุดของแพ็กเกจ");
  if (manifest.entry.uncompressedSize > 2 * 1024 * 1024) throw new ZipError("ไฟล์ imsmanifest.xml ใหญ่เกินกำหนด");
  const launch = scormLaunchHref(new TextDecoder().decode(await readZipEntry(reader, manifest.entry)));
  if ("error" in launch) throw new ZipError(launch.error);
  if (/^[a-z][\w+.-]*:/i.test(launch.href)) throw new ZipError("หน้าเริ่มต้นใน imsmanifest.xml ต้องเป็นไฟล์ในแพ็กเกจ");
  const [launchPath, query] = launch.href.split(/(?=[?#])/);
  let decodedLaunch = launchPath;
  try { decodedLaunch = decodeURIComponent(launchPath); } catch { /* keep as written */ }
  const launchFile = safeEntryPath(decodedLaunch);
  if (!launchFile || !seen.has(launchFile.toLowerCase())) throw new ZipError(`ไม่พบไฟล์หน้าเริ่มต้น ${launch.href} ในแพ็กเกจ`);
  const actualLaunch = files.find(f => f.path.toLowerCase() === launchFile.toLowerCase())!.path;

  for (const { entry, path } of files) {
    const data = await readZipEntry(reader, entry);
    await bucket.put(base + path, data, { httpMetadata: { contentType: contentTypeFor(path) } });
  }
  return actualLaunch + (query && !query.startsWith("#") ? query : "");
}

/**
 * Upload a SCORM 1.2 package (raw .zip body, at most 100 MB) for a lesson; the lesson becomes type 'scorm'.
 * PUT /api/instructor/lessons/:id/scorm
 */
scormRouter.put("/instructor/lessons/:id/scorm", rbac(["instructor", "admin"]), async (c) => {
  const lessonId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;
  const lesson = await db.prepare(`SELECT l.id, l.course_id, l.scorm_base, co.instructor_id FROM lessons l
    JOIN courses co ON co.id = l.course_id WHERE l.id = ?`).bind(lessonId)
    .first<{ id: string; course_id: string; scorm_base: string | null; instructor_id: string }>();
  if (!lesson) return c.json({ error: "ไม่พบบทเรียน" }, 404);
  if (!user.roles.includes("admin") && lesson.instructor_id !== user.id)
    return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: คุณไม่ได้เป็นผู้สอนคอร์สของบทเรียนนี้" }, 403);

  const contentType = (c.req.header("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!["application/zip", "application/x-zip-compressed", "application/octet-stream"].includes(contentType))
    return c.json({ error: "ต้องอัปโหลดไฟล์ .zip ของแพ็กเกจ SCORM" }, 415);
  const lengthHeader = c.req.header("Content-Length");
  const length = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : NaN;
  if (!Number.isFinite(length) || length <= 0) return c.json({ error: "ต้องระบุ Content-Length ของไฟล์" }, 411);
  if (length > PACKAGE_LIMIT) return c.json({ error: "แพ็กเกจ SCORM ต้องมีขนาดไม่เกิน 100MB" }, 413);
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "เนื้อหาคำขอว่างเปล่า" }, 400);

  const uploadId = crypto.randomUUID();
  const zipKey = `scorm-src/${lessonId}/${uploadId}.zip`;
  const base = `scorm/${lessonId}/${uploadId}/`;
  try {
    await c.env.ASSETS.put(zipKey, body, { httpMetadata: { contentType: "application/zip" } });
    const stored = await c.env.ASSETS.head(zipKey);
    if (!stored) throw new Error("Stored package missing");
    let launch: string;
    try {
      launch = await extractPackage(c.env.ASSETS, zipKey, stored.size, base);
    } catch (error) {
      await deletePrefix(c.env.ASSETS, base).catch(() => undefined);
      if (error instanceof ZipError) return c.json({ error: error.message }, 400);
      throw error;
    } finally {
      await c.env.ASSETS.delete(zipKey).catch(() => undefined);
    }

    await db.prepare("UPDATE lessons SET type = 'scorm', scorm_base = ?, scorm_launch = ? WHERE id = ?").bind(base, launch, lessonId).run();
    // Older uploads of this lesson are no longer referenced; progress rows stay.
    await deletePrefix(c.env.ASSETS, `scorm/${lessonId}/`, base).catch(err => console.error("Old SCORM cleanup failed:", err));
    return c.json({ message: "อัปโหลดแพ็กเกจ SCORM เรียบร้อยแล้ว", scorm_launch: launch });
  } catch (error) {
    console.error("SCORM upload failed:", error);
    return c.json({ error: "อัปโหลดแพ็กเกจ SCORM ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" }, 500);
  }
});

// ---------- Learner launch ----------

/**
 * Launch URL for the SCORM player (enrolled learners whose lesson is unlocked, or course staff for preview).
 * GET /api/student/lessons/:id/scorm/launch
 */
scormRouter.get("/student/lessons/:id/scorm/launch", rbac(), async (c) => {
  const lessonId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;
  try {
    const lesson = await db.prepare(`SELECT l.id, l.course_id, l.type, l.scorm_base, co.instructor_id FROM lessons l
      JOIN courses co ON co.id = l.course_id WHERE l.id = ?`).bind(lessonId)
      .first<{ id: string; course_id: string; type: string; scorm_base: string | null; instructor_id: string }>();
    if (!lesson) return c.json({ error: "ไม่พบบทเรียนนี้" }, 404);
    const staff = await isCourseStaff(c, lesson.instructor_id);
    if (!staff && !(await activeEnrollmentId(db, user.id, lesson.course_id)))
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ต้องลงทะเบียนเรียนคอร์สนี้ก่อน" }, 403);
    const locked = await lessonLockResponse(c, lessonId);
    if (locked) return locked;
    if (lesson.type !== "scorm" || !lesson.scorm_base) return c.json({ error: "บทเรียนนี้ยังไม่มีแพ็กเกจ SCORM" }, 404);
    if (!c.env.JWT_SECRET || c.env.JWT_SECRET.length < 32) return c.json({ error: "ระบบยืนยันตัวตนยังไม่ได้ตั้งค่า" }, 503);

    const token = await launchToken(c.env.JWT_SECRET, lessonId, user.id);
    const url = `${new URL(c.req.url).origin}/api/scorm/${encodeURIComponent(lessonId)}/${token}/player`;
    await trackEvent(db, user.id, "lesson_view", { courseId: lesson.course_id, lessonId, data: { type: "scorm" } });
    return c.json({ url, preview: staff && !(await activeEnrollmentId(db, user.id, lesson.course_id)) });
  } catch (error) {
    console.error("SCORM launch failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะเปิดบทเรียน SCORM" }, 500);
  }
});

interface AttemptRow {
  lesson_status: string; score_raw: number | null; score_min: number | null; score_max: number | null;
  lesson_location: string | null; suspend_data: string | null; total_seconds: number;
}

const timespan = (seconds: number) => {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(4, "0")}:${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
};

/** Player headers: framable only by the LMS front end (and this origin), never sniffed. */
function playerHeaders(c: Context<Env>) {
  const ancestors = ["'self'", ...allowedOrigins(c.env.FRONTEND_ORIGINS)].join(" ");
  c.header("Content-Security-Policy", `frame-ancestors ${ancestors}`);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
}

/**
 * SCORM 1.2 API adapter page that frames the package.
 * GET /api/scorm/:lessonId/:token/player
 */
scormRouter.get("/scorm/:lessonId/:token/player", async (c) => {
  const lessonId = c.req.param("lessonId");
  const userId = await verifyLaunchToken(c.env.JWT_SECRET, lessonId, c.req.param("token"));
  if (!userId) return c.text("ลิงก์เปิดบทเรียนไม่ถูกต้องหรือหมดอายุ กรุณาเปิดบทเรียนใหม่จากหน้าคอร์ส", 401);
  const db = c.env.DB;
  const lesson = await db.prepare("SELECT title, scorm_launch FROM lessons WHERE id = ? AND type = 'scorm'").bind(lessonId)
    .first<{ title: string; scorm_launch: string | null }>();
  const user = await db.prepare("SELECT name FROM users WHERE id = ? AND status = 'active'").bind(userId).first<{ name: string }>();
  if (!lesson?.scorm_launch || !user) return c.text("ไม่พบบทเรียนนี้", 404);
  const attempt = await db.prepare(`SELECT lesson_status, score_raw, score_min, score_max, lesson_location, suspend_data, total_seconds
    FROM scorm_attempts WHERE user_id = ? AND lesson_id = ?`).bind(userId, lessonId).first<AttemptRow>();

  const num = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
  const state = {
    lessonId,
    cmi: {
      "cmi.core.student_id": userId,
      "cmi.core.student_name": user.name,
      "cmi.core.lesson_location": attempt?.lesson_location || "",
      "cmi.core.credit": "credit",
      "cmi.core.lesson_status": attempt?.lesson_status || "not attempted",
      "cmi.core.entry": attempt?.suspend_data ? "resume" : attempt ? "" : "ab-initio",
      "cmi.core.score.raw": num(attempt?.score_raw),
      "cmi.core.score.min": num(attempt?.score_min),
      "cmi.core.score.max": num(attempt?.score_max),
      "cmi.core.total_time": timespan(attempt?.total_seconds || 0),
      "cmi.core.lesson_mode": "normal",
      "cmi.suspend_data": attempt?.suspend_data || "",
      "cmi.launch_data": "",
      "cmi.comments": "",
      "cmi.comments_from_lms": "",
      "cmi.student_data.mastery_score": ""
    }
  };
  const json = JSON.stringify(state).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const launch = lesson.scorm_launch.split("/").map((part, i, all) => {
    // Keep the query string of the last segment as written; encode path segments.
    if (i === all.length - 1) { const [file, ...rest] = part.split("?"); return encodeURIComponent(file) + (rest.length ? "?" + rest.join("?") : ""); }
    return encodeURIComponent(part);
  }).join("/");
  const title = lesson.title.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

  playerHeaders(c);
  c.header("Cache-Control", "no-store");
  return c.html(`<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style></head>
<body><iframe id="sco" title="${title}" allow="fullscreen; autoplay"></iframe>
<script>
(function () {
  var state = ${json};
  var cmi = state.cmi, extra = {}, counts = { "cmi.interactions._count": 0, "cmi.objectives._count": 0 };
  var initialized = false, finished = false, lastError = "0", dirty = false;
  var READ_ONLY = ["cmi.core.student_id", "cmi.core.student_name", "cmi.core.credit", "cmi.core.entry", "cmi.core.total_time",
    "cmi.core.lesson_mode", "cmi.launch_data", "cmi.comments_from_lms", "cmi.student_data.mastery_score"];
  var WRITE_ONLY = ["cmi.core.exit", "cmi.core.session_time"];
  var CHILDREN = {
    "cmi.core._children": "student_id,student_name,lesson_location,credit,lesson_status,entry,score,total_time,lesson_mode,exit,session_time",
    "cmi.core.score._children": "raw,min,max",
    "cmi._children": "core,suspend_data,launch_data,comments,comments_from_lms,objectives,student_data,interactions",
    "cmi.objectives._children": "id,score,status",
    "cmi.interactions._children": "id,objectives,time,type,correct_responses,weighting,student_response,result,latency"
  };
  var ERRORS = { "0": "No error", "101": "General exception", "201": "Invalid argument error", "202": "Element cannot have children",
    "203": "Element not an array - cannot have count", "301": "Not initialized", "401": "Not implemented error",
    "402": "Invalid set value, element is a keyword", "403": "Element is read only", "404": "Element is write only", "405": "Incorrect data type" };
  var STATUSES = ["passed", "completed", "failed", "incomplete", "browsed", "not attempted"];
  function fail(code, value) { lastError = code; return value; }
  function send(finish) {
    var body = JSON.stringify({ cmi: { lesson_status: cmi["cmi.core.lesson_status"], score_raw: cmi["cmi.core.score.raw"],
      score_min: cmi["cmi.core.score.min"], score_max: cmi["cmi.core.score.max"], lesson_location: cmi["cmi.core.lesson_location"],
      suspend_data: cmi["cmi.suspend_data"], session_time: cmi["cmi.core.session_time"] || "", exit: cmi["cmi.core.exit"] || "" }, finish: !!finish });
    dirty = false;
    try {
      fetch("commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true, credentials: "omit" })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (window.parent !== window) window.parent.postMessage({ source: "netprime-scorm", lessonId: state.lessonId, lesson_status: d.lesson_status, completed: !!d.completed, progress_percent: d.progress_percent }, "*"); })
        .catch(function () {});
    } catch (e) {}
    return true;
  }
  window.API = {
    LMSInitialize: function (arg) {
      if (arg !== "" && arg !== undefined && arg !== null) return fail("201", "false");
      if (initialized) return fail("101", "false");
      initialized = true; finished = false;
      if (cmi["cmi.core.lesson_status"] === "not attempted") cmi["cmi.core.lesson_status"] = "incomplete";
      return fail("0", "true");
    },
    LMSFinish: function (arg) {
      if (!initialized) return fail("301", "false");
      initialized = false; finished = true; send(true);
      return fail("0", "true");
    },
    LMSGetValue: function (key) {
      if (!initialized) return fail("301", "");
      key = String(key);
      if (CHILDREN[key]) return fail("0", CHILDREN[key]);
      if (key in counts) return fail("0", String(counts[key]));
      if (WRITE_ONLY.indexOf(key) >= 0) return fail("404", "");
      if (key in cmi) return fail("0", String(cmi[key]));
      if (/^cmi\\.(interactions|objectives)\\.\\d+\\./.test(key)) return fail("0", extra[key] || "");
      if (/^cmi\\./.test(key)) return fail("401", "");
      return fail("201", "");
    },
    LMSSetValue: function (key, value) {
      if (!initialized) return fail("301", "false");
      key = String(key); value = value === undefined || value === null ? "" : String(value);
      if (CHILDREN[key] || key in counts) return fail("402", "false");
      if (READ_ONLY.indexOf(key) >= 0) return fail("403", "false");
      if (key === "cmi.core.lesson_status" && (STATUSES.indexOf(value) < 0 || value === "not attempted")) return fail("405", "false");
      if (/^cmi\\.core\\.score\\.(raw|min|max)$/.test(key) && value !== "" && (isNaN(Number(value)) || Number(value) < 0 || Number(value) > 100)) return fail("405", "false");
      if (key === "cmi.core.session_time" && !/^\\d{2,4}:\\d{2}:\\d{2}(\\.\\d{1,2})?$/.test(value)) return fail("405", "false");
      if (key === "cmi.core.exit" && ["time-out", "suspend", "logout", ""].indexOf(value) < 0) return fail("405", "false");
      if (key === "cmi.suspend_data" && value.length > 65000) return fail("405", "false");
      var m = /^cmi\\.(interactions|objectives)\\.(\\d+)\\./.exec(key);
      if (m) {
        var countKey = "cmi." + m[1] + "._count";
        counts[countKey] = Math.max(counts[countKey], Number(m[2]) + 1);
        extra[key] = value; return fail("0", "true");
      }
      if (key in cmi || WRITE_ONLY.indexOf(key) >= 0 || key === "cmi.comments") { cmi[key] = value; dirty = true; return fail("0", "true"); }
      if (/^cmi\\./.test(key)) return fail("401", "false");
      return fail("201", "false");
    },
    LMSCommit: function (arg) {
      if (!initialized) return fail("301", "false");
      send(false);
      return fail("0", "true");
    },
    LMSGetLastError: function () { return lastError; },
    LMSGetErrorString: function (code) { return ERRORS[String(code)] || ""; },
    LMSGetDiagnostic: function (code) { return ERRORS[String(code || lastError)] || ""; }
  };
  window.addEventListener("pagehide", function () { if (initialized && dirty) send(false); });
  document.getElementById("sco").src = "c/" + ${JSON.stringify(launch).replace(/</g, "\\u003c")};
})();
</script></body></html>`);
});

/**
 * Package files, served only under a valid launch token.
 * GET /api/scorm/:lessonId/:token/c/<path>
 */
scormRouter.get("/scorm/:lessonId/:token/c/*", async (c) => {
  const lessonId = c.req.param("lessonId");
  const token = c.req.param("token");
  const userId = await verifyLaunchToken(c.env.JWT_SECRET, lessonId, token);
  if (!userId) return c.text("ลิงก์เปิดบทเรียนไม่ถูกต้องหรือหมดอายุ", 401);

  const pathname = new URL(c.req.url).pathname;
  const marker = `/${token}/c/`;
  const rawPath = pathname.slice(pathname.indexOf(marker) + marker.length);
  let decoded: string;
  try { decoded = rawPath.split("/").map(decodeURIComponent).join("/"); } catch { return c.text("ไม่พบไฟล์", 404); }
  const path = safeEntryPath(decoded);
  if (!path || path !== decoded) return c.text("ไม่พบไฟล์", 404);

  const lesson = await c.env.DB.prepare("SELECT scorm_base FROM lessons WHERE id = ? AND type = 'scorm'").bind(lessonId)
    .first<{ scorm_base: string | null }>();
  if (!lesson?.scorm_base) return c.text("ไม่พบไฟล์", 404);
  const object = await c.env.ASSETS.get(lesson.scorm_base + path);
  if (!object) return c.text("ไม่พบไฟล์", 404);

  playerHeaders(c);
  c.header("Content-Type", object.httpMetadata?.contentType || contentTypeFor(path));
  c.header("Content-Length", String(object.size));
  c.header("Cache-Control", "private, max-age=3600");
  return c.body(object.body);
});

const STATUS_RANK: Record<string, number> = { "not attempted": 0, browsed: 1, incomplete: 2, failed: 3, completed: 4, passed: 5 };

const parseTimespan = (value: string) => {
  const m = /^(\d{2,4}):(\d{2}):(\d{2}(?:\.\d{1,2})?)$/.exec(value);
  return m ? Math.min(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]), 24 * 3600) : 0;
};
const score = (value: unknown) => {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};
const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : null);

/**
 * LMSCommit / LMSFinish from the player. Saves the attempt for enrolled learners and completes the
 * lesson when the SCO reports completed or passed. Staff previews are not saved.
 * POST /api/scorm/:lessonId/:token/commit { cmi: {...}, finish }
 */
scormRouter.post("/scorm/:lessonId/:token/commit", async (c) => {
  const lessonId = c.req.param("lessonId");
  const userId = await verifyLaunchToken(c.env.JWT_SECRET, lessonId, c.req.param("token"));
  if (!userId) return c.json({ error: "ลิงก์เปิดบทเรียนไม่ถูกต้องหรือหมดอายุ กรุณาเปิดบทเรียนใหม่" }, 401);
  const db = c.env.DB;
  const payload = await c.req.json<{ cmi?: Record<string, unknown>; finish?: boolean }>().catch(() => null);
  const cmi = payload?.cmi;
  if (!cmi || typeof cmi !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);

  try {
    const lesson = await db.prepare("SELECT course_id FROM lessons WHERE id = ? AND type = 'scorm'").bind(lessonId).first<{ course_id: string }>();
    const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND status = 'active'").bind(userId).first();
    if (!lesson || !active) return c.json({ error: "ไม่พบบทเรียนนี้" }, 404);
    if (!(await activeEnrollmentId(db, userId, lesson.course_id))) return c.json({ saved: false, preview: true });
    if ((await lessonGateFor(db, { id: userId }, lessonId, lesson.course_id)).locked)
      return c.json({ error: "บทเรียนนี้ยังล็อกอยู่" }, 403);

    const existing = await db.prepare(`SELECT lesson_status, score_raw, score_min, score_max, lesson_location, suspend_data
      FROM scorm_attempts WHERE user_id = ? AND lesson_id = ?`).bind(userId, lessonId)
      .first<{ lesson_status: string; score_raw: number | null; score_min: number | null; score_max: number | null; lesson_location: string | null; suspend_data: string | null }>();
    // Fields the SCO did not send keep their saved value.
    const keep = <T,>(key: string, parsed: T, saved: T | null | undefined) => (key in cmi ? parsed : saved ?? null);
    const reported = typeof cmi.lesson_status === "string" && cmi.lesson_status in STATUS_RANK ? cmi.lesson_status : "incomplete";
    // Never downgrade a finished attempt (e.g. a SCO re-opened after passing reports "incomplete").
    const status = existing && STATUS_RANK[existing.lesson_status] > STATUS_RANK[reported] ? existing.lesson_status : reported;
    const sessionTime = typeof cmi.session_time === "string" ? cmi.session_time.slice(0, 20) : "";
    const addSeconds = payload?.finish ? parseTimespan(sessionTime) : 0;
    const done = status === "completed" || status === "passed";

    await db.prepare(`INSERT INTO scorm_attempts (id, user_id, lesson_id, course_id, lesson_status, score_raw, score_min, score_max,
        lesson_location, suspend_data, session_time, total_seconds, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP END)
      ON CONFLICT(user_id, lesson_id) DO UPDATE SET lesson_status = excluded.lesson_status, score_raw = excluded.score_raw,
        score_min = excluded.score_min, score_max = excluded.score_max, lesson_location = excluded.lesson_location,
        suspend_data = excluded.suspend_data, session_time = excluded.session_time,
        total_seconds = scorm_attempts.total_seconds + ?, completed_at = COALESCE(scorm_attempts.completed_at, excluded.completed_at),
        updated_at = CURRENT_TIMESTAMP`)
      .bind("scorm_" + crypto.randomUUID(), userId, lessonId, lesson.course_id, status,
        keep("score_raw", score(cmi.score_raw), existing?.score_raw), keep("score_min", score(cmi.score_min), existing?.score_min),
        keep("score_max", score(cmi.score_max), existing?.score_max), keep("lesson_location", text(cmi.lesson_location, 255), existing?.lesson_location),
        keep("suspend_data", text(cmi.suspend_data, 65000), existing?.suspend_data), sessionTime || null, addSeconds, done ? 1 : 0, addSeconds)
      .run();

    let progressPercent: number | null = null;
    if (done) progressPercent = (await completeLesson(db, userId, lessonId, lesson.course_id)).progress_percent;
    return c.json({ saved: true, lesson_status: status, completed: done, progress_percent: progressPercent });
  } catch (error) {
    console.error("SCORM commit failed:", error);
    return c.json({ error: "บันทึกผลการเรียน SCORM ไม่สำเร็จ" }, 500);
  }
});
