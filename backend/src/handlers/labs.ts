import { Context, Hono } from "hono";
import { ENGINE_VERSION, grade, parseTranscript } from "@netprime/lab-engine";
import { Env, rbac } from "../middleware/rbac";
import { permit } from "../utils/permissions";
import { completeLesson } from "../utils/courseContent";
import { checkSpec, labFromRow, LabProgressRow, LabRow } from "../utils/labs";
import { audit } from "./accounts";
import { learnerLesson } from "./content";

/**
 * Virtual Lab (migrations/0041, packages/lab-engine, docs/VIRTUAL-LAB.md).
 *
 * Staff with labs.manage keep a library of labs (JSON specs run by the shared engine); instructors put a published
 * lab in a course lesson. While a learner works, the player sends everything they typed. The server replays it
 * from the lab's initial state with the same engine and checks the objectives itself; a client's own "passed" is
 * never read. A passing replay completes the lesson, so a lab counts towards course progress and the certificate.
 */
export const labsRouter = new Hono<Env>();
type C = Context<Env>;

const newId = () => "lab_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);

// ==========================================
// Staff library: /api/labs (labs.manage)
// ==========================================

labsRouter.use("/labs", rbac(), permit("labs.manage"));
labsRouter.use("/labs/*", rbac(), permit("labs.manage"));

const LIST_SQL = `SELECT l.id, l.title, l.description, l.status, l.version, l.created_at, l.updated_at, u.name AS updated_by_name,
    (SELECT COUNT(*) FROM lessons ls WHERE ls.lab_id = l.id) AS lesson_count,
    (SELECT COUNT(*) FROM lab_progress p WHERE p.lab_id = l.id) AS learner_count,
    (SELECT COUNT(*) FROM lab_progress p WHERE p.lab_id = l.id AND p.passed_at IS NOT NULL) AS passed_count
  FROM labs l LEFT JOIN users u ON u.id = l.updated_by`;

function text(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" ? value.trim().slice(0, max) : undefined;
}

async function readBody(c: C): Promise<Record<string, unknown> | null> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

const specErrorResponse = (c: C, errors: { path: string; message: string }[]) =>
  c.json({ error: "รูปแบบ lab ไม่ถูกต้อง แก้ตามรายการแล้วบันทึกอีกครั้ง", errors }, 400);

labsRouter.get("/labs", async (c) => {
  const rows = await c.env.DB.prepare(`${LIST_SQL} ORDER BY l.updated_at DESC LIMIT 500`).all();
  return c.json({ labs: rows.results, engine_version: ENGINE_VERSION });
});

/** Validates a spec without saving it (the editor's "ตรวจรูปแบบ"). */
labsRouter.post("/labs/validate", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const checked = checkSpec(body.spec);
  if (!checked.ok) return c.json({ ok: false, errors: checked.errors });
  const lab = checked.lab;
  return c.json({ ok: true, summary: { title: lab.title, devices: lab.initialState.deviceOrder.length, objectives: lab.objectives.length } });
});

