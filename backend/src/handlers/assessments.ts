import { Hono, Context } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { trackEvent } from "../utils/events";
import { createNotification } from "./notifications";
import { lessonLockResponse } from "../utils/courseContent";
import { requireDeleteConfirmation } from "../utils/dangerConfirm";

/**
 * Assessments: per-course question bank, exams (fixed or random draw, time limit, attempts, pass mark),
 * lesson assignments with private file uploads and grading, interactive video questions, reports and
 * gradebooks. The simple lesson quiz (quizzes / quiz_answers in student.ts) is separate and unchanged.
 * Tables: migrations/0019_assessments.sql.
 */
export const assessmentsRouter = new Hono<Env>();

type C = Context<Env>;

// ---------- Time (server clock; a test clock only on local seed builds) ----------

/** Seconds of grace after the deadline for network latency before a submission is refused. */
const DEADLINE_GRACE_MS = 30_000;

/** Local test harness may send X-Test-Now (ISO) to simulate the clock; never honored in production. */
function nowMs(c: C): number {
  if (c.env.ALLOW_LOCAL_SEED_PASSWORDS === "true") {
    const override = Date.parse(c.req.header("X-Test-Now") || "");
    if (Number.isFinite(override)) return override;
  }
  return Date.now();
}
const iso = (ms: number) => new Date(ms).toISOString();

// ---------- Input helpers ----------

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null;
const optStr = (v: unknown, max: number): string | null | undefined =>
  v === undefined ? undefined : v === null || v === "" ? null : typeof v === "string" && v.length <= max ? v.trim() : undefined;
const bool01 = (v: unknown) => v === true || v === 1 || v === "1" ? 1 : 0;
const round2 = (n: number) => Math.round(n * 100) / 100;
function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}
/** ISO date-time or null; undefined when the value is invalid. */
function optDate(v: unknown): string | null | undefined {
  if (v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? iso(ms) : undefined;
}
async function body(c: C): Promise<Record<string, unknown> | null> {
  const data = await c.req.json<unknown>().catch(() => null);
  return isObj(data) ? data : null;
}

/** Cryptographically shuffled copy. */
function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  const rand = new Uint32Array(Math.max(out.length, 1));
  crypto.getRandomValues(rand);
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand[i] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** Text comparison for short answers / blanks: case, width and whitespace insensitive (no regex). */
export const normalizeAnswer = (s: string) => s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

// ---------- Questions ----------

export const QUESTION_TYPES = ["single", "multiple", "true_false", "short", "fill_blank", "matching", "ordering", "essay"] as const;
export type QuestionType = typeof QUESTION_TYPES[number];
const DIFFICULTIES = ["easy", "medium", "hard"] as const;
const TRUE_FALSE = ["จริง", "เท็จ"];
const BLANK = /_{3,}/g;

/** Validated question as stored (options_json / answer_json shapes depend on type). */
interface QuestionInput {
  type: QuestionType;
  prompt: string;
  options: string[] | { left: string[]; right: string[] } | null;
  answer: number[] | string[] | string[][] | null;
  explanation: string | null;
  points: number;
  tags: string[];
  difficulty: typeof DIFFICULTIES[number];
}

function parseTags(v: unknown): string[] | null {
  if (v === undefined || v === null || v === "") return [];
  const list = typeof v === "string" ? v.split(/[,;|]/) : Array.isArray(v) ? v : null;
  if (!list || list.length > 20) return null;
  const tags = new Set<string>();
  for (const t of list) {
    if (typeof t !== "string") return null;
    const tag = t.trim().toLowerCase();
    if (tag.length > 40) return null;
    if (tag) tags.add(tag);
  }
  return [...tags];
}

function parseOptions(v: unknown, min: number, max: number): string[] | null {
  if (!Array.isArray(v) || v.length < min || v.length > max) return null;
  const out: string[] = [];
  for (const o of v) {
    const text = typeof o === "number" ? String(o) : typeof o === "string" ? o.trim() : "";
    if (!text || text.length > 1000) return null;
    out.push(text);
  }
  return out;
}

/** Choice answer: 0-based numbers, numeric strings, option text, or true/false words. */
function choiceIndexes(correct: unknown, options: string[]): number[] | null {
  const list = Array.isArray(correct) ? correct : correct === undefined || correct === null ? [] : [correct];
  const out = new Set<number>();
  for (const item of list) {
    let index = -1;
    if (typeof item === "number" && Number.isInteger(item)) index = item;
    else if (typeof item === "boolean") index = item ? 0 : 1;
    else if (typeof item === "string") {
      const t = item.trim();
      const byText = options.findIndex(o => normalizeAnswer(o) === normalizeAnswer(t));
      if (byText >= 0) index = byText;
      else if (/^\d+$/.test(t)) index = Number(t);
      else if (options === TRUE_FALSE || options.length === 2) {
        const word = t.toLowerCase();
        if (["true", "t", "yes", "ถูก", "จริง"].includes(word)) index = 0;
        if (["false", "f", "no", "ผิด", "เท็จ"].includes(word)) index = 1;
      }
    }
    if (index < 0 || index >= options.length) return null;
    out.add(index);
  }
  return [...out].sort((a, b) => a - b);
}

/** Validates any question payload (single create, bulk, CSV import, video questions). */
export function parseQuestion(raw: unknown, allowed: readonly QuestionType[] = QUESTION_TYPES): { value: QuestionInput } | { error: string } {
  if (!isObj(raw)) return { error: "ข้อมูลคำถามไม่ถูกต้อง" };
  const type = raw.type as QuestionType;
  if (!allowed.includes(type)) return { error: "ประเภทคำถามไม่ถูกต้อง" };
  const prompt = str(raw.prompt, 5000);
  if (!prompt) return { error: "ต้องระบุโจทย์ (ไม่เกิน 5,000 ตัวอักษร)" };
  const explanation = optStr(raw.explanation, 5000);
  if (explanation === undefined && raw.explanation !== undefined) return { error: "คำอธิบายเฉลยยาวเกินไป" };
  const points = raw.points === undefined || raw.points === null || raw.points === "" ? 1 : Number(raw.points);
  if (!Number.isFinite(points) || points <= 0 || points > 1000) return { error: "คะแนนต้องมากกว่า 0 และไม่เกิน 1,000" };
  const tags = parseTags(raw.tags);
  if (!tags) return { error: "แท็กไม่ถูกต้อง (ไม่เกิน 20 แท็ก แท็กละไม่เกิน 40 ตัวอักษร)" };
  const difficulty = (raw.difficulty === undefined || raw.difficulty === null || raw.difficulty === "" ? "medium" : raw.difficulty) as QuestionInput["difficulty"];
  if (!DIFFICULTIES.includes(difficulty)) return { error: "ระดับความยากต้องเป็น easy, medium หรือ hard" };
  const base = { type, prompt, explanation: explanation ?? null, points: round2(points), tags, difficulty };

  switch (type) {
    case "single":
    case "multiple": {
      const options = parseOptions(raw.options, 2, 10);
      if (!options) return { error: "ต้องมีตัวเลือก 2–10 ข้อ ข้อละไม่เกิน 1,000 ตัวอักษร" };
      const answer = choiceIndexes(raw.correct, options);
      if (!answer || !answer.length) return { error: "ต้องระบุคำตอบที่ถูกต้องจากตัวเลือก" };
      if (type === "single" && answer.length !== 1) return { error: "คำถามแบบตัวเลือกเดียวต้องมีคำตอบที่ถูก 1 ข้อ" };
      return { value: { ...base, options, answer } };
    }
    case "true_false": {
      const answer = choiceIndexes(raw.correct, TRUE_FALSE);
      if (!answer || answer.length !== 1) return { error: "คำถามถูก/ผิดต้องระบุคำตอบเป็น true หรือ false" };
      return { value: { ...base, options: [...TRUE_FALSE], answer } };
    }
    case "short": {
      const list = (Array.isArray(raw.correct) ? raw.correct : [raw.correct]).map(v => typeof v === "number" ? String(v) : v);
      const answer = parseOptions(list, 1, 20);
      if (!answer) return { error: "ต้องระบุคำตอบที่ยอมรับอย่างน้อย 1 คำตอบ" };
      return { value: { ...base, options: null, answer } };
    }
    case "fill_blank": {
      const blanks = prompt.match(BLANK)?.length || 0;
      if (blanks < 1 || blanks > 20) return { error: "โจทย์เติมคำต้องมีช่องว่าง ___ อย่างน้อย 1 ช่อง (ไม่เกิน 20)" };
      if (!Array.isArray(raw.correct) || raw.correct.length !== blanks) return { error: `ต้องระบุคำตอบให้ครบ ${blanks} ช่อง` };
      const answer: string[][] = [];
      for (const accepted of raw.correct) {
        const list = parseOptions(Array.isArray(accepted) ? accepted : typeof accepted === "string" ? accepted.split("/") : [accepted], 1, 10);
        if (!list) return { error: "คำตอบของแต่ละช่องต้องไม่ว่าง" };
        answer.push(list);
      }
      return { value: { ...base, options: null, answer } };
    }
    case "matching": {
      let left: string[] | null = null, right: string[] | null = null;
      if (Array.isArray(raw.options)) {
        const pairs = raw.options.map(p => typeof p === "string" ? p.split("::") : isObj(p) ? [p.left, p.right] : []);
        left = parseOptions(pairs.map(p => p[0]), 2, 20);
        right = parseOptions(pairs.map(p => p[1]), 2, 20);
      } else if (isObj(raw.options)) {
        left = parseOptions(raw.options.left, 2, 20);
        right = parseOptions(raw.options.right, 2, 20);
      }
      if (!left || !right || left.length !== right.length) return { error: "การจับคู่ต้องมี 2–20 คู่ (ซ้าย::ขวา)" };
      return { value: { ...base, options: { left, right }, answer: range(left.length) } };
    }
    case "ordering": {
      const options = parseOptions(raw.options, 2, 20);
      if (!options) return { error: "การเรียงลำดับต้องมี 2–20 รายการ เรียงตามลำดับที่ถูกต้อง" };
      return { value: { ...base, options, answer: range(options.length) } };
    }
    case "essay":
      return { value: { ...base, options: null, answer: null } };
  }
}

interface BankRow {
  id: string; course_id: string; type: QuestionType; prompt: string; options_json: string | null; answer_json: string | null;
  explanation: string | null; points: number; tags_json: string; difficulty: string; created_at: string; updated_at: string;
}

const bankView = (r: BankRow) => ({
  id: r.id, course_id: r.course_id, type: r.type, prompt: r.prompt, options: parseJson<unknown>(r.options_json, null),
  correct: parseJson<unknown>(r.answer_json, null), explanation: r.explanation, points: r.points, tags: parseJson<string[]>(r.tags_json, []),
  difficulty: r.difficulty, created_at: r.created_at, updated_at: r.updated_at
});

const insertQuestion = (db: D1Database, id: string, courseId: string, q: QuestionInput, userId: string) =>
  db.prepare(`INSERT INTO question_bank (id, course_id, type, prompt, options_json, answer_json, explanation, points, tags_json, difficulty, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, courseId, q.type, q.prompt, q.options ? JSON.stringify(q.options) : null,
    q.answer ? JSON.stringify(q.answer) : null, q.explanation, q.points, JSON.stringify(q.tags), q.difficulty, userId);

// ---------- Ownership and enrollment ----------

interface CourseRow { id: string; title: string; instructor_id: string; requires_final_exam: number }

/** The course when the user teaches it (or is an admin); otherwise a 403/404 response. */
async function ownCourse(c: C, courseId: string | undefined | null): Promise<CourseRow | Response> {
  if (!courseId) return c.json({ error: "ไม่พบคอร์ส" }, 404);
  const course = await c.env.DB.prepare("SELECT id, title, instructor_id, requires_final_exam FROM courses WHERE id = ?")
    .bind(courseId).first<CourseRow>();
  if (!course) return c.json({ error: "ไม่พบคอร์ส" }, 404);
  const user = c.get("user");
  if (!user.roles.includes("admin") && course.instructor_id !== user.id) {
    return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: คุณไม่ได้เป็นผู้สอนคอร์สนี้" }, 403);
  }
  return course;
}

async function activeEnrollment(db: D1Database, userId: string, courseId: string) {
  return !!(await db.prepare(`SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ? AND status IN ('active', 'completed')
    AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`).bind(userId, courseId).first());
}
const notEnrolled = (c: C) => c.json({ error: "ต้องมีการลงทะเบียนเรียนคอร์สนี้ที่ใช้งานอยู่" }, 403);

async function audit(c: C, action: string, entity: string, entityId: string, detail?: string) {
  try {
    await c.env.DB.prepare("INSERT INTO admin_audit_log (id, user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), c.get("user").id, action, entity, entityId, detail ?? null).run();
  } catch (error) {
    console.error("Assessment audit log failed:", error);
  }
}

// ---------- Question bank (instructor) ----------

/** GET /api/instructor/courses/:courseId/questions?type=&tag=&difficulty=&q= */
assessmentsRouter.get("/instructor/courses/:courseId/questions", rbac(["instructor", "admin"]), async (c) => {
  const course = await ownCourse(c, c.req.param("courseId"));
  if (course instanceof Response) return course;
  const rows = await c.env.DB.prepare("SELECT * FROM question_bank WHERE course_id = ? ORDER BY created_at DESC, id")
    .bind(course.id).all<BankRow>();
  const { type, tag, difficulty, q } = c.req.query();
  const needle = q ? normalizeAnswer(q) : "";
  const list = rows.results.map(bankView).filter(r => (!type || r.type === type) && (!difficulty || r.difficulty === difficulty)
    && (!tag || r.tags.includes(tag.trim().toLowerCase())) && (!needle || normalizeAnswer(r.prompt).includes(needle)));
  const tags = [...new Set(rows.results.flatMap(r => parseJson<string[]>(r.tags_json, [])))].sort();
  return c.json({ questions: list, tags, total: rows.results.length });
});

/** POST /api/instructor/courses/:courseId/questions */
assessmentsRouter.post("/instructor/courses/:courseId/questions", rbac(["instructor", "admin"]), async (c) => {
  const course = await ownCourse(c, c.req.param("courseId"));
  if (course instanceof Response) return course;
  const parsed = parseQuestion(await body(c));
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const id = newId("qb");
  await insertQuestion(c.env.DB, id, course.id, parsed.value, c.get("user").id).run();
  const row = await c.env.DB.prepare("SELECT * FROM question_bank WHERE id = ?").bind(id).first<BankRow>();
  return c.json({ question: bankView(row!) }, 201);
});

/**
 * Bulk create (contract used by the AI question generator):
 * POST /api/instructor/courses/:courseId/questions/bulk
 * { questions: [{ type, prompt, options?, correct?, explanation?, points?, tags? }] } → { created, ids }
 * All-or-nothing: one invalid question rejects the request with its index.
 */
assessmentsRouter.post("/instructor/courses/:courseId/questions/bulk", rbac(["instructor", "admin"]), async (c) => {
  const course = await ownCourse(c, c.req.param("courseId"));
  if (course instanceof Response) return course;
  const data = await body(c);
  const list = data?.questions;
  if (!Array.isArray(list) || !list.length || list.length > 200) return c.json({ error: "ต้องส่งคำถาม 1–200 ข้อในฟิลด์ questions" }, 400);
  const valid: QuestionInput[] = [];
  for (let i = 0; i < list.length; i++) {
    const parsed = parseQuestion(list[i]);
    if ("error" in parsed) return c.json({ error: `คำถามข้อที่ ${i + 1}: ${parsed.error}`, index: i }, 400);
    valid.push(parsed.value);
  }
  const ids = valid.map(() => newId("qb"));
  const userId = c.get("user").id;
  await c.env.DB.batch(valid.map((q, i) => insertQuestion(c.env.DB, ids[i], course.id, q, userId)));
  return c.json({ created: ids.length, ids }, 201);
});

/** PATCH /api/instructor/questions/:id (full replacement of the question fields) */
assessmentsRouter.patch("/instructor/questions/:id", rbac(["instructor", "admin"]), async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM question_bank WHERE id = ?").bind(c.req.param("id")).first<BankRow>();
  if (!row) return c.json({ error: "ไม่พบคำถาม" }, 404);
  const course = await ownCourse(c, row.course_id);
  if (course instanceof Response) return course;
  const data = await body(c);
  if (!data) return c.json({ error: "ข้อมูลคำถามไม่ถูกต้อง" }, 400);
  // Unspecified fields keep their stored values.
  const current = bankView(row);
  const merged = { ...current, ...data, type: data.type ?? current.type };
  if (merged.type === "matching" && data.options === undefined) merged.options = current.options;
  const parsed = parseQuestion(merged);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const q = parsed.value;
  await c.env.DB.prepare(`UPDATE question_bank SET type = ?, prompt = ?, options_json = ?, answer_json = ?, explanation = ?, points = ?,
    tags_json = ?, difficulty = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(q.type, q.prompt,
    q.options ? JSON.stringify(q.options) : null, q.answer ? JSON.stringify(q.answer) : null, q.explanation, q.points,
    JSON.stringify(q.tags), q.difficulty, row.id).run();
  const updated = await c.env.DB.prepare("SELECT * FROM question_bank WHERE id = ?").bind(row.id).first<BankRow>();
  return c.json({ question: bankView(updated!) });
});

