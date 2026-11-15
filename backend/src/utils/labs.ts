import { ENGINE_VERSION, MAX_SPEC_BYTES, validateSpec } from "@netprime/lab-engine";
import type { Lab, SpecError } from "@netprime/lab-engine";

/**
 * Virtual Lab helpers shared by handlers/labs.ts (staff + grading) and handlers/content.ts (lesson content).
 * A lab lesson is stored as type 'embed' with lessons.lab_id set (migrations/0041).
 */

export interface LabRow {
  id: string; title: string; description: string | null; status: "draft" | "published"; spec_json: string; version: number;
  created_by: string | null; updated_by: string | null; created_at: string; updated_at: string;
}

export interface LabProgressRow {
  user_id: string; lesson_id: string; lab_id: string; lab_version: number; engine_version: string; transcript_json: string;
  passed_count: number; total: number; results_json: string | null; attempts: number; passed_at: string | null;
  passed_lab_version: number | null; passed_engine_version: string | null; started_at: string; updated_at: string;
}

/** Parses a spec sent by staff (object or JSON text) and validates it with the engine. */
export function checkSpec(input: unknown): { ok: true; json: string; lab: Lab } | { ok: false; errors: SpecError[] } {
  let value = input;
  if (typeof input === "string") {
    if (input.length > MAX_SPEC_BYTES) return { ok: false, errors: [{ path: "$", message: "lab definition is larger than 256 KB" }] };
    try { value = JSON.parse(input); } catch { return { ok: false, errors: [{ path: "$", message: "not valid JSON" }] }; }
  }
  const json = JSON.stringify(value ?? null);
  if (json.length > MAX_SPEC_BYTES) return { ok: false, errors: [{ path: "$", message: "lab definition is larger than 256 KB" }] };
  const result = validateSpec(value);
  return result.ok ? { ok: true, json, lab: result.lab } : { ok: false, errors: result.errors };
}

/** The validated lab for a stored spec (null if a stored spec no longer validates, e.g. after an engine change). */
export function labFromRow(row: Pick<LabRow, "spec_json">): Lab | null {
  try {
    const result = validateSpec(JSON.parse(row.spec_json));
    return result.ok ? result.lab : null;
  } catch {
    return null;
  }
}

export function parseJsonArray(text: string | null | undefined): unknown[] {
  if (!text) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/**
 * What the learner player needs for a lab lesson: the spec to run and the learner's saved attempt
 * (replayed in the browser to restore the consoles). Unpublished labs are shown to staff only.
 */
export async function labLessonPayload(db: D1Database, labId: string, userId: string, lessonId: string, staff: boolean) {
  const lab = await db.prepare("SELECT * FROM labs WHERE id = ?").bind(labId).first<LabRow>();
  if (!lab || (lab.status !== "published" && !staff)) return null;
  const progress = await db.prepare("SELECT * FROM lab_progress WHERE user_id = ? AND lesson_id = ?")
    .bind(userId, lessonId).first<LabProgressRow>();
  return {
    id: lab.id,
    title: lab.title,
    description: lab.description,
    status: lab.status,
    version: lab.version,
    engine_version: ENGINE_VERSION,
    spec: JSON.parse(lab.spec_json) as unknown,
    progress: progress ? {
      // A transcript recorded against an older lab version is not replayed: the devices may have changed.
      transcript: progress.lab_version === lab.version ? parseJsonArray(progress.transcript_json) : [],
      passed_count: progress.passed_count,
      total: progress.total,
      attempts: progress.attempts,
      passed_at: progress.passed_at,
      updated_at: progress.updated_at
    } : null
  };
}