labsRouter.post("/labs", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const checked = checkSpec(body.spec);
  if (!checked.ok) return specErrorResponse(c, checked.errors);
  const title = text(body.title, 200) || checked.lab.title;
  if (!title) return c.json({ error: "ตั้งชื่อ lab" }, 400);
  const id = newId();
  const user = c.get("user");
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO labs (id, title, description, status, spec_json, version, created_by, updated_by)
      VALUES (?, ?, ?, 'draft', ?, 1, ?, ?)`).bind(id, title, text(body.description, 2000) ?? null, checked.json, user.id, user.id),
    c.env.DB.prepare("INSERT INTO lab_versions (lab_id, version, spec_json, created_by) VALUES (?, 1, ?, ?)").bind(id, checked.json, user.id)
  ]);
  await audit(c, "create", "lab", id, { title });
  return c.json({ lab: await c.env.DB.prepare("SELECT * FROM labs WHERE id = ?").bind(id).first() }, 201);
});

labsRouter.get("/labs/:id", async (c) => {
  const lab = await c.env.DB.prepare("SELECT * FROM labs WHERE id = ?").bind(c.req.param("id")).first<LabRow>();
  if (!lab) return c.json({ error: "ไม่พบ lab นี้" }, 404);
  const versions = await c.env.DB.prepare(`SELECT v.version, v.created_at, u.name AS created_by_name FROM lab_versions v
    LEFT JOIN users u ON u.id = v.created_by WHERE v.lab_id = ? ORDER BY v.version DESC LIMIT 100`).bind(lab.id).all();
  const lessons = await c.env.DB.prepare(`SELECT ls.id, ls.title, co.id AS course_id, co.title AS course_title FROM lessons ls
    JOIN courses co ON co.id = ls.course_id WHERE ls.lab_id = ? ORDER BY co.title, ls.title LIMIT 200`).bind(lab.id).all();
  return c.json({ lab: { ...lab, spec: JSON.parse(lab.spec_json) }, versions: versions.results, lessons: lessons.results });
});

labsRouter.patch("/labs/:id", async (c): Promise<Response> => {
  const db = c.env.DB;
  const lab = await db.prepare("SELECT * FROM labs WHERE id = ?").bind(c.req.param("id")).first<LabRow>();
  if (!lab) return c.json({ error: "ไม่พบ lab นี้" }, 404);
  const body = await readBody(c);
  if (!body) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const set: Record<string, unknown> = {};
  const title = text(body.title, 200);
  if (title !== undefined) {
    if (!title) return c.json({ error: "ตั้งชื่อ lab" }, 400);
    set.title = title;
  }
  const description = text(body.description, 2000);
  if (description !== undefined) set.description = description || null;
  const statements: D1PreparedStatement[] = [];
  if (body.spec !== undefined) {
    const checked = checkSpec(body.spec);
    if (!checked.ok) return specErrorResponse(c, checked.errors);
    // A new version only when the definition really changed; learners' saved work belongs to the old one.
    if (checked.json !== lab.spec_json) {
      set.spec_json = checked.json;
      set.version = lab.version + 1;
      statements.push(db.prepare("INSERT INTO lab_versions (lab_id, version, spec_json, created_by) VALUES (?, ?, ?, ?)")
        .bind(lab.id, lab.version + 1, checked.json, c.get("user").id));
    }
  }
  if (!Object.keys(set).length) return c.json({ message: "ไม่มีอะไรเปลี่ยน", lab });
  set.updated_by = c.get("user").id;
  const entries = Object.entries(set);
  statements.unshift(db.prepare(`UPDATE labs SET ${entries.map(([k]) => `${k} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(...entries.map(([, v]) => v), lab.id));
  await db.batch(statements);
  await audit(c, "update", "lab", lab.id, { fields: Object.keys(set).filter(k => k !== "updated_by"), version: set.version ?? lab.version });
  return c.json({ message: set.version ? `บันทึกแล้ว (เวอร์ชัน ${set.version})` : "บันทึกแล้ว",
    lab: await db.prepare("SELECT * FROM labs WHERE id = ?").bind(lab.id).first() });
});

labsRouter.post("/labs/:id/publish", async (c) => {
  const lab = await c.env.DB.prepare("SELECT * FROM labs WHERE id = ?").bind(c.req.param("id")).first<LabRow>();
  if (!lab) return c.json({ error: "ไม่พบ lab นี้" }, 404);
  if (!labFromRow(lab)) return c.json({ error: "รูปแบบ lab ไม่ผ่านการตรวจ แก้ก่อนเผยแพร่" }, 400);
  await c.env.DB.prepare("UPDATE labs SET status = 'published', updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(c.get("user").id, lab.id).run();
  await audit(c, "publish", "lab", lab.id);
  return c.json({ message: "เผยแพร่แล้ว ผู้สอนเลือกใช้ lab นี้ในบทเรียนได้" });
});

labsRouter.post("/labs/:id/unpublish", async (c) => {
  const id = c.req.param("id");
  const used = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM lessons WHERE lab_id = ?").bind(id).first<{ n: number }>();
  if (used?.n) return c.json({ error: `มี ${used.n} บทเรียนใช้ lab นี้อยู่ เปลี่ยนบทเรียนเหล่านั้นก่อนยกเลิกการเผยแพร่` }, 409);
  const result = await c.env.DB.prepare("UPDATE labs SET status = 'draft', updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(c.get("user").id, id).run();
  if (!result.meta.changes) return c.json({ error: "ไม่พบ lab นี้" }, 404);
  await audit(c, "unpublish", "lab", id);
  return c.json({ message: "ยกเลิกการเผยแพร่แล้ว" });
});

/** Labs that lessons use, or that learners have worked on (their results are evidence), cannot be deleted. */
labsRouter.delete("/labs/:id", async (c) => {
  const id = c.req.param("id");
  const usage = await c.env.DB.prepare(`SELECT (SELECT COUNT(*) FROM lessons WHERE lab_id = ?1) AS lessons,
    (SELECT COUNT(*) FROM lab_progress WHERE lab_id = ?1) AS learners`).bind(id).first<{ lessons: number; learners: number }>();
  if (usage?.lessons) return c.json({ error: `มี ${usage.lessons} บทเรียนใช้ lab นี้อยู่ ลบไม่ได้` }, 409);
  if (usage?.learners) return c.json({ error: "มีผู้เรียนทำ lab นี้แล้ว จึงเก็บไว้เป็นหลักฐานผลการเรียน ยกเลิกการเผยแพร่แทนได้" }, 409);
  const result = await c.env.DB.prepare("DELETE FROM labs WHERE id = ?").bind(id).run();
  if (!result.meta.changes) return c.json({ error: "ไม่พบ lab นี้" }, 404);
  await audit(c, "delete", "lab", id);
  return c.json({ message: "ลบ lab แล้ว" });
});

/** Learners' results for one lab, newest first. */
labsRouter.get("/labs/:id/progress", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT p.user_id, u.name, u.email, p.lesson_id, ls.title AS lesson_title, co.title AS course_title,
      p.lab_version, p.passed_count, p.total, p.attempts, p.passed_at, p.passed_lab_version, p.passed_engine_version, p.updated_at
    FROM lab_progress p JOIN users u ON u.id = p.user_id JOIN lessons ls ON ls.id = p.lesson_id JOIN courses co ON co.id = ls.course_id
    WHERE p.lab_id = ? ORDER BY p.updated_at DESC LIMIT 1000`).bind(c.req.param("id")).all();
  return c.json({ progress: rows.results });
});