/** DELETE /api/instructor/questions/:id — past attempts keep their own snapshot. */
assessmentsRouter.delete("/instructor/questions/:id", rbac(["instructor", "admin"]), async (c) => {
  const row = await c.env.DB.prepare("SELECT id, course_id FROM question_bank WHERE id = ?").bind(c.req.param("id")).first<{ id: string; course_id: string }>();
  if (!row) return c.json({ error: "ไม่พบคำถาม" }, 404);
  const course = await ownCourse(c, row.course_id);
  if (course instanceof Response) return course;
  await c.env.DB.prepare("DELETE FROM question_bank WHERE id = ?").bind(row.id).run();
  return c.json({ success: true });
});

// ---------- CSV import/export ----------

const CSV_HEADER = ["type", "prompt", "options", "correct", "explanation", "points", "tags", "difficulty"];

function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text; // neutralise spreadsheet formulas
  return `"${text.replace(/"/g, '""')}"`;
}
const csvResponse = (lines: unknown[][], filename: string) => new Response("﻿" + lines.map(l => l.map(csvCell).join(",")).join("\r\n"), {
  headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" }
});

/** RFC 4180 parser (quoted cells, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim()));
}
const unguard = (v: string) => /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v;

/** CSV columns → question payload. Choice answers are 1-based numbers; lists use "|". */
function csvRowToQuestion(cells: Record<string, string>): unknown {
  const type = cells.type?.trim() as QuestionType;
  const split = (v: string | undefined) => (v ?? "").split("|").map(s => s.trim()).filter(Boolean);
  const options = split(cells.options);
  let correct: unknown = split(cells.correct);
  if (["single", "multiple", "true_false"].includes(type)) {
    correct = (correct as string[]).map(v => /^\d+$/.test(v) ? Number(v) - 1 : v);
  } else if (type === "fill_blank") correct = (correct as string[]).map(v => v.split("/").map(s => s.trim()));
  return { type, prompt: cells.prompt, options: type === "true_false" ? undefined : options, correct, explanation: cells.explanation || null,
    points: cells.points || undefined, tags: cells.tags || "", difficulty: cells.difficulty?.trim() || undefined };
}

function questionToCsv(q: ReturnType<typeof bankView>): unknown[] {
  let options = "", correct = "";
  const answer = q.correct as any;
  if (q.type === "matching") {
    const o = q.options as { left: string[]; right: string[] };
    options = o.left.map((l, i) => `${l}::${o.right[i]}`).join("|");
  } else if (Array.isArray(q.options) && q.type !== "true_false") options = (q.options as string[]).join("|");
  if (["single", "multiple", "true_false"].includes(q.type)) correct = (answer as number[]).map(i => i + 1).join("|");
  else if (q.type === "short") correct = (answer as string[]).join("|");
  else if (q.type === "fill_blank") correct = (answer as string[][]).map(a => a.join("/")).join("|");
  return [q.type, q.prompt, options, correct, q.explanation ?? "", q.points, q.tags.join(","), q.difficulty];
}

/** GET /api/instructor/courses/:courseId/questions/export */
assessmentsRouter.get("/instructor/courses/:courseId/questions/export", rbac(["instructor", "admin"]), async (c) => {
  const course = await ownCourse(c, c.req.param("courseId"));
  if (course instanceof Response) return course;
  const rows = await c.env.DB.prepare("SELECT * FROM question_bank WHERE course_id = ? ORDER BY created_at, id").bind(course.id).all<BankRow>();
  return csvResponse([CSV_HEADER, ...rows.results.map(r => questionToCsv(bankView(r)))], `questions-${course.id}.csv`);
});

/** POST /api/instructor/courses/:courseId/questions/import { csv } — nothing is created when any row is invalid. */
assessmentsRouter.post("/instructor/courses/:courseId/questions/import", rbac(["instructor", "admin"]), async (c) => {
  const course = await ownCourse(c, c.req.param("courseId"));
  if (course instanceof Response) return course;
  const data = await body(c);
  if (typeof data?.csv !== "string" || !data.csv.trim() || data.csv.length > 1_000_000) return c.json({ error: "ต้องแนบไฟล์ CSV (ไม่เกิน 1 MB)" }, 400);
  const rows = parseCsv(data.csv);
  const header = (rows.shift() || []).map(h => h.trim().toLowerCase());
  if (!header.includes("type") || !header.includes("prompt")) return c.json({ error: "หัวตารางต้องมีคอลัมน์ type และ prompt (" + CSV_HEADER.join(",") + ")" }, 400);
  if (!rows.length || rows.length > 500) return c.json({ error: "ไฟล์ต้องมีคำถาม 1–500 แถว" }, 400);
  const valid: QuestionInput[] = [];
  const errors: { row: number; error: string }[] = [];
  rows.forEach((cells, i) => {
    const record = Object.fromEntries(header.map((h, j) => [h, unguard(cells[j] ?? "")]));
    const parsed = parseQuestion(csvRowToQuestion(record));
    if ("error" in parsed) errors.push({ row: i + 2, error: parsed.error });
    else valid.push(parsed.value);
  });
  if (errors.length) return c.json({ error: "พบข้อมูลไม่ถูกต้อง ยังไม่ได้นำเข้าคำถาม", errors: errors.slice(0, 50) }, 400);
  const userId = c.get("user").id;
  const ids = valid.map(() => newId("qb"));
  await c.env.DB.batch(valid.map((q, i) => insertQuestion(c.env.DB, ids[i], course.id, q, userId)));
  return c.json({ created: ids.length, ids }, 201);
});

// ---------- Exams (instructor) ----------

interface ExamRow {
  id: string; course_id: string; lesson_id: string | null; title: string; description: string | null; is_final: number;
  selection_mode: "fixed" | "random"; draw_rules_json: string | null; shuffle_questions: number; shuffle_options: number;
  time_limit_minutes: number | null; max_attempts: number | null; pass_percent: number;
  show_answers: "never" | "after_submit" | "after_pass"; available_from: string | null; available_until: string | null;
  status: "draft" | "published"; created_at: string; updated_at: string;
}
interface DrawRule { tag?: string | null; difficulty?: string | null; count: number }

const examView = (e: ExamRow) => ({ ...e, draw_rules: parseJson<DrawRule[]>(e.draw_rules_json, []), draw_rules_json: undefined,
  is_final: !!e.is_final, shuffle_questions: !!e.shuffle_questions, shuffle_options: !!e.shuffle_options });

/** Picks bank questions for a random exam; null when the bank cannot satisfy a rule. */
function drawQuestions(bank: BankRow[], rules: DrawRule[]): BankRow[] | null {
  const used = new Set<string>();
  const picked: BankRow[] = [];
  for (const rule of rules) {
    const pool = shuffle(bank.filter(q => !used.has(q.id) && (!rule.difficulty || q.difficulty === rule.difficulty)
      && (!rule.tag || parseJson<string[]>(q.tags_json, []).includes(rule.tag))));
    if (pool.length < rule.count) return null;
    for (const q of pool.slice(0, rule.count)) { used.add(q.id); picked.push(q); }
  }
  return picked;
}

/** Validates exam settings; `partial` keeps fields that are not sent. */
async function parseExam(c: C, courseId: string, data: Record<string, unknown>, current?: ExamRow) {
  const get = <K extends keyof ExamRow>(k: K) => (data[k] !== undefined ? data[k] : current?.[k]) as unknown;
  const title = str(get("title"), 200);
  if (!title) return { error: "ต้องระบุชื่อข้อสอบ (ไม่เกิน 200 ตัวอักษร)" };
  const description = optStr(get("description") ?? null, 5000);
  if (description === undefined) return { error: "คำอธิบายยาวเกินไป" };
  const lessonId = get("lesson_id") || null;
  if (lessonId !== null) {
    if (typeof lessonId !== "string") return { error: "บทเรียนไม่ถูกต้อง" };
    const lesson = await c.env.DB.prepare("SELECT 1 FROM lessons WHERE id = ? AND course_id = ?").bind(lessonId, courseId).first();
    if (!lesson) return { error: "บทเรียนต้องอยู่ในคอร์สเดียวกัน" };
  }
  const mode = get("selection_mode") ?? "fixed";
  if (mode !== "fixed" && mode !== "random") return { error: "รูปแบบการเลือกข้อสอบไม่ถูกต้อง" };
  let rules: DrawRule[] = [];
  if (mode === "random") {
    const raw = data.draw_rules !== undefined ? data.draw_rules : parseJson(current?.draw_rules_json, []);
    if (!Array.isArray(raw) || !raw.length || raw.length > 20) return { error: "การสุ่มข้อสอบต้องมีเงื่อนไข 1–20 ข้อ" };
    for (const r of raw) {
      if (!isObj(r)) return { error: "เงื่อนไขการสุ่มไม่ถูกต้อง" };
      const count = Number(r.count);
      const tag = typeof r.tag === "string" && r.tag.trim() ? r.tag.trim().toLowerCase() : null;
      const difficulty = typeof r.difficulty === "string" && r.difficulty ? r.difficulty : null;
      if (!Number.isInteger(count) || count < 1 || count > 200) return { error: "จำนวนข้อที่สุ่มต้องเป็น 1–200" };
      if (difficulty && !DIFFICULTIES.includes(difficulty as any)) return { error: "ระดับความยากไม่ถูกต้อง" };
      rules.push({ tag, difficulty, count });
    }
  }
  const intOrNull = (v: unknown, min: number, max: number) => v === null || v === undefined || v === "" || v === 0 ? null
    : Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : NaN;
  const timeLimit = intOrNull(get("time_limit_minutes"), 1, 1440);
  if (Number.isNaN(timeLimit)) return { error: "เวลาทำข้อสอบต้องเป็น 1–1,440 นาที" };
  const maxAttempts = intOrNull(get("max_attempts"), 1, 100);
  if (Number.isNaN(maxAttempts)) return { error: "จำนวนครั้งที่ทำได้ต้องเป็น 1–100" };
  const pass = Number(get("pass_percent") ?? 60);
  if (!Number.isFinite(pass) || pass < 0 || pass > 100) return { error: "เกณฑ์ผ่านต้องเป็น 0–100%" };
  const show = get("show_answers") ?? "after_submit";
  if (!["never", "after_submit", "after_pass"].includes(show as string)) return { error: "นโยบายการแสดงเฉลยไม่ถูกต้อง" };
  const from = optDate(get("available_from") ?? null), until = optDate(get("available_until") ?? null);
  if (from === undefined || until === undefined) return { error: "ช่วงเวลาเปิดสอบไม่ถูกต้อง" };
  if (from && until && from >= until) return { error: "เวลาปิดสอบต้องหลังเวลาเปิดสอบ" };
  const status = get("status") ?? "draft";
  if (status !== "draft" && status !== "published") return { error: "สถานะข้อสอบไม่ถูกต้อง" };

  let questionIds: string[] | undefined;
  if (data.question_ids !== undefined) {
    if (!Array.isArray(data.question_ids) || data.question_ids.length > 300 || data.question_ids.some(id => typeof id !== "string"))
      return { error: "รายการคำถามไม่ถูกต้อง" };
    questionIds = [...new Set(data.question_ids as string[])];
    if (questionIds.length) {
      // One JSON parameter: D1 caps bound parameters at 100 per statement.
      const found = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM question_bank WHERE course_id = ? AND id IN (SELECT value FROM json_each(?))`)
        .bind(courseId, JSON.stringify(questionIds)).first<{ n: number }>();
      if ((found?.n ?? 0) !== questionIds.length) return { error: "คำถามต้องอยู่ในคลังข้อสอบของคอร์สนี้" };
    }
  }
  if (status === "published") {
    if (mode === "random") {
      const bank = await c.env.DB.prepare("SELECT * FROM question_bank WHERE course_id = ?").bind(courseId).all<BankRow>();
      if (!drawQuestions(bank.results, rules)) return { error: "คลังข้อสอบมีคำถามตามเงื่อนไขการสุ่มไม่พอ" };
    } else {
      const count = questionIds ? questionIds.length : current
        ? (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM exam_questions WHERE exam_id = ?").bind(current.id).first<{ n: number }>())?.n ?? 0 : 0;
      if (!count) return { error: "ต้องเลือกคำถามอย่างน้อย 1 ข้อก่อนเผยแพร่ข้อสอบ" };
    }
  }
  return {
    value: {
      title, description: description ?? null, lesson_id: lessonId as string | null, is_final: bool01(get("is_final")), selection_mode: mode as string,
      draw_rules_json: mode === "random" ? JSON.stringify(rules) : null, shuffle_questions: bool01(get("shuffle_questions")),
      shuffle_options: bool01(get("shuffle_options")), time_limit_minutes: timeLimit, max_attempts: maxAttempts, pass_percent: pass,
      show_answers: show as string, available_from: from, available_until: until, status: status as string
    },
    questionIds
  };
}

const saveExamQuestions = (db: D1Database, examId: string, ids: string[]) => [
  db.prepare("DELETE FROM exam_questions WHERE exam_id = ?").bind(examId),
  ...ids.map((qid, i) => db.prepare("INSERT INTO exam_questions (exam_id, question_id, sort_order) VALUES (?, ?, ?)").bind(examId, qid, i))
];

async function loadExam(c: C, examId: string): Promise<{ exam: ExamRow; course: CourseRow } | Response> {
  const exam = await c.env.DB.prepare("SELECT * FROM exams WHERE id = ?").bind(examId).first<ExamRow>();
  if (!exam) return c.json({ error: "ไม่พบข้อสอบ" }, 404);
  const course = await ownCourse(c, exam.course_id);
  if (course instanceof Response) return course;
  return { exam, course };
}

/** GET /api/instructor/courses/:courseId/exams */
assessmentsRouter.get("/instructor/courses/:courseId/exams", rbac(["instructor", "admin"]), async (c) => {
  const course = await ownCourse(c, c.req.param("courseId"));
  if (course instanceof Response) return course;
  const rows = await c.env.DB.prepare(`SELECT e.*, l.title AS lesson_title,
      (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id = e.id) AS question_count,
      (SELECT COUNT(*) FROM exam_attempts a WHERE a.exam_id = e.id AND a.status != 'in_progress') AS attempt_count,
      (SELECT COUNT(*) FROM exam_attempts a WHERE a.exam_id = e.id AND a.status = 'pending_grading') AS pending_count
    FROM exams e LEFT JOIN lessons l ON l.id = e.lesson_id WHERE e.course_id = ? ORDER BY e.created_at, e.id`).bind(course.id).all<ExamRow>();
  return c.json({ exams: rows.results.map(examView), requires_final_exam: !!course.requires_final_exam });
});

/** POST /api/instructor/courses/:courseId/exams */
assessmentsRouter.post("/instructor/courses/:courseId/exams", rbac(["instructor", "admin"]), async (c) => {
  const course = await ownCourse(c, c.req.param("courseId"));
  if (course instanceof Response) return course;
  const data = await body(c);
  if (!data) return c.json({ error: "ข้อมูลข้อสอบไม่ถูกต้อง" }, 400);
  const parsed = await parseExam(c, course.id, data);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const v = parsed.value;
  const id = newId("exam");
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO exams (id, course_id, lesson_id, title, description, is_final, selection_mode, draw_rules_json, shuffle_questions,
      shuffle_options, time_limit_minutes, max_attempts, pass_percent, show_answers, available_from, available_until, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, course.id, v.lesson_id, v.title, v.description, v.is_final,
      v.selection_mode, v.draw_rules_json, v.shuffle_questions, v.shuffle_options, v.time_limit_minutes, v.max_attempts, v.pass_percent,
      v.show_answers, v.available_from, v.available_until, v.status, c.get("user").id),
    ...saveExamQuestions(c.env.DB, id, parsed.questionIds ?? [])
  ]);
  const exam = await c.env.DB.prepare("SELECT * FROM exams WHERE id = ?").bind(id).first<ExamRow>();
  return c.json({ exam: { ...examView(exam!), question_ids: parsed.questionIds ?? [] } }, 201);
});

/** GET /api/instructor/exams/:id */
assessmentsRouter.get("/instructor/exams/:id", rbac(["instructor", "admin"]), async (c) => {
  const loaded = await loadExam(c, c.req.param("id"));
  if (loaded instanceof Response) return loaded;
  const ids = await c.env.DB.prepare("SELECT question_id FROM exam_questions WHERE exam_id = ? ORDER BY sort_order").bind(loaded.exam.id).all<{ question_id: string }>();
  return c.json({ exam: { ...examView(loaded.exam), question_ids: ids.results.map(r => r.question_id) } });
});

/** PATCH /api/instructor/exams/:id */
assessmentsRouter.patch("/instructor/exams/:id", rbac(["instructor", "admin"]), async (c) => {
  const loaded = await loadExam(c, c.req.param("id"));
  if (loaded instanceof Response) return loaded;
  const data = await body(c);
  if (!data) return c.json({ error: "ข้อมูลข้อสอบไม่ถูกต้อง" }, 400);
  const parsed = await parseExam(c, loaded.course.id, data, loaded.exam);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const v = parsed.value;
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE exams SET lesson_id = ?, title = ?, description = ?, is_final = ?, selection_mode = ?, draw_rules_json = ?,
      shuffle_questions = ?, shuffle_options = ?, time_limit_minutes = ?, max_attempts = ?, pass_percent = ?, show_answers = ?,
      available_from = ?, available_until = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(v.lesson_id, v.title,
      v.description, v.is_final, v.selection_mode, v.draw_rules_json, v.shuffle_questions, v.shuffle_options, v.time_limit_minutes,
      v.max_attempts, v.pass_percent, v.show_answers, v.available_from, v.available_until, v.status, loaded.exam.id),
    ...(parsed.questionIds ? saveExamQuestions(c.env.DB, loaded.exam.id, parsed.questionIds) : [])
  ]);
  const exam = await c.env.DB.prepare("SELECT * FROM exams WHERE id = ?").bind(loaded.exam.id).first<ExamRow>();
  const ids = await c.env.DB.prepare("SELECT question_id FROM exam_questions WHERE exam_id = ? ORDER BY sort_order").bind(loaded.exam.id).all<{ question_id: string }>();
  return c.json({ exam: { ...examView(exam!), question_ids: ids.results.map(r => r.question_id) } });
});

/** DELETE /api/instructor/exams/:id — removes attempts too, so it is audited. */
assessmentsRouter.delete("/instructor/exams/:id", rbac(["instructor", "admin"]), async (c) => {
  const loaded = await loadExam(c, c.req.param("id"));
  if (loaded instanceof Response) return loaded;
  // Attempts exist → an emailed code from the course owner or an admin (utils/dangerConfirm.ts).
  const denied = await requireDeleteConfirmation(c, "exam.delete", loaded.exam.id);
  if (denied) return denied;
  await c.env.DB.prepare("DELETE FROM exams WHERE id = ?").bind(loaded.exam.id).run();
  await audit(c, "exam.delete", "exam", loaded.exam.id, loaded.exam.title);
  return c.json({ success: true });
});

/** PATCH /api/instructor/courses/:courseId/assessment-settings { requires_final_exam } */
assessmentsRouter.patch("/instructor/courses/:courseId/assessment-settings", rbac(["instructor", "admin"]), async (c) => {
  const course = await ownCourse(c, c.req.param("courseId"));
  if (course instanceof Response) return course;
  const data = await body(c);
  if (typeof data?.requires_final_exam !== "boolean") return c.json({ error: "ต้องระบุ requires_final_exam เป็น true/false" }, 400);
  await c.env.DB.prepare("UPDATE courses SET requires_final_exam = ? WHERE id = ?").bind(data.requires_final_exam ? 1 : 0, course.id).run();
  return c.json({ requires_final_exam: data.requires_final_exam });
});

// ---------- Attempts: snapshot, learner view, grading ----------

/** Question as frozen into an attempt, including the answer key and the learner's display order. */
interface Snapshot {
  id: string; type: QuestionType; prompt: string; points: number; explanation: string | null;
  options: string[] | { left: string[]; right: string[] } | null;
  answer: number[] | string[] | string[][] | null;
  order: number[] | null; // display order of option indexes (right column for matching)
  /**
   * Per-attempt public id of each stored option index (right column for matching). The stored index is
   * the answer key for ordering/matching (and reveals authoring order for choices), so learners only ever
   * see these random ids; responses are translated back to indexes when grading. Missing on attempts
   * started before this field existed (identity mapping).
   */
  ids?: number[] | null;
}

function snapshot(q: BankRow, shuffleOptions: boolean): Snapshot {
  const options = parseJson<Snapshot["options"]>(q.options_json, null);
  let order: number[] | null = null;
  let count = 0;
  if (q.type === "matching" && options && !Array.isArray(options)) { count = options.right.length; order = shuffle(range(count)); }
  else if (q.type === "ordering" && Array.isArray(options)) {
    count = options.length;
    order = shuffle(range(count));
    // Never show the items already in the right order.
    if (order.every((v, i) => v === i)) order.push(order.shift()!);
  } else if (Array.isArray(options)) {
    count = options.length;
    order = shuffleOptions && q.type !== "true_false" ? shuffle(range(count)) : range(count);
  }
  return { id: q.id, type: q.type, prompt: q.prompt, points: q.points, explanation: q.explanation, options,
    answer: parseJson<Snapshot["answer"]>(q.answer_json, null), order, ids: count ? shuffle(range(count)) : null };
}

/** Stored option index → the id the learner sees for this attempt. */
const publicId = (s: Snapshot, index: number) => s.ids ? s.ids[index] : index;
/** Learner-facing id → stored option index (-1 when unknown). */
const storedIndex = (s: Snapshot, id: unknown) => typeof id !== "number" ? -1 : s.ids ? s.ids.indexOf(id) : id;

/** A cleaned learner response (public ids) mapped to stored option indexes for grading. */
function responseToIndexes(s: Snapshot, r: unknown): unknown {
  if (r === null || r === undefined || !s.ids) return r;
  switch (s.type) {
    case "single": case "true_false": return storedIndex(s, r);
    case "multiple": case "ordering": return (r as number[]).map(id => storedIndex(s, id));
    case "matching": return (r as (number | null)[]).map(id => id === null ? null : storedIndex(s, id));
    default: return r;
  }
}

/** What a learner sees while answering: option ids are random per attempt, never the stored index or the answer key. */
function learnerQuestion(s: Snapshot) {
  const base = { id: s.id, type: s.type, prompt: s.prompt, points: s.points };
  if (s.type === "matching" && s.options && !Array.isArray(s.options)) {
    const o = s.options;
    return { ...base, left: o.left.map((text, id) => ({ id, text })),
      right: (s.order ?? range(o.right.length)).map(index => ({ id: publicId(s, index), text: o.right[index] })) };
  }
  if (s.type === "fill_blank") return { ...base, blanks: s.prompt.match(BLANK)?.length || 0 };
  if (Array.isArray(s.options)) return { ...base, options: (s.order ?? range(s.options.length)).map(index => ({ id: publicId(s, index), text: (s.options as string[])[index] })) };
  return base;
}

/** Validates a learner response's shape for the question type; null = invalid. */
function cleanResponse(s: Snapshot, r: unknown): unknown {
  if (r === null || r === undefined) return null;
  const n = Array.isArray(s.options) ? s.options.length : 0;
  const isIdx = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < max;
  switch (s.type) {
    case "single": case "true_false": {
      const v = Array.isArray(r) ? r[0] : r;
      return isIdx(v, n) ? v : undefined;
    }
    case "multiple":
      return Array.isArray(r) && r.length <= n && r.every(v => isIdx(v, n)) ? [...new Set(r as number[])] : undefined;
    case "short":
      return typeof r === "string" && r.length <= 1000 ? r : undefined;
    case "essay":
      return typeof r === "string" && r.length <= 20000 ? r : undefined;
    case "fill_blank": {
      const blanks = s.prompt.match(BLANK)?.length || 0;
      return Array.isArray(r) && r.length <= blanks && r.every(v => typeof v === "string" && v.length <= 500) ? r : undefined;
    }
    case "matching": {
      const m = s.options && !Array.isArray(s.options) ? s.options.left.length : 0;
      return Array.isArray(r) && r.length <= m && r.every(v => v === null || isIdx(v, m)) ? r : undefined;
    }
    case "ordering":
      return Array.isArray(r) && r.length === n && new Set(r).size === n && r.every(v => isIdx(v, n)) ? r : undefined;
  }
}

/** Auto-grades one answer; correct = null for essays (manual grading). Partial credit for blanks and matching. */
export function gradeAnswer(s: Snapshot, r: unknown): { correct: boolean | null; points: number } {
  const full = s.points;
  if (s.type === "essay") return { correct: null, points: 0 };
  if (r === null || r === undefined) return { correct: false, points: 0 };
  r = responseToIndexes(s, r);
  const key = s.answer as any;
  switch (s.type) {
    case "single": case "true_false": {
      const ok = r === key[0];
      return { correct: ok, points: ok ? full : 0 };
    }
    case "multiple": {
      const got = [...(r as number[])].sort((a, b) => a - b);
      const ok = got.length === key.length && got.every((v, i) => v === key[i]);
      return { correct: ok, points: ok ? full : 0 };
    }
    case "short": {
      const ok = (key as string[]).some(a => normalizeAnswer(a) === normalizeAnswer(r as string));
      return { correct: ok, points: ok ? full : 0 };
    }
    case "fill_blank": {
      const blanks = key as string[][];
      const hits = blanks.filter((accepted, i) => typeof (r as string[])[i] === "string"
        && accepted.some(a => normalizeAnswer(a) === normalizeAnswer((r as string[])[i]))).length;
      return { correct: hits === blanks.length, points: round2(full * hits / blanks.length) };
    }
    case "matching": {
      const pairs = key as number[];
      const hits = pairs.filter((right, left) => (r as number[])[left] === right).length;
      return { correct: hits === pairs.length, points: round2(full * hits / pairs.length) };
    }
    case "ordering": {
      const ok = (r as number[]).every((v, i) => v === i);
      return { correct: ok, points: ok ? full : 0 };
    }
  }
}

/**
 * Correct answer in the learner's option ids (shown only when the exam policy allows): choice indexes,
 * accepted texts, per-blank accepted texts, right id per left id (matching) or item ids in order.
 */
function correctAnswerView(s: Snapshot) {
  if (s.type === "essay" || !s.answer) return null;
  const key = s.answer as number[];
  switch (s.type) {
    case "single": case "multiple": case "true_false": return key.map(i => publicId(s, i)).sort((a, b) => a - b);
    case "matching": return key.map(right => publicId(s, right)); // right id per left id
    case "ordering": return key.map(i => publicId(s, i)); // item ids in the correct order
    default: return s.answer;
  }
}

interface AttemptRow {
  id: string; exam_id: string; user_id: string; attempt_no: number; status: "in_progress" | "pending_grading" | "graded";
  question_set_json: string; started_at: string; deadline_at: string | null; submitted_at: string | null; auto_closed: number;
  score: number | null; max_score: number | null; percent: number | null; passed: number | null; feedback: string | null;
  graded_at: string | null;
}
interface AnswerRow { question_id: string; response_json: string | null; is_correct: number | null; points_awarded: number | null; max_points: number; feedback: string | null }

/** Recomputes totals from exam_answers; essays without points keep the attempt pending. */
async function recomputeAttempt(db: D1Database, attempt: AttemptRow, passPercent: number, extra: { gradedBy?: string; feedback?: string | null } = {}) {
  const set = parseJson<Snapshot[]>(attempt.question_set_json, []);
  const answers = await db.prepare("SELECT * FROM exam_answers WHERE attempt_id = ?").bind(attempt.id).all<AnswerRow>();
  const byId = new Map(answers.results.map(a => [a.question_id, a]));
  const max = round2(set.reduce((sum, q) => sum + q.points, 0));
  let score = 0, pending = false;
  for (const q of set) {
    const a = byId.get(q.id);
    if (q.type === "essay" && (a?.points_awarded === null || a?.points_awarded === undefined)) pending = true;
    score += a?.points_awarded ?? 0;
  }
  score = round2(score);
  const percent = max > 0 ? round2(score / max * 100) : 0;
  const status = pending ? "pending_grading" : "graded";
  await db.prepare(`UPDATE exam_attempts SET status = ?, score = ?, max_score = ?, percent = ?, passed = ?,
      feedback = COALESCE(?, feedback), graded_by = COALESCE(?, graded_by), graded_at = CASE WHEN ? = 'graded' THEN ? ELSE graded_at END
    WHERE id = ?`).bind(status, score, max, percent, pending ? null : percent >= passPercent ? 1 : 0, extra.feedback ?? null,
    extra.gradedBy ?? null, status, iso(Date.now()), attempt.id).run();
  return { status, score, max_score: max, percent, passed: pending ? null : percent >= passPercent };
}

/** Grades and closes an in-progress attempt. Conditional update so a double submit grades once. */
async function finalizeAttempt(c: C, attempt: AttemptRow, exam: ExamRow, now: number, autoClosed: boolean) {
  const db = c.env.DB;
  const closed = await db.prepare("UPDATE exam_attempts SET status = 'pending_grading', submitted_at = ?, auto_closed = ? WHERE id = ? AND status = 'in_progress'")
    .bind(iso(now), autoClosed ? 1 : 0, attempt.id).run();
  if (!closed.meta.changes) return null;
  const set = parseJson<Snapshot[]>(attempt.question_set_json, []);
  const saved = await db.prepare("SELECT question_id, response_json FROM exam_answers WHERE attempt_id = ?").bind(attempt.id).all<{ question_id: string; response_json: string | null }>();
  const responses = new Map(saved.results.map(r => [r.question_id, parseJson<unknown>(r.response_json, null)]));
  let hasEssay = false;
  await db.batch(set.map(q => {
    const g = gradeAnswer(q, responses.get(q.id));
    if (q.type === "essay") hasEssay = true;
    return db.prepare(`INSERT INTO exam_answers (attempt_id, question_id, response_json, is_correct, points_awarded, max_points)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(attempt_id, question_id) DO UPDATE SET is_correct = excluded.is_correct,
      points_awarded = excluded.points_awarded, max_points = excluded.max_points`).bind(attempt.id, q.id,
      responses.has(q.id) ? JSON.stringify(responses.get(q.id)) : null, g.correct === null ? null : g.correct ? 1 : 0,
      q.type === "essay" ? null : g.points, q.points);
  }));
  const result = await recomputeAttempt(db, attempt, exam.pass_percent);
  await trackEvent(db, attempt.user_id, "exam_submit", { courseId: exam.course_id, lessonId: exam.lesson_id,
    data: { exam_id: exam.id, attempt_id: attempt.id, percent: result.percent, passed: result.passed, auto_closed: autoClosed } });
  if (hasEssay) {
    const course = await db.prepare("SELECT instructor_id FROM courses WHERE id = ?").bind(exam.course_id).first<{ instructor_id: string }>();
    if (course) await createNotification(db, course.instructor_id, "มีข้อสอบอัตนัยรอตรวจ", `ข้อสอบ "${exam.title}" มีคำตอบอัตนัยรอให้คะแนน`);
  }
  return result;
}

/** Closes the attempt with its saved answers once the deadline (plus grace) has passed. */
async function closeIfExpired(c: C, attempt: AttemptRow, exam: ExamRow, now: number) {
  if (attempt.status !== "in_progress" || !attempt.deadline_at || Date.parse(attempt.deadline_at) + DEADLINE_GRACE_MS >= now) return false;
  await finalizeAttempt(c, attempt, exam, now, true);
  return true;
}

/** Learner view of an attempt: questions while open, results (per show_answers policy) once closed. */
async function attemptView(db: D1Database, attempt: AttemptRow, exam: ExamRow, forStaff = false) {
  const set = parseJson<Snapshot[]>(attempt.question_set_json, []);
  const answers = await db.prepare("SELECT * FROM exam_answers WHERE attempt_id = ?").bind(attempt.id).all<AnswerRow>();
  const byId = new Map(answers.results.map(a => [a.question_id, a]));
  const open = attempt.status === "in_progress";
  const reveal = forStaff || exam.show_answers === "after_submit" || (exam.show_answers === "after_pass" && attempt.passed === 1);
  const showMarks = forStaff || exam.show_answers !== "never";
  return {
    id: attempt.id, exam_id: exam.id, exam_title: exam.title, attempt_no: attempt.attempt_no, status: attempt.status,
    started_at: attempt.started_at, deadline_at: attempt.deadline_at, submitted_at: attempt.submitted_at, auto_closed: !!attempt.auto_closed,
    score: open ? null : attempt.score, max_score: open ? null : attempt.max_score, percent: open ? null : attempt.percent,
    passed: open || attempt.passed === null ? null : !!attempt.passed, pass_percent: exam.pass_percent, feedback: attempt.feedback,
    answers_revealed: !open && reveal,
    questions: set.map(q => {
      const a = byId.get(q.id);
      const view: Record<string, unknown> = { ...learnerQuestion(q), response: parseJson(a?.response_json, null) };
      if (!open && showMarks) Object.assign(view, { is_correct: a?.is_correct === null || a?.is_correct === undefined ? null : !!a.is_correct,
        points_awarded: a?.points_awarded ?? null, feedback: a?.feedback ?? null });
      if (!open && reveal) Object.assign(view, { correct_answer: correctAnswerView(q), explanation: q.explanation });
      return view;
    })
  };
}

// ---------- Exams (learner) ----------

async function learnerExam(c: C, examId: string): Promise<ExamRow | Response> {
  const exam = await c.env.DB.prepare("SELECT * FROM exams WHERE id = ? AND status = 'published'").bind(examId).first<ExamRow>();
  if (!exam) return c.json({ error: "ไม่พบข้อสอบ" }, 404);
  if (!(await activeEnrollment(c.env.DB, c.get("user").id, exam.course_id))) return notEnrolled(c);
  // An exam attached to a lesson opens with that lesson (drip / date / sequential locks).
  if (exam.lesson_id) {
    const locked = await lessonLockResponse(c, exam.lesson_id);
    if (locked) return locked;
  }
  return exam;
}

/**
 * Start (or resume) an attempt. Draws and snapshots the questions, sets the server deadline.
 * POST /api/student/exams/:id/start
 */
assessmentsRouter.post("/student/exams/:id/start", rbac(["student", "admin"]), async (c) => {
  const exam = await learnerExam(c, c.req.param("id"));
  if (exam instanceof Response) return exam;
  const user = c.get("user");
  const db = c.env.DB;
  const now = nowMs(c);

  const open = await db.prepare("SELECT * FROM exam_attempts WHERE exam_id = ? AND user_id = ? AND status = 'in_progress'").bind(exam.id, user.id).first<AttemptRow>();
  if (open && !(await closeIfExpired(c, open, exam, now))) return c.json({ attempt: await attemptView(db, open, exam), resumed: true });

  if (exam.available_from && Date.parse(exam.available_from) > now) return c.json({ error: "ข้อสอบยังไม่เปิดให้ทำ" }, 403);
  if (exam.available_until && Date.parse(exam.available_until) <= now) return c.json({ error: "ข้อสอบปิดรับแล้ว" }, 403);
  const used = await db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(attempt_no), 0) AS last FROM exam_attempts WHERE exam_id = ? AND user_id = ?")
    .bind(exam.id, user.id).first<{ n: number; last: number }>();
  if (exam.max_attempts && (used?.n ?? 0) >= exam.max_attempts) return c.json({ error: `ทำข้อสอบครบ ${exam.max_attempts} ครั้งแล้ว` }, 403);

  let questions: BankRow[];
  if (exam.selection_mode === "random") {
    const bank = await db.prepare("SELECT * FROM question_bank WHERE course_id = ?").bind(exam.course_id).all<BankRow>();
    const drawn = drawQuestions(bank.results, parseJson<DrawRule[]>(exam.draw_rules_json, []));
    if (!drawn) return c.json({ error: "คลังข้อสอบมีคำถามไม่พอ กรุณาแจ้งผู้สอน" }, 409);
    questions = drawn;
  } else {
    const rows = await db.prepare(`SELECT q.* FROM exam_questions eq JOIN question_bank q ON q.id = eq.question_id
      WHERE eq.exam_id = ? ORDER BY eq.sort_order`).bind(exam.id).all<BankRow>();
    questions = rows.results;
  }
  if (!questions.length) return c.json({ error: "ข้อสอบนี้ยังไม่มีคำถาม" }, 409);
  if (exam.shuffle_questions) questions = shuffle(questions);
  const set = questions.map(q => snapshot(q, !!exam.shuffle_options));

  let deadline = exam.time_limit_minutes ? now + exam.time_limit_minutes * 60_000 : null;
  if (exam.available_until) deadline = Math.min(deadline ?? Infinity, Date.parse(exam.available_until));
  const id = newId("att");
  try {
    await db.prepare(`INSERT INTO exam_attempts (id, exam_id, user_id, attempt_no, status, question_set_json, started_at, deadline_at)
      VALUES (?, ?, ?, ?, 'in_progress', ?, ?, ?)`).bind(id, exam.id, user.id, (used?.last ?? 0) + 1, JSON.stringify(set), iso(now),
      deadline === null ? null : iso(deadline)).run();
  } catch {
    // A parallel start created the attempt first (unique open attempt / attempt number).
    return c.json({ error: "มีการเริ่มทำข้อสอบนี้อยู่แล้ว กรุณาโหลดหน้าใหม่" }, 409);
  }
  const attempt = await db.prepare("SELECT * FROM exam_attempts WHERE id = ?").bind(id).first<AttemptRow>();
  return c.json({ attempt: await attemptView(db, attempt!, exam), resumed: false }, 201);
});

async function learnerAttempt(c: C, attemptId: string): Promise<{ attempt: AttemptRow; exam: ExamRow } | Response> {
  const attempt = await c.env.DB.prepare("SELECT * FROM exam_attempts WHERE id = ? AND user_id = ?").bind(attemptId, c.get("user").id).first<AttemptRow>();
  if (!attempt) return c.json({ error: "ไม่พบการทำข้อสอบนี้" }, 404);
  const exam = await c.env.DB.prepare("SELECT * FROM exams WHERE id = ?").bind(attempt.exam_id).first<ExamRow>();
  if (!exam) return c.json({ error: "ไม่พบข้อสอบ" }, 404);
  return { attempt, exam };
}

/** GET /api/student/exam-attempts/:id */
assessmentsRouter.get("/student/exam-attempts/:id", rbac(["student", "admin"]), async (c) => {
  const loaded = await learnerAttempt(c, c.req.param("id"));
  if (loaded instanceof Response) return loaded;
  let { attempt } = loaded;
  if (await closeIfExpired(c, attempt, loaded.exam, nowMs(c))) {
    attempt = (await c.env.DB.prepare("SELECT * FROM exam_attempts WHERE id = ?").bind(attempt.id).first<AttemptRow>())!;
  }
  return c.json({ attempt: await attemptView(c.env.DB, attempt, loaded.exam) });
});

/** Stores responses for an open attempt; refuses once the deadline has passed. */
async function saveResponses(c: C, attempt: AttemptRow, answers: unknown): Promise<string | null> {
  if (answers === undefined) return null;
  if (!isObj(answers)) return "รูปแบบคำตอบไม่ถูกต้อง";
  const set = new Map(parseJson<Snapshot[]>(attempt.question_set_json, []).map(q => [q.id, q]));
  const stmts: D1PreparedStatement[] = [];
  for (const [qid, value] of Object.entries(answers)) {
    const q = set.get(qid);
    if (!q) return "คำถามไม่อยู่ในชุดข้อสอบนี้";
    const clean = cleanResponse(q, value);
    if (clean === undefined) return "รูปแบบคำตอบไม่ถูกต้อง";
    stmts.push(c.env.DB.prepare(`INSERT INTO exam_answers (attempt_id, question_id, response_json, max_points) VALUES (?, ?, ?, ?)
      ON CONFLICT(attempt_id, question_id) DO UPDATE SET response_json = excluded.response_json, saved_at = CURRENT_TIMESTAMP`)
      .bind(attempt.id, qid, clean === null ? null : JSON.stringify(clean), q.points));
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return null;
}

const pastDeadline = (attempt: AttemptRow, now: number) => !!attempt.deadline_at && Date.parse(attempt.deadline_at) + DEADLINE_GRACE_MS < now;

/** Autosave: PUT /api/student/exam-attempts/:id/answers { answers: { [questionId]: response } } */
assessmentsRouter.put("/student/exam-attempts/:id/answers", rbac(["student", "admin"]), async (c) => {
  const loaded = await learnerAttempt(c, c.req.param("id"));
  if (loaded instanceof Response) return loaded;
  const { attempt, exam } = loaded;
  if (attempt.status !== "in_progress") return c.json({ error: "การทำข้อสอบนี้ปิดแล้ว" }, 409);
  const now = nowMs(c);
  if (pastDeadline(attempt, now)) {
    await finalizeAttempt(c, attempt, exam, now, true);
    return c.json({ error: "หมดเวลาทำข้อสอบแล้ว ระบบส่งคำตอบที่บันทึกไว้ให้อัตโนมัติ", auto_closed: true }, 409);
  }
  const error = await saveResponses(c, attempt, (await body(c))?.answers);
  if (error) return c.json({ error }, 400);
  return c.json({ saved: true, deadline_at: attempt.deadline_at });
});

/** POST /api/student/exam-attempts/:id/submit { answers? } */
assessmentsRouter.post("/student/exam-attempts/:id/submit", rbac(["student", "admin"]), async (c) => {
  const loaded = await learnerAttempt(c, c.req.param("id"));
  if (loaded instanceof Response) return loaded;
  const { attempt, exam } = loaded;
  if (attempt.status !== "in_progress") return c.json({ error: "ส่งข้อสอบนี้ไปแล้ว" }, 409);
  const now = nowMs(c);
  if (pastDeadline(attempt, now)) {
    // Late answers are ignored; what was saved before the deadline is graded.
    await finalizeAttempt(c, attempt, exam, now, true);
    const closed = await c.env.DB.prepare("SELECT * FROM exam_attempts WHERE id = ?").bind(attempt.id).first<AttemptRow>();
    return c.json({ error: "หมดเวลาทำข้อสอบแล้ว ระบบตรวจเฉพาะคำตอบที่บันทึกไว้ก่อนหมดเวลา", auto_closed: true,
      attempt: await attemptView(c.env.DB, closed!, exam) }, 409);
  }
  const error = await saveResponses(c, attempt, (await body(c))?.answers);
  if (error) return c.json({ error }, 400);
  const result = await finalizeAttempt(c, attempt, exam, now, false);
  if (!result) return c.json({ error: "ส่งข้อสอบนี้ไปแล้ว" }, 409);
  const closed = await c.env.DB.prepare("SELECT * FROM exam_attempts WHERE id = ?").bind(attempt.id).first<AttemptRow>();
  return c.json({ attempt: await attemptView(c.env.DB, closed!, exam) });
});

// ---------- Grading exams (instructor) ----------

async function staffAttempt(c: C, attemptId: string): Promise<{ attempt: AttemptRow; exam: ExamRow } | Response> {
  const attempt = await c.env.DB.prepare("SELECT * FROM exam_attempts WHERE id = ?").bind(attemptId).first<AttemptRow>();
  if (!attempt) return c.json({ error: "ไม่พบการทำข้อสอบนี้" }, 404);
  const loaded = await loadExam(c, attempt.exam_id);
  if (loaded instanceof Response) return loaded;
  return { attempt, exam: loaded.exam };
}

/** GET /api/instructor/exams/:id/attempts */
assessmentsRouter.get("/instructor/exams/:id/attempts", rbac(["instructor", "admin"]), async (c) => {
  const loaded = await loadExam(c, c.req.param("id"));
  if (loaded instanceof Response) return loaded;
  const rows = await c.env.DB.prepare(`SELECT a.id, a.user_id, u.name AS user_name, u.email AS user_email, a.attempt_no, a.status, a.started_at,
      a.deadline_at, a.submitted_at, a.auto_closed, a.score, a.max_score, a.percent, a.passed
    FROM exam_attempts a JOIN users u ON u.id = a.user_id WHERE a.exam_id = ? ORDER BY a.started_at DESC`).bind(loaded.exam.id).all();
  return c.json({ attempts: rows.results });
});

/** GET /api/instructor/exam-attempts/:id — full detail with answer keys for grading. */
assessmentsRouter.get("/instructor/exam-attempts/:id", rbac(["instructor", "admin"]), async (c) => {
  const loaded = await staffAttempt(c, c.req.param("id"));
  if (loaded instanceof Response) return loaded;
  const learner = await c.env.DB.prepare("SELECT name, email FROM users WHERE id = ?").bind(loaded.attempt.user_id).first<{ name: string; email: string }>();
  return c.json({ attempt: { ...(await attemptView(c.env.DB, loaded.attempt, loaded.exam, true)), user_name: learner?.name, user_email: learner?.email } });
});

/**
 * Manual grading (essays, or overriding any question's points).
 * POST /api/instructor/exam-attempts/:id/grade { grades: [{ question_id, points, feedback? }], feedback? }
 */
assessmentsRouter.post("/instructor/exam-attempts/:id/grade", rbac(["instructor", "admin"]), async (c) => {
  const loaded = await staffAttempt(c, c.req.param("id"));
  if (loaded instanceof Response) return loaded;
  const { attempt, exam } = loaded;
  if (attempt.status === "in_progress") return c.json({ error: "ผู้เรียนยังทำข้อสอบไม่เสร็จ" }, 409);
  const data = await body(c);
  const grades = data?.grades;
  if (!Array.isArray(grades) || grades.length > 300) return c.json({ error: "ต้องระบุคะแนนในฟิลด์ grades" }, 400);
  const feedback = optStr(data?.feedback, 5000);
  if (feedback === undefined && data?.feedback !== undefined) return c.json({ error: "ความคิดเห็นยาวเกินไป" }, 400);
  const set = new Map(parseJson<Snapshot[]>(attempt.question_set_json, []).map(q => [q.id, q]));
  const stmts: D1PreparedStatement[] = [];
  for (const g of grades) {
    if (!isObj(g) || typeof g.question_id !== "string" || !set.has(g.question_id)) return c.json({ error: "คำถามไม่อยู่ในชุดข้อสอบนี้" }, 400);
    const q = set.get(g.question_id)!;
    const points = Number(g.points);
    if (!Number.isFinite(points) || points < 0 || points > q.points) return c.json({ error: `คะแนนต้องอยู่ระหว่าง 0–${q.points}` }, 400);
    const note = optStr(g.feedback, 5000);
    if (note === undefined && g.feedback !== undefined) return c.json({ error: "ความคิดเห็นยาวเกินไป" }, 400);
    stmts.push(c.env.DB.prepare(`INSERT INTO exam_answers (attempt_id, question_id, response_json, is_correct, points_awarded, max_points, feedback)
      VALUES (?, ?, NULL, ?, ?, ?, ?) ON CONFLICT(attempt_id, question_id) DO UPDATE SET is_correct = excluded.is_correct,
      points_awarded = excluded.points_awarded, feedback = excluded.feedback`).bind(attempt.id, q.id, points >= q.points ? 1 : 0,
      round2(points), q.points, note ?? null));
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  const result = await recomputeAttempt(c.env.DB, attempt, exam.pass_percent, { gradedBy: c.get("user").id, feedback: feedback ?? null });
  if (result.status === "graded") {
    await createNotification(c.env.DB, attempt.user_id, "ข้อสอบได้รับการตรวจแล้ว",
      `ข้อสอบ "${exam.title}" ได้ ${result.percent}% ${result.passed ? "ผ่านเกณฑ์" : "ยังไม่ผ่านเกณฑ์"}`);
  }
  return c.json({ result });
});

// ---------- Exam report ----------

async function examStats(db: D1Database, exam: ExamRow) {
  const attempts = await db.prepare(`SELECT a.id, a.user_id, u.name AS user_name, u.email AS user_email, a.attempt_no, a.status, a.started_at,
      a.submitted_at, a.auto_closed, a.score, a.max_score, a.percent, a.passed, a.question_set_json
    FROM exam_attempts a JOIN users u ON u.id = a.user_id WHERE a.exam_id = ? AND a.status != 'in_progress' ORDER BY a.submitted_at`)
    .bind(exam.id).all<AttemptRow & { user_name: string; user_email: string }>();
  const list = attempts.results;
  const answers = await db.prepare(`SELECT ea.attempt_id, ea.question_id, ea.points_awarded, ea.max_points FROM exam_answers ea
    JOIN exam_attempts a ON a.id = ea.attempt_id WHERE a.exam_id = ? AND a.status != 'in_progress'`).bind(exam.id)
    .all<{ attempt_id: string; question_id: string; points_awarded: number | null; max_points: number }>();
  const graded = list.filter(a => a.status === "graded");
  const avg = graded.length ? round2(graded.reduce((s, a) => s + (a.percent ?? 0), 0) / graded.length) : null;
  const passRate = graded.length ? round2(graded.filter(a => a.passed === 1).length / graded.length * 100) : null;

  // Item analysis: p = mean share of points; D = p(top 27%) − p(bottom 27%) by attempt percent.
  const sorted = [...list].sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0));
  const k = sorted.length >= 2 ? Math.max(1, Math.round(sorted.length * 0.27)) : 0;
  const top = new Set(sorted.slice(0, k).map(a => a.id)), bottom = new Set(sorted.slice(-k).map(a => a.id));
  const prompts = new Map<string, { prompt: string; type: string }>();
  for (const a of list) for (const q of parseJson<Snapshot[]>(a.question_set_json, [])) if (!prompts.has(q.id)) prompts.set(q.id, { prompt: q.prompt, type: q.type });
  const byQuestion = new Map<string, { n: number; sum: number; top: number[]; bottom: number[] }>();
  for (const ans of answers.results) {
    if (ans.points_awarded === null || !ans.max_points) continue;
    const share = ans.points_awarded / ans.max_points;
    const s = byQuestion.get(ans.question_id) ?? { n: 0, sum: 0, top: [], bottom: [] };
    s.n++; s.sum += share;
    if (top.has(ans.attempt_id)) s.top.push(share);
    if (bottom.has(ans.attempt_id)) s.bottom.push(share);
    byQuestion.set(ans.question_id, s);
  }
  const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const questions = [...prompts.entries()].map(([id, meta]) => {
    const s = byQuestion.get(id);
    const pt = s ? mean(s.top) : null, pb = s ? mean(s.bottom) : null;
    return { question_id: id, prompt: meta.prompt, type: meta.type, responses: s?.n ?? 0,
      difficulty_index: s?.n ? round2(s.sum / s.n) : null, // share of points earned (higher = easier)
      discrimination: pt !== null && pb !== null && k > 0 ? round2(pt - pb) : null };
  });
  return {
    summary: { attempts: list.length, learners: new Set(list.map(a => a.user_id)).size, graded: graded.length,
      pending: list.length - graded.length, average_percent: avg, pass_rate: passRate },
    questions, attempts: list.map(({ question_set_json, ...a }) => a)
  };
}

/** GET /api/instructor/exams/:id/report */
assessmentsRouter.get("/instructor/exams/:id/report", rbac(["instructor", "admin"]), async (c) => {
  const loaded = await loadExam(c, c.req.param("id"));
  if (loaded instanceof Response) return loaded;
  return c.json({ exam: examView(loaded.exam), ...(await examStats(c.env.DB, loaded.exam)) });
});

const STATUS_TH: Record<string, string> = { in_progress: "กำลังทำ", pending_grading: "รอตรวจ", graded: "ตรวจแล้ว" };

/** GET /api/instructor/exams/:id/report/export — attempts as CSV. */
assessmentsRouter.get("/instructor/exams/:id/report/export", rbac(["instructor", "admin"]), async (c) => {
  const loaded = await loadExam(c, c.req.param("id"));
  if (loaded instanceof Response) return loaded;
  const stats = await examStats(c.env.DB, loaded.exam);
  const header = ["ผู้เรียน", "อีเมล", "ครั้งที่", "สถานะ", "คะแนน", "คะแนนเต็ม", "ร้อยละ", "ผล", "เริ่ม", "ส่ง", "ปิดอัตโนมัติ"];
  const rows = stats.attempts.map(a => [a.user_name, a.user_email, a.attempt_no, STATUS_TH[a.status] || a.status, a.score, a.max_score,
    a.percent, a.passed === null ? "รอตรวจ" : a.passed ? "ผ่าน" : "ไม่ผ่าน", a.started_at, a.submitted_at, a.auto_closed ? "ใช่" : ""]);
  return csvResponse([header, ...rows], `exam-report-${loaded.exam.id}.csv`);
});

// ---------- Final exam gate (used by the certificate claim in student.ts) ----------

/**
 * When the course requires a final exam and has a published one, the learner must have passed it.
 * Returns an error message, or null when the certificate may be issued.
 */
export async function finalExamBlock(db: D1Database, userId: string, courseId: string): Promise<string | null> {
  const course = await db.prepare("SELECT requires_final_exam FROM courses WHERE id = ?").bind(courseId).first<{ requires_final_exam: number }>();
  if (!course?.requires_final_exam) return null;
  const finals = await db.prepare("SELECT COUNT(*) AS n FROM exams WHERE course_id = ? AND is_final = 1 AND status = 'published'").bind(courseId).first<{ n: number }>();
  if (!finals?.n) return null;
  const passed = await db.prepare(`SELECT 1 FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
    WHERE a.user_id = ? AND e.course_id = ? AND e.is_final = 1 AND e.status = 'published' AND a.passed = 1 LIMIT 1`).bind(userId, courseId).first();
  return passed ? null : "ต้องสอบผ่านข้อสอบปลายภาคก่อนรับใบประกาศนียบัตร";
}

// ---------- Assignments ----------

interface AssignmentRow {
  id: string; course_id: string; lesson_id: string; title: string; instructions: string | null; max_score: number; due_at: string | null;
  late_policy: "accept" | "penalty" | "reject"; late_penalty_percent: number; allow_text: number; allow_files: number; rubric_json: string;
  status: "draft" | "published"; created_at: string; updated_at: string;
}
interface Criterion { criterion: string; max_points: number }
interface SubmissionRow {
  id: string; assignment_id: string; user_id: string; version: number; text_content: string | null; files_json: string;
  status: "submitted" | "graded" | "returned"; is_late: number; submitted_at: string; score: number | null; final_score: number | null;
  rubric_scores_json: string | null; feedback: string | null; graded_at: string | null;
}
interface FileRef { key: string; name: string; size: number; content_type: string }

const assignmentView = (a: AssignmentRow) => ({ ...a, rubric: parseJson<Criterion[]>(a.rubric_json, []), rubric_json: undefined,
  allow_text: !!a.allow_text, allow_files: !!a.allow_files });
const submissionView = (s: SubmissionRow) => ({ ...s, files: parseJson<FileRef[]>(s.files_json, []).map(f => ({ name: f.name, size: f.size, content_type: f.content_type })),
  files_json: undefined, rubric_scores: parseJson<number[] | null>(s.rubric_scores_json, null), rubric_scores_json: undefined, is_late: !!s.is_late });

async function parseAssignment(c: C, courseId: string, data: Record<string, unknown>, current?: AssignmentRow) {
  const get = <K extends keyof AssignmentRow>(k: K) => (data[k] !== undefined ? data[k] : current?.[k]) as unknown;
  const lessonId = get("lesson_id");
  if (typeof lessonId !== "string" || !(await c.env.DB.prepare("SELECT 1 FROM lessons WHERE id = ? AND course_id = ?").bind(lessonId, courseId).first()))
    return { error: "ต้องเลือกบทเรียนในคอร์สนี้" };
  const title = str(get("title"), 200);
  if (!title) return { error: "ต้องระบุชื่องาน (ไม่เกิน 200 ตัวอักษร)" };
  const instructions = optStr(get("instructions") ?? null, 20000);
  if (instructions === undefined) return { error: "คำชี้แจงยาวเกินไป" };
  const rubricRaw = data.rubric !== undefined ? data.rubric : parseJson(current?.rubric_json, []);
  if (!Array.isArray(rubricRaw) || rubricRaw.length > 20) return { error: "เกณฑ์การให้คะแนนไม่เกิน 20 ข้อ" };
  const rubric: Criterion[] = [];
  for (const r of rubricRaw) {
    const criterion = isObj(r) ? str(r.criterion, 200) : null;
    const max = isObj(r) ? Number(r.max_points) : NaN;
    if (!criterion || !Number.isFinite(max) || max <= 0 || max > 1000) return { error: "เกณฑ์แต่ละข้อต้องมีชื่อและคะแนนเต็ม 1–1,000" };
    rubric.push({ criterion, max_points: round2(max) });
  }
  const maxScore = rubric.length ? round2(rubric.reduce((s, r) => s + r.max_points, 0)) : Number(get("max_score") ?? 100);
  if (!Number.isFinite(maxScore) || maxScore <= 0 || maxScore > 10000) return { error: "คะแนนเต็มต้องมากกว่า 0" };
  const due = optDate(get("due_at") ?? null);
  if (due === undefined) return { error: "กำหนดส่งไม่ถูกต้อง" };
  const policy = get("late_policy") ?? "accept";
  if (!["accept", "penalty", "reject"].includes(policy as string)) return { error: "นโยบายส่งช้าไม่ถูกต้อง" };
  const penalty = Number(get("late_penalty_percent") ?? 0);
  if (!Number.isFinite(penalty) || penalty < 0 || penalty > 100) return { error: "ค่าปรับส่งช้าต้องเป็น 0–100%" };
  const allowText = bool01(get("allow_text") ?? 1), allowFiles = bool01(get("allow_files") ?? 1);
  if (!allowText && !allowFiles) return { error: "ต้องเปิดให้ส่งข้อความหรือไฟล์อย่างน้อยหนึ่งอย่าง" };
  const status = get("status") ?? "draft";
  if (status !== "draft" && status !== "published") return { error: "สถานะไม่ถูกต้อง" };
  return { value: { lesson_id: lessonId, title, instructions: instructions ?? null, max_score: maxScore, due_at: due, late_policy: policy as string,
    late_penalty_percent: penalty, allow_text: allowText, allow_files: allowFiles, rubric_json: JSON.stringify(rubric), status: status as string } };
}

async function loadAssignment(c: C, id: string): Promise<{ assignment: AssignmentRow; course: CourseRow } | Response> {
  const assignment = await c.env.DB.prepare("SELECT * FROM assignments WHERE id = ?").bind(id).first<AssignmentRow>();
  if (!assignment) return c.json({ error: "ไม่พบงานที่มอบหมาย" }, 404);
  const course = await ownCourse(c, assignment.course_id);
  if (course instanceof Response) return course;
  return { assignment, course };
}

/** GET /api/instructor/courses/:courseId/assignments */
assessmentsRouter.get("/instructor/courses/:courseId/assignments", rbac(["instructor", "admin"]), async (c) => {
  const course = await ownCourse(c, c.req.param("courseId"));
  if (course instanceof Response) return course;
  const rows = await c.env.DB.prepare(`SELECT a.*, l.title AS lesson_title,
      (SELECT COUNT(*) FROM assignment_submissions s WHERE s.assignment_id = a.id) AS submission_count,
      (SELECT COUNT(*) FROM assignment_submissions s WHERE s.assignment_id = a.id AND s.status = 'submitted') AS pending_count
    FROM assignments a JOIN lessons l ON l.id = a.lesson_id WHERE a.course_id = ? ORDER BY l.sort_order, a.created_at`).bind(course.id).all<AssignmentRow>();
  return c.json({ assignments: rows.results.map(assignmentView) });
});

/** POST /api/instructor/courses/:courseId/assignments */
assessmentsRouter.post("/instructor/courses/:courseId/assignments", rbac(["instructor", "admin"]), async (c) => {
  const course = await ownCourse(c, c.req.param("courseId"));
  if (course instanceof Response) return course;
  const data = await body(c);
  if (!data) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const parsed = await parseAssignment(c, course.id, data);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const v = parsed.value, id = newId("asg");
  await c.env.DB.prepare(`INSERT INTO assignments (id, course_id, lesson_id, title, instructions, max_score, due_at, late_policy, late_penalty_percent,
    allow_text, allow_files, rubric_json, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, course.id, v.lesson_id,
    v.title, v.instructions, v.max_score, v.due_at, v.late_policy, v.late_penalty_percent, v.allow_text, v.allow_files, v.rubric_json, v.status,
    c.get("user").id).run();
  const row = await c.env.DB.prepare("SELECT * FROM assignments WHERE id = ?").bind(id).first<AssignmentRow>();
  return c.json({ assignment: assignmentView(row!) }, 201);
});

/** PATCH /api/instructor/assignments/:id */
assessmentsRouter.patch("/instructor/assignments/:id", rbac(["instructor", "admin"]), async (c) => {
  const loaded = await loadAssignment(c, c.req.param("id"));
  if (loaded instanceof Response) return loaded;
  const data = await body(c);
  if (!data) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const parsed = await parseAssignment(c, loaded.course.id, data, loaded.assignment);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const v = parsed.value;
  await c.env.DB.prepare(`UPDATE assignments SET lesson_id = ?, title = ?, instructions = ?, max_score = ?, due_at = ?, late_policy = ?,
    late_penalty_percent = ?, allow_text = ?, allow_files = ?, rubric_json = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(v.lesson_id, v.title, v.instructions, v.max_score, v.due_at, v.late_policy, v.late_penalty_percent, v.allow_text, v.allow_files,
      v.rubric_json, v.status, loaded.assignment.id).run();
  const row = await c.env.DB.prepare("SELECT * FROM assignments WHERE id = ?").bind(loaded.assignment.id).first<AssignmentRow>();
  return c.json({ assignment: assignmentView(row!) });
});

/** DELETE /api/instructor/assignments/:id — also removes uploaded files. */
assessmentsRouter.delete("/instructor/assignments/:id", rbac(["instructor", "admin"]), async (c) => {
  const loaded = await loadAssignment(c, c.req.param("id"));
  if (loaded instanceof Response) return loaded;
  // Submissions exist → an emailed code from the course owner or an admin (utils/dangerConfirm.ts).
  const denied = await requireDeleteConfirmation(c, "assignment.delete", loaded.assignment.id);
  if (denied) return denied;
  const subs = await c.env.DB.prepare("SELECT files_json FROM assignment_submissions WHERE assignment_id = ?").bind(loaded.assignment.id).all<{ files_json: string }>();
  const keys = subs.results.flatMap(s => parseJson<FileRef[]>(s.files_json, []).map(f => f.key));
  await c.env.DB.prepare("DELETE FROM assignments WHERE id = ?").bind(loaded.assignment.id).run();
  if (keys.length) await c.env.ASSETS.delete(keys).catch(err => console.error("Assignment file cleanup failed:", err));
  await audit(c, "assignment.delete", "assignment", loaded.assignment.id, loaded.assignment.title);
  return c.json({ success: true });
});

/** GET /api/instructor/assignments/:id/submissions */
assessmentsRouter.get("/instructor/assignments/:id/submissions", rbac(["instructor", "admin"]), async (c) => {
  const loaded = await loadAssignment(c, c.req.param("id"));
  if (loaded instanceof Response) return loaded;
  const rows = await c.env.DB.prepare(`SELECT s.*, u.name AS user_name, u.email AS user_email FROM assignment_submissions s
    JOIN users u ON u.id = s.user_id WHERE s.assignment_id = ? ORDER BY s.submitted_at DESC`).bind(loaded.assignment.id).all<SubmissionRow>();
  return c.json({ assignment: assignmentView(loaded.assignment), submissions: rows.results.map(submissionView) });
});

/**
 * Grade or return for resubmission.
 * POST /api/instructor/assignment-submissions/:id/grade { action: "grade"|"return", score?, rubric_scores?, feedback? }
 */
assessmentsRouter.post("/instructor/assignment-submissions/:id/grade", rbac(["instructor", "admin"]), async (c) => {
  const sub = await c.env.DB.prepare("SELECT * FROM assignment_submissions WHERE id = ?").bind(c.req.param("id")).first<SubmissionRow>();
  if (!sub) return c.json({ error: "ไม่พบงานที่ส่ง" }, 404);
  const loaded = await loadAssignment(c, sub.assignment_id);
  if (loaded instanceof Response) return loaded;
  const a = loaded.assignment;
  const data = await body(c);
  const action = data?.action ?? "grade";
  if (action !== "grade" && action !== "return") return c.json({ error: "action ต้องเป็น grade หรือ return" }, 400);
  const feedback = optStr(data?.feedback ?? null, 10000);
  if (feedback === undefined) return c.json({ error: "ความคิดเห็นยาวเกินไป" }, 400);
  const rubric = parseJson<Criterion[]>(a.rubric_json, []);
  let score: number | null = null, rubricScores: number[] | null = null;
  if (action === "grade") {
    if (rubric.length) {
      const raw = data?.rubric_scores;
      if (!Array.isArray(raw) || raw.length !== rubric.length) return c.json({ error: "ต้องให้คะแนนครบทุกเกณฑ์" }, 400);
      rubricScores = raw.map(Number);
      if (rubricScores.some((v, i) => !Number.isFinite(v) || v < 0 || v > rubric[i].max_points)) return c.json({ error: "คะแนนเกณฑ์เกินคะแนนเต็ม" }, 400);
      score = round2(rubricScores.reduce((s, v) => s + v, 0));
    } else {
      score = Number(data?.score);
      if (!Number.isFinite(score) || score < 0 || score > a.max_score) return c.json({ error: `คะแนนต้องอยู่ระหว่าง 0–${a.max_score}` }, 400);
    }
  }
  const finalScore = score === null ? null : round2(sub.is_late && a.late_policy === "penalty" ? score * (1 - a.late_penalty_percent / 100) : score);
  await c.env.DB.prepare(`UPDATE assignment_submissions SET status = ?, score = ?, final_score = ?, rubric_scores_json = ?, feedback = ?,
    graded_by = ?, graded_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(action === "grade" ? "graded" : "returned", score, finalScore,
    rubricScores ? JSON.stringify(rubricScores) : null, feedback ?? null, c.get("user").id, sub.id).run();
  await createNotification(c.env.DB, sub.user_id, action === "grade" ? "งานที่ส่งได้รับการตรวจแล้ว" : "งานถูกส่งกลับให้แก้ไข",
    action === "grade" ? `งาน "${a.title}" ได้ ${finalScore}/${a.max_score} คะแนน` : `งาน "${a.title}" ถูกส่งกลับ กรุณาแก้ไขและส่งใหม่`);
  const updated = await c.env.DB.prepare("SELECT * FROM assignment_submissions WHERE id = ?").bind(sub.id).first<SubmissionRow>();
  return c.json({ submission: submissionView(updated!) });
});

// Learner uploads: private R2 under assignments/<assignment>/<user>/; at most 20 MB, checked by extension and magic bytes.
const ASSIGNMENT_FILE_LIMIT = 20 * 1024 * 1024;
const MAX_FILES = 5;
const FILE_TYPES: Record<string, { mime: string; magic: (b: Uint8Array) => boolean }> = {
  pdf: { mime: "application/pdf", magic: b => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", magic: b => b[0] === 0x50 && b[1] === 0x4b },
  zip: { mime: "application/zip", magic: b => b[0] === 0x50 && b[1] === 0x4b },
  png: { mime: "image/png", magic: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  jpg: { mime: "image/jpeg", magic: b => b[0] === 0xff && b[1] === 0xd8 },
  jpeg: { mime: "image/jpeg", magic: b => b[0] === 0xff && b[1] === 0xd8 },
  gif: { mime: "image/gif", magic: b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  webp: { mime: "image/webp", magic: b => b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 }
};
const assignmentPrefix = (assignmentId: string, userId: string) => `assignments/${assignmentId}/${userId}/`;

async function learnerAssignment(c: C, id: string): Promise<AssignmentRow | Response> {
  const a = await c.env.DB.prepare("SELECT * FROM assignments WHERE id = ? AND status = 'published'").bind(id).first<AssignmentRow>();
  if (!a) return c.json({ error: "ไม่พบงานที่มอบหมาย" }, 404);
  if (!(await activeEnrollment(c.env.DB, c.get("user").id, a.course_id))) return notEnrolled(c);
  const locked = await lessonLockResponse(c, a.lesson_id);
  if (locked) return locked;
  return a;
}

/** GET /api/student/assignments/:id */
assessmentsRouter.get("/student/assignments/:id", rbac(["student", "admin"]), async (c) => {
  const a = await learnerAssignment(c, c.req.param("id"));
  if (a instanceof Response) return a;
  const sub = await c.env.DB.prepare("SELECT * FROM assignment_submissions WHERE assignment_id = ? AND user_id = ?").bind(a.id, c.get("user").id).first<SubmissionRow>();
  return c.json({ assignment: assignmentView(a), submission: sub ? submissionView(sub) : null });
});

/** POST /api/student/assignments/:id/files (multipart "file") → { key, name, size, content_type } */
assessmentsRouter.post("/student/assignments/:id/files", rbac(["student", "admin"]), async (c) => {
  const a = await learnerAssignment(c, c.req.param("id"));
  if (a instanceof Response) return a;
  if (!a.allow_files) return c.json({ error: "งานนี้ไม่รับไฟล์แนบ" }, 400);
  const declared = Number(c.req.header("Content-Length"));
  if (!declared || declared > ASSIGNMENT_FILE_LIMIT + 64 * 1024) return c.json({ error: "ไฟล์ต้องไม่เกิน 20 MB" }, 413);
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!(file instanceof File) || !file.size) return c.json({ error: "ไม่พบไฟล์ที่อัปโหลด" }, 400);
  if (file.size > ASSIGNMENT_FILE_LIMIT) return c.json({ error: "ไฟล์ต้องไม่เกิน 20 MB" }, 413);
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const kind = FILE_TYPES[ext];
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (!kind || !kind.magic(head)) return c.json({ error: "รองรับเฉพาะไฟล์ PDF, DOCX, ZIP และรูปภาพ (PNG, JPG, GIF, WEBP)" }, 400);
  const name = file.name.replace(/[\\/\r\n"]/g, "_").slice(-120);
  const key = `${assignmentPrefix(a.id, c.get("user").id)}${crypto.randomUUID()}.${ext}`;
  await c.env.ASSETS.put(key, file.stream(), { httpMetadata: { contentType: kind.mime }, customMetadata: { name } });
  return c.json({ key, name, size: file.size, content_type: kind.mime }, 201);
});

/**
 * Submit or resubmit (allowed until graded; a returned submission may be resubmitted).
 * POST /api/student/assignments/:id/submit { text?, files?: [key] }
 */
assessmentsRouter.post("/student/assignments/:id/submit", rbac(["student", "admin"]), async (c) => {
  const a = await learnerAssignment(c, c.req.param("id"));
  if (a instanceof Response) return a;
  const user = c.get("user");
  const db = c.env.DB;
  const data = await body(c);
  if (!data) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const text = data.text === undefined || data.text === null || data.text === "" ? null : typeof data.text === "string" && data.text.length <= 50000 ? data.text : undefined;
  if (text === undefined) return c.json({ error: "ข้อความยาวเกินไป (ไม่เกิน 50,000 ตัวอักษร)" }, 400);
  const keys = data.files === undefined ? [] : data.files;
  if (!Array.isArray(keys) || keys.length > MAX_FILES || keys.some(k => typeof k !== "string")) return c.json({ error: `แนบไฟล์ได้ไม่เกิน ${MAX_FILES} ไฟล์` }, 400);
  if (text && !a.allow_text) return c.json({ error: "งานนี้รับเฉพาะไฟล์แนบ" }, 400);
  if (keys.length && !a.allow_files) return c.json({ error: "งานนี้ไม่รับไฟล์แนบ" }, 400);
  if (!text?.trim() && !keys.length) return c.json({ error: "ต้องพิมพ์คำตอบหรือแนบไฟล์อย่างน้อยหนึ่งอย่าง" }, 400);
  const files: FileRef[] = [];
  for (const key of new Set(keys as string[])) {
    if (!key.startsWith(assignmentPrefix(a.id, user.id)) || key.includes("..")) return c.json({ error: "ไฟล์ต้องอัปโหลดผ่านงานนี้ด้วยบัญชีของคุณ" }, 400);
    const obj = await c.env.ASSETS.head(key);
    if (!obj) return c.json({ error: "ไม่พบไฟล์ที่อัปโหลด กรุณาอัปโหลดใหม่" }, 400);
    files.push({ key, name: obj.customMetadata?.name || key.split("/").pop()!, size: obj.size, content_type: obj.httpMetadata?.contentType || "application/octet-stream" });
  }
  const now = nowMs(c);
  const late = !!a.due_at && now > Date.parse(a.due_at);
  if (late && a.late_policy === "reject") return c.json({ error: "เลยกำหนดส่งแล้ว งานนี้ไม่รับงานส่งช้า" }, 403);

  const existing = await db.prepare("SELECT * FROM assignment_submissions WHERE assignment_id = ? AND user_id = ?").bind(a.id, user.id).first<SubmissionRow>();
  if (existing?.status === "graded") return c.json({ error: "งานนี้ตรวจแล้ว ไม่สามารถส่งใหม่ได้" }, 409);
  if (existing) {
    const replaced = parseJson<FileRef[]>(existing.files_json, []).map(f => f.key).filter(k => !files.some(f => f.key === k));
    // Guarded on the version read above: a grade (or another resubmission) landing in between leaves the row
    // untouched, and only then are the old files safe to delete.
    const updated = await db.prepare(`UPDATE assignment_submissions SET version = version + 1, text_content = ?, files_json = ?, status = 'submitted', is_late = ?,
      submitted_at = ?, score = NULL, final_score = NULL, rubric_scores_json = NULL WHERE id = ? AND version = ? AND status != 'graded'`)
      .bind(text, JSON.stringify(files), late ? 1 : 0, iso(now), existing.id, existing.version).run();
    if (updated.meta.changes !== 1) return c.json({ error: "งานนี้เพิ่งถูกตรวจหรือส่งใหม่ กรุณาโหลดหน้าใหม่" }, 409);
    if (replaced.length) await c.env.ASSETS.delete(replaced).catch(err => console.error("Old assignment files cleanup failed:", err));
  } else {
    await db.prepare(`INSERT INTO assignment_submissions (id, assignment_id, user_id, text_content, files_json, status, is_late, submitted_at)
      VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?) ON CONFLICT(assignment_id, user_id) DO NOTHING`).bind(newId("sub"), a.id, user.id, text,
      JSON.stringify(files), late ? 1 : 0, iso(now)).run();
  }
  const sub = await db.prepare("SELECT * FROM assignment_submissions WHERE assignment_id = ? AND user_id = ?").bind(a.id, user.id).first<SubmissionRow>();
  await trackEvent(db, user.id, "assignment_submit", { courseId: a.course_id, lessonId: a.lesson_id,
    data: { assignment_id: a.id, version: sub?.version, late } });
  const course = await db.prepare("SELECT instructor_id FROM courses WHERE id = ?").bind(a.course_id).first<{ instructor_id: string }>();
  if (course) await createNotification(db, course.instructor_id, "มีงานส่งใหม่รอตรวจ", `${user.name} ส่งงาน "${a.title}"${late ? " (ส่งช้า)" : ""}`);
  return c.json({ submission: submissionView(sub!) }, existing ? 200 : 201);
});

/** Download a submitted file: only the learner, the course instructor and admins. GET /api/assignment-submissions/:id/files/:index */
assessmentsRouter.get("/assignment-submissions/:id/files/:index", rbac(), async (c) => {
  const user = c.get("user");
  const sub = await c.env.DB.prepare(`SELECT s.user_id, s.files_json, co.instructor_id FROM assignment_submissions s
    JOIN assignments a ON a.id = s.assignment_id JOIN courses co ON co.id = a.course_id WHERE s.id = ?`).bind(c.req.param("id"))
    .first<{ user_id: string; files_json: string; instructor_id: string }>();
  if (!sub) return c.json({ error: "ไม่พบไฟล์" }, 404);
  const allowed = sub.user_id === user.id || user.roles.includes("admin") || (user.roles.includes("instructor") && sub.instructor_id === user.id);
  if (!allowed) return c.json({ error: "ไม่มีสิทธิ์เข้าถึงไฟล์นี้" }, 403);
  const file = parseJson<FileRef[]>(sub.files_json, [])[Number(c.req.param("index"))];
  if (!file) return c.json({ error: "ไม่พบไฟล์" }, 404);
  const obj = await c.env.ASSETS.get(file.key);
  if (!obj) return c.json({ error: "ไม่พบไฟล์ในที่เก็บข้อมูล" }, 404);
  return new Response(obj.body, { headers: {
    "Content-Type": file.content_type, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"
  } });
});

// ---------- Grading queue ----------

/** GET /api/instructor/grading-queue?courseId= — essays waiting for points and submissions waiting for a grade. */
assessmentsRouter.get("/instructor/grading-queue", rbac(["instructor", "admin"]), async (c) => {
  const user = c.get("user");
  const isAdmin = user.roles.includes("admin");
  const courseId = c.req.query("courseId") || null;
  const scope = `(? = 1 OR co.instructor_id = ?) AND (? IS NULL OR co.id = ?)`;
  const binds = [isAdmin ? 1 : 0, user.id, courseId, courseId];
  const exams = await c.env.DB.prepare(`SELECT a.id, a.exam_id, e.title AS exam_title, co.id AS course_id, co.title AS course_title,
      u.name AS user_name, u.email AS user_email, a.attempt_no, a.submitted_at, a.score, a.max_score
    FROM exam_attempts a JOIN exams e ON e.id = a.exam_id JOIN courses co ON co.id = e.course_id JOIN users u ON u.id = a.user_id
    WHERE a.status = 'pending_grading' AND ${scope} ORDER BY a.submitted_at LIMIT 200`).bind(...binds).all();
  const submissions = await c.env.DB.prepare(`SELECT s.id, s.assignment_id, asg.title AS assignment_title, co.id AS course_id, co.title AS course_title,
      u.name AS user_name, u.email AS user_email, s.version, s.is_late, s.submitted_at
    FROM assignment_submissions s JOIN assignments asg ON asg.id = s.assignment_id JOIN courses co ON co.id = asg.course_id
    JOIN users u ON u.id = s.user_id WHERE s.status = 'submitted' AND ${scope} ORDER BY s.submitted_at LIMIT 200`).bind(...binds).all();
  return c.json({ exam_attempts: exams.results, submissions: submissions.results });
});

// ---------- Interactive video questions ----------

const VIDEO_TYPES = ["single", "multiple", "true_false"] as const;
interface VideoQuestionRow {
  id: string; lesson_id: string; course_id: string; timestamp_seconds: number; type: QuestionType; prompt: string;
  options_json: string; answer_json: string; explanation: string | null; must_answer: number; created_at: string;
}

async function ownLesson(c: C, lessonId: string): Promise<{ id: string; course_id: string } | Response> {
  const lesson = await c.env.DB.prepare("SELECT id, course_id FROM lessons WHERE id = ?").bind(lessonId).first<{ id: string; course_id: string }>();
  if (!lesson) return c.json({ error: "ไม่พบบทเรียน" }, 404);
  const course = await ownCourse(c, lesson.course_id);
  if (course instanceof Response) return course;
  return lesson;
}

function parseVideoQuestion(data: Record<string, unknown> | null) {
  if (!data) return { error: "ข้อมูลไม่ถูกต้อง" };
  const ts = Number(data.timestamp_seconds);
  if (!Number.isFinite(ts) || ts < 0 || ts > 86400) return { error: "เวลาในวิดีโอต้องเป็นวินาที 0–86,400" };
  const parsed = parseQuestion(data, VIDEO_TYPES);
  if ("error" in parsed) return parsed;
  return { value: { ...parsed.value, timestamp_seconds: round2(ts), must_answer: bool01(data.must_answer) } };
}

const videoView = (r: VideoQuestionRow) => ({ ...r, options: parseJson<string[]>(r.options_json, []), correct: parseJson<number[]>(r.answer_json, []),
  options_json: undefined, answer_json: undefined, must_answer: !!r.must_answer });

/** GET /api/instructor/lessons/:lessonId/video-questions */
assessmentsRouter.get("/instructor/lessons/:lessonId/video-questions", rbac(["instructor", "admin"]), async (c) => {
  const lesson = await ownLesson(c, c.req.param("lessonId"));
  if (lesson instanceof Response) return lesson;
  const rows = await c.env.DB.prepare(`SELECT q.*, (SELECT COUNT(*) FROM video_question_answers a WHERE a.question_id = q.id) AS answer_count,
      (SELECT COALESCE(SUM(a.is_correct), 0) FROM video_question_answers a WHERE a.question_id = q.id) AS correct_count
    FROM video_questions q WHERE q.lesson_id = ? ORDER BY q.timestamp_seconds`).bind(lesson.id).all<VideoQuestionRow>();
  return c.json({ questions: rows.results.map(videoView) });
});

/** POST /api/instructor/lessons/:lessonId/video-questions */
assessmentsRouter.post("/instructor/lessons/:lessonId/video-questions", rbac(["instructor", "admin"]), async (c) => {
  const lesson = await ownLesson(c, c.req.param("lessonId"));
  if (lesson instanceof Response) return lesson;
  const parsed = parseVideoQuestion(await body(c));
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const v = parsed.value, id = newId("vq");
  await c.env.DB.prepare(`INSERT INTO video_questions (id, lesson_id, course_id, timestamp_seconds, type, prompt, options_json, answer_json, explanation, must_answer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, lesson.id, lesson.course_id, v.timestamp_seconds, v.type, v.prompt, JSON.stringify(v.options),
    JSON.stringify(v.answer), v.explanation, v.must_answer).run();
  const row = await c.env.DB.prepare("SELECT * FROM video_questions WHERE id = ?").bind(id).first<VideoQuestionRow>();
  return c.json({ question: videoView(row!) }, 201);
});

/** PATCH /api/instructor/video-questions/:id */
assessmentsRouter.patch("/instructor/video-questions/:id", rbac(["instructor", "admin"]), async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM video_questions WHERE id = ?").bind(c.req.param("id")).first<VideoQuestionRow>();
  if (!row) return c.json({ error: "ไม่พบคำถาม" }, 404);
  const lesson = await ownLesson(c, row.lesson_id);
  if (lesson instanceof Response) return lesson;
  const parsed = parseVideoQuestion({ ...videoView(row), ...((await body(c)) ?? {}) });
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const v = parsed.value;
  await c.env.DB.prepare(`UPDATE video_questions SET timestamp_seconds = ?, type = ?, prompt = ?, options_json = ?, answer_json = ?, explanation = ?,
    must_answer = ? WHERE id = ?`).bind(v.timestamp_seconds, v.type, v.prompt, JSON.stringify(v.options), JSON.stringify(v.answer), v.explanation,
    v.must_answer, row.id).run();
  const updated = await c.env.DB.prepare("SELECT * FROM video_questions WHERE id = ?").bind(row.id).first<VideoQuestionRow>();
  return c.json({ question: videoView(updated!) });
});

/** DELETE /api/instructor/video-questions/:id */
assessmentsRouter.delete("/instructor/video-questions/:id", rbac(["instructor", "admin"]), async (c) => {
  const row = await c.env.DB.prepare("SELECT id, lesson_id FROM video_questions WHERE id = ?").bind(c.req.param("id")).first<{ id: string; lesson_id: string }>();
  if (!row) return c.json({ error: "ไม่พบคำถาม" }, 404);
  const lesson = await ownLesson(c, row.lesson_id);
  if (lesson instanceof Response) return lesson;
  await c.env.DB.prepare("DELETE FROM video_questions WHERE id = ?").bind(row.id).run();
  return c.json({ success: true });
});

/**
 * Video question tries. Scoring (gradebook, instructor stats) always uses the FIRST try (is_correct is never
 * overwritten). A learner may answer again after a wrong try; the answer key and explanation are revealed only
 * once the question is final: answered correctly or VIDEO_MAX_TRIES used. No answers are accepted after that.
 * "Must answer" questions follow the same rule: playback continues once the question is final.
 */
const VIDEO_MAX_TRIES = 2;
const VIDEO_TYPES_SET = new Set<string>(VIDEO_TYPES);

function videoSnapshot(row: VideoQuestionRow): Snapshot {
  return { id: row.id, type: row.type, prompt: row.prompt, points: 1, explanation: row.explanation,
    options: parseJson<string[]>(row.options_json, []), answer: parseJson<number[]>(row.answer_json, []), order: null };
}

/** Learner access to a lesson's video questions: enrolled and the lesson unlocked. */
async function videoLessonAccess(c: C, lessonId: string, courseId: string): Promise<Response | null> {
  if (!(await activeEnrollment(c.env.DB, c.get("user").id, courseId))) return notEnrolled(c);
  return lessonLockResponse(c, lessonId);
}

/** GET /api/student/lessons/:lessonId/video-questions — answer keys only for questions that are final. */
assessmentsRouter.get("/student/lessons/:lessonId/video-questions", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  const lesson = await c.env.DB.prepare("SELECT id, course_id FROM lessons WHERE id = ?").bind(c.req.param("lessonId")).first<{ id: string; course_id: string }>();
  if (!lesson) return c.json({ error: "ไม่พบบทเรียน" }, 404);
  const denied = await videoLessonAccess(c, lesson.id, lesson.course_id);
  if (denied) return denied;
  const rows = await c.env.DB.prepare(`SELECT q.*, a.response_json, a.is_correct, a.tries FROM video_questions q
    LEFT JOIN video_question_answers a ON a.question_id = q.id AND a.user_id = ? WHERE q.lesson_id = ? ORDER BY q.timestamp_seconds`)
    .bind(user.id, lesson.id).all<VideoQuestionRow & { response_json: string | null; is_correct: number | null; tries: number | null }>();
  return c.json({ questions: rows.results.map(r => {
    const tries = r.tries ?? 0;
    const response = parseJson<unknown>(r.response_json, null);
    const lastCorrect = r.response_json !== null && !!gradeAnswer(videoSnapshot(r), response).correct;
    const final = r.response_json !== null && (lastCorrect || tries >= VIDEO_MAX_TRIES);
    return {
      id: r.id, timestamp_seconds: r.timestamp_seconds, type: r.type, prompt: r.prompt, must_answer: !!r.must_answer,
      options: parseJson<string[]>(r.options_json, []), tries_used: tries, tries_left: Math.max(0, VIDEO_MAX_TRIES - tries),
      answered: final ? { response, is_correct: lastCorrect, first_try_correct: !!r.is_correct,
        correct: parseJson<number[]>(r.answer_json, []), explanation: r.explanation } : null
    };
  }) });
});

/**
 * POST /api/student/video-questions/:id/answer { response: number | number[] }
 * → { correct, final, tries_left, correct_answer?, explanation? } (key and explanation only when final)
 */
assessmentsRouter.post("/student/video-questions/:id/answer", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const row = await db.prepare("SELECT * FROM video_questions WHERE id = ?").bind(c.req.param("id")).first<VideoQuestionRow>();
  if (!row || !VIDEO_TYPES_SET.has(row.type)) return c.json({ error: "ไม่พบคำถาม" }, 404);
  const denied = await videoLessonAccess(c, row.lesson_id, row.course_id);
  if (denied) return denied;
  const s = videoSnapshot(row);
  const response = cleanResponse(s, (await body(c))?.response);
  if (response === undefined || response === null) return c.json({ error: "รูปแบบคำตอบไม่ถูกต้อง" }, 400);
  const correct = !!gradeAnswer(s, response).correct;
  const prev = await db.prepare("SELECT response_json, tries FROM video_question_answers WHERE user_id = ? AND question_id = ?")
    .bind(user.id, row.id).first<{ response_json: string; tries: number }>();
  let tries: number;
  if (!prev) {
    const inserted = await db.prepare(`INSERT INTO video_question_answers (user_id, question_id, response_json, is_correct, tries) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(user_id, question_id) DO NOTHING`).bind(user.id, row.id, JSON.stringify(response), correct ? 1 : 0).run();
    if (inserted.meta.changes !== 1) return c.json({ error: "มีการส่งคำตอบพร้อมกัน กรุณาลองใหม่" }, 409);
    tries = 1;
  } else {
    const prevCorrect = !!gradeAnswer(s, parseJson<unknown>(prev.response_json, null)).correct;
    if (prevCorrect || prev.tries >= VIDEO_MAX_TRIES) return c.json({ error: "ตอบคำถามนี้ครบจำนวนครั้งแล้ว" }, 409);
    // First-try correctness (is_correct) is kept for scoring; only the latest response and the try count change.
    const updated = await db.prepare(`UPDATE video_question_answers SET response_json = ?, tries = tries + 1, answered_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND question_id = ? AND tries = ?`).bind(JSON.stringify(response), user.id, row.id, prev.tries).run();
    if (updated.meta.changes !== 1) return c.json({ error: "มีการส่งคำตอบพร้อมกัน กรุณาลองใหม่" }, 409);
    tries = prev.tries + 1;
  }
  const final = correct || tries >= VIDEO_MAX_TRIES;
  return c.json({ correct, final, tries_left: Math.max(0, VIDEO_MAX_TRIES - tries),
    ...(final ? { correct_answer: s.answer, explanation: row.explanation } : {}) });
});

// ---------- Learner overview and gradebooks ----------

/** GET /api/student/courses/:courseId/assessments — published exams and assignments with the learner's status. */
assessmentsRouter.get("/student/courses/:courseId/assessments", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  const courseId = c.req.param("courseId");
  if (!(await activeEnrollment(c.env.DB, user.id, courseId))) return notEnrolled(c);
  const db = c.env.DB;
  const course = await db.prepare("SELECT requires_final_exam FROM courses WHERE id = ?").bind(courseId).first<{ requires_final_exam: number }>();
  const exams = await db.prepare(`SELECT e.id, e.title, e.description, e.lesson_id, l.title AS lesson_title, e.is_final, e.time_limit_minutes,
      e.max_attempts, e.pass_percent, e.available_from, e.available_until, e.selection_mode,
      (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id = e.id) AS question_count,
      (SELECT COUNT(*) FROM exam_attempts a WHERE a.exam_id = e.id AND a.user_id = ?) AS attempts_used,
      (SELECT MAX(a.percent) FROM exam_attempts a WHERE a.exam_id = e.id AND a.user_id = ? AND a.status = 'graded') AS best_percent,
      (SELECT MAX(a.passed) FROM exam_attempts a WHERE a.exam_id = e.id AND a.user_id = ?) AS passed,
      (SELECT a.id FROM exam_attempts a WHERE a.exam_id = e.id AND a.user_id = ? AND a.status = 'in_progress') AS open_attempt_id
    FROM exams e LEFT JOIN lessons l ON l.id = e.lesson_id WHERE e.course_id = ? AND e.status = 'published'
    ORDER BY e.is_final, l.sort_order, e.created_at`).bind(user.id, user.id, user.id, user.id, courseId).all<Record<string, any>>();
  const attempts = await db.prepare(`SELECT a.id, a.exam_id, a.attempt_no, a.status, a.percent, a.passed, a.submitted_at FROM exam_attempts a
    JOIN exams e ON e.id = a.exam_id WHERE e.course_id = ? AND a.user_id = ? ORDER BY a.attempt_no`).bind(courseId, user.id).all<Record<string, any>>();
  const assignments = await db.prepare(`SELECT a.id, a.title, a.lesson_id, l.title AS lesson_title, a.due_at, a.max_score, a.late_policy,
      s.status AS submission_status, s.final_score, s.submitted_at
    FROM assignments a JOIN lessons l ON l.id = a.lesson_id LEFT JOIN assignment_submissions s ON s.assignment_id = a.id AND s.user_id = ?
    WHERE a.course_id = ? AND a.status = 'published' ORDER BY l.sort_order, a.created_at`).bind(user.id, courseId).all();
  return c.json({
    requires_final_exam: !!course?.requires_final_exam,
    exams: exams.results.map(e => ({ ...e, is_final: !!e.is_final, passed: e.passed === null ? null : !!e.passed,
      attempts: attempts.results.filter(a => a.exam_id === e.id) })),
    assignments: assignments.results
  });
});

/** Per-learner grade summary for a course (exams best %, assignments, lesson quizzes, video questions). */
async function gradebook(db: D1Database, courseId: string, userId: string | null) {
  const learners = await db.prepare(`SELECT u.id, u.name, u.email, e.progress_percent FROM enrollments e JOIN users u ON u.id = e.user_id
    WHERE e.course_id = ? AND (? IS NULL OR u.id = ?) ORDER BY u.name`).bind(courseId, userId, userId).all<{ id: string; name: string; email: string; progress_percent: number }>();
  const exams = await db.prepare("SELECT id, title, is_final, pass_percent FROM exams WHERE course_id = ? AND status = 'published' ORDER BY created_at").bind(courseId).all<{ id: string; title: string; is_final: number; pass_percent: number }>();
  const assignments = await db.prepare("SELECT id, title, max_score FROM assignments WHERE course_id = ? AND status = 'published' ORDER BY created_at").bind(courseId).all<{ id: string; title: string; max_score: number }>();
  const examRows = await db.prepare(`SELECT a.user_id, a.exam_id, COUNT(*) AS attempts, MAX(CASE WHEN a.status = 'graded' THEN a.percent END) AS best_percent,
      MAX(a.passed) AS passed, SUM(CASE WHEN a.status = 'pending_grading' THEN 1 ELSE 0 END) AS pending
    FROM exam_attempts a JOIN exams e ON e.id = a.exam_id WHERE e.course_id = ? AND a.status != 'in_progress' AND (? IS NULL OR a.user_id = ?)
    GROUP BY a.user_id, a.exam_id`).bind(courseId, userId, userId).all<{ user_id: string; exam_id: string; attempts: number; best_percent: number | null; passed: number | null; pending: number }>();
  const subRows = await db.prepare(`SELECT s.user_id, s.assignment_id, s.status, s.final_score, s.is_late FROM assignment_submissions s
    JOIN assignments a ON a.id = s.assignment_id WHERE a.course_id = ? AND (? IS NULL OR s.user_id = ?)`).bind(courseId, userId, userId)
    .all<{ user_id: string; assignment_id: string; status: string; final_score: number | null; is_late: number }>();
  const quizRows = await db.prepare(`SELECT qa.user_id, COUNT(*) AS answered, SUM(qa.correct) AS correct FROM quiz_answers qa
    JOIN quizzes q ON q.id = qa.quiz_id JOIN lessons l ON l.id = q.lesson_id WHERE l.course_id = ? AND (? IS NULL OR qa.user_id = ?)
    GROUP BY qa.user_id`).bind(courseId, userId, userId).all<{ user_id: string; answered: number; correct: number }>();
  const quizTotal = await db.prepare("SELECT COUNT(*) AS n FROM quizzes q JOIN lessons l ON l.id = q.lesson_id WHERE l.course_id = ?").bind(courseId).first<{ n: number }>();
  const videoRows = await db.prepare(`SELECT a.user_id, COUNT(*) AS answered, SUM(a.is_correct) AS correct FROM video_question_answers a
    JOIN video_questions q ON q.id = a.question_id WHERE q.course_id = ? AND (? IS NULL OR a.user_id = ?) GROUP BY a.user_id`).bind(courseId, userId, userId)
    .all<{ user_id: string; answered: number; correct: number }>();
  const videoTotal = await db.prepare("SELECT COUNT(*) AS n FROM video_questions WHERE course_id = ?").bind(courseId).first<{ n: number }>();
  return {
    exams: exams.results.map(e => ({ ...e, is_final: !!e.is_final })),
    assignments: assignments.results,
    quiz_total: quizTotal?.n ?? 0,
    video_question_total: videoTotal?.n ?? 0,
    rows: learners.results.map(l => ({
      user_id: l.id, name: l.name, email: l.email, progress_percent: l.progress_percent,
      exams: Object.fromEntries(examRows.results.filter(r => r.user_id === l.id).map(r => [r.exam_id,
        { attempts: r.attempts, best_percent: r.best_percent, passed: r.passed === null ? null : !!r.passed, pending: r.pending > 0 }])),
      assignments: Object.fromEntries(subRows.results.filter(r => r.user_id === l.id).map(r => [r.assignment_id,
        { status: r.status, final_score: r.final_score, is_late: !!r.is_late }])),
      quiz: (() => { const q = quizRows.results.find(r => r.user_id === l.id); return { answered: q?.answered ?? 0, correct: q?.correct ?? 0 }; })(),
      video: (() => { const v = videoRows.results.find(r => r.user_id === l.id); return { answered: v?.answered ?? 0, correct: v?.correct ?? 0 }; })()
    }))
  };
}

/** GET /api/instructor/courses/:courseId/gradebook */
assessmentsRouter.get("/instructor/courses/:courseId/gradebook", rbac(["instructor", "admin"]), async (c) => {
  const course = await ownCourse(c, c.req.param("courseId"));
  if (course instanceof Response) return course;
  return c.json(await gradebook(c.env.DB, course.id, null));
});

/** GET /api/student/courses/:courseId/gradebook — the learner's own row. */
assessmentsRouter.get("/student/courses/:courseId/gradebook", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  const courseId = c.req.param("courseId");
  if (!(await activeEnrollment(c.env.DB, user.id, courseId))) return notEnrolled(c);
  return c.json(await gradebook(c.env.DB, courseId, user.id));
});