// ==========================================
// Learners: save and grade work on a lab lesson
// ==========================================

/** The lab lesson, its lab, and whether the work is saved (enrolled) or only graded (staff preview). */
async function labLesson(c: C, lessonId: string) {
  const found = await learnerLesson(c, lessonId);
  if ("error" in found) return found;
  if (!found.lesson.lab_id) return { error: c.json({ error: "บทเรียนนี้ไม่ใช่ Virtual Lab" }, 400) };
  const row = await c.env.DB.prepare("SELECT * FROM labs WHERE id = ?").bind(found.lesson.lab_id).first<LabRow>();
  if (!row || (row.status !== "published" && !found.staff)) return { error: c.json({ error: "lab ของบทเรียนนี้ยังไม่พร้อมใช้งาน" }, 404) };
  const lab = labFromRow(row);
  if (!lab) return { error: c.json({ error: "lab ของบทเรียนนี้ตรวจผลไม่ได้ กรุณาแจ้งเจ้าหน้าที่" }, 500) };
  return { ...found, row, lab };
}

/**
 * Saves the learner's current work and grades it on the server.
 * PUT /api/student/lessons/:id/lab { lab_version, transcript: [[deviceId, keystrokes], ...] }
 */
labsRouter.put("/student/lessons/:id/lab", rbac(), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const body = await readBody(c);
  if (!body) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const found = await labLesson(c, c.req.param("id"));
  if ("error" in found) return found.error;
  const { lesson, row, lab } = found;
  if (body.lab_version !== undefined && body.lab_version !== row.version)
    return c.json({ error: "lab นี้เพิ่งถูกแก้ไข กรุณาโหลดหน้าใหม่", code: "lab_changed", lab_version: row.version }, 409);
  const parsed = parseTranscript(body.transcript, lab);
  if (!parsed.ok) return c.json({ error: `บันทึกงานไม่ได้: ${parsed.error}` }, 400);

  const result = grade(lab, parsed.transcript);
  const response = { passed: result.passed, passed_count: result.passedCount, total: result.total, results: result.results };
  // Staff previewing a course: graded, never stored.
  if (!found.enrolled) return c.json({ ...response, saved: false, completed: false });

  const transcriptJson = JSON.stringify(parsed.transcript);
  const resultsJson = JSON.stringify(result.results.map(r => ({ id: r.id, passed: r.passed })));
  await db.prepare(`INSERT INTO lab_progress (user_id, lesson_id, lab_id, lab_version, engine_version, transcript_json, passed_count, total, results_json,
        passed_at, passed_lab_version, passed_engine_version, passed_transcript_json)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, CASE WHEN ?10 THEN CURRENT_TIMESTAMP END, CASE WHEN ?10 THEN ?4 END,
        CASE WHEN ?10 THEN ?5 END, CASE WHEN ?10 THEN ?6 END)
    ON CONFLICT (user_id, lesson_id) DO UPDATE SET lab_id = excluded.lab_id, lab_version = excluded.lab_version,
      engine_version = excluded.engine_version, transcript_json = excluded.transcript_json, passed_count = excluded.passed_count,
      total = excluded.total, results_json = excluded.results_json,
      passed_at = COALESCE(lab_progress.passed_at, excluded.passed_at),
      passed_lab_version = CASE WHEN lab_progress.passed_at IS NULL THEN excluded.passed_lab_version ELSE lab_progress.passed_lab_version END,
      passed_engine_version = CASE WHEN lab_progress.passed_at IS NULL THEN excluded.passed_engine_version ELSE lab_progress.passed_engine_version END,
      passed_transcript_json = CASE WHEN lab_progress.passed_at IS NULL THEN excluded.passed_transcript_json ELSE lab_progress.passed_transcript_json END,
      updated_at = CURRENT_TIMESTAMP`)
    .bind(user.id, lesson.id, row.id, row.version, ENGINE_VERSION, transcriptJson, result.passedCount, result.total, resultsJson,
      result.passed ? 1 : 0).run();

  if (result.passed) await completeLesson(db, user.id, lesson.id, lesson.course_id);
  const saved = await db.prepare(`SELECT p.passed_at, e.progress_percent FROM lab_progress p
      LEFT JOIN enrollments e ON e.user_id = p.user_id AND e.course_id = ? WHERE p.user_id = ? AND p.lesson_id = ?`)
    .bind(lesson.course_id, user.id, lesson.id).first<Pick<LabProgressRow, "passed_at"> & { progress_percent: number | null }>();
  return c.json({ ...response, saved: true, completed: !!saved?.passed_at, passed_at: saved?.passed_at ?? null,
    progress_percent: saved?.progress_percent ?? null });
});

/**
 * Starts the lab again from its initial state. A result already passed stays passed.
 * POST /api/student/lessons/:id/lab/reset
 */
labsRouter.post("/student/lessons/:id/lab/reset", rbac(), async (c) => {
  const user = c.get("user");
  const found = await labLesson(c, c.req.param("id"));
  if ("error" in found) return found.error;
  if (!found.enrolled) return c.json({ message: "เริ่มใหม่แล้ว (โหมดดูตัวอย่าง ไม่บันทึก)", saved: false });
  const fresh = grade(found.lab, []);
  await c.env.DB.prepare(`UPDATE lab_progress SET transcript_json = '[]', lab_version = ?, engine_version = ?, passed_count = ?, total = ?,
      results_json = NULL, attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND lesson_id = ?`)
    .bind(found.row.version, ENGINE_VERSION, fresh.passedCount, fresh.total, user.id, found.lesson.id).run();
  return c.json({ message: "เริ่ม lab ใหม่แล้ว ผลที่ผ่านไว้ก่อนหน้ายังนับอยู่", saved: true });
});
