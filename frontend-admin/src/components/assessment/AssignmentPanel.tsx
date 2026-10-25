import React, { useCallback, useEffect, useRef, useState } from "react";
import { Paperclip, Plus, Pencil, Trash2, Upload, X } from "lucide-react";
import { API_BASE_URL, useApi } from "../../hooks/useApi";
import { Chip, Empty, ErrorBox, Field, Modal, downloadWithAuth, grid2, tableStyle, tdStyle, thStyle } from "../site-admin/ui";
import { Assignment, Criterion, LATE_POLICY_LABEL, LessonRef, SUBMISSION_STATUS, Submission, cardStyle, formatWhen, fromLocalInput,
  mutedText, rowFlex, smallButton, toLocalInput } from "./types";
import { SubmissionGrader } from "./GradingQueue";

const ACCEPT = ".pdf,.docx,.zip,.png,.jpg,.jpeg,.gif,.webp";
const MAX_BYTES = 20 * 1024 * 1024;

// ==========================================
// Learner: view, upload and submit
// ==========================================

export const AssignmentPanel: React.FC<{ assignmentId: string; onChanged?: () => void }> = ({ assignmentId, onChanged }) => {
  const api = useApi();
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<{ key: string; name: string; size: number }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.request<{ assignment: Assignment; submission: Submission | null }>(`/student/assignments/${assignmentId}`).then(res => {
      setAssignment(res.assignment);
      setSubmission(res.submission);
      setText(res.submission?.text_content ?? "");
    }).catch(err => setError(err.message));
  }, [api.request, assignmentId]);
  useEffect(() => { load(); }, [load]);

  const upload = async (file: File) => {
    if (file.size > MAX_BYTES) { setError("ไฟล์ต้องไม่เกิน 20 MB"); return; }
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${API_BASE_URL}/student/assignments/${assignmentId}/files`, {
        method: "POST", body: form, headers: api.token ? { Authorization: `Bearer ${api.token}` } : {}
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "อัปโหลดไม่สำเร็จ");
      setFiles(prev => [...prev, { key: data.key, name: data.name, size: data.size }]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      // A resubmission replaces earlier files with the ones attached now.
      await api.post(`/student/assignments/${assignmentId}/submit`, { text: text || null, files: files.map(f => f.key) });
      setFiles([]);
      load();
      onChanged?.();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!assignment) return error ? <ErrorBox message={error} /> : <Empty text="กำลังโหลด..." />;
  const overdue = !!assignment.due_at && Date.now() > Date.parse(assignment.due_at);
  const locked = submission?.status === "graded" || (overdue && assignment.late_policy === "reject");
  const status = submission ? SUBMISSION_STATUS[submission.status] : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={rowFlex}>
        <h3 style={{ color: "var(--text-primary)" }}>{assignment.title}</h3>
        {status && <Chip {...status} />}
        {submission?.is_late && <Chip label="ส่งช้า" color="var(--warning)" bg="rgba(245,158,11,0.12)" />}
      </div>
      <div style={mutedText}>
        คะแนนเต็ม {assignment.max_score} • กำหนดส่ง {formatWhen(assignment.due_at)} • {LATE_POLICY_LABEL[assignment.late_policy]}
        {assignment.late_policy === "penalty" ? ` ${assignment.late_penalty_percent}%` : ""}
      </div>
      {assignment.instructions && <div style={{ ...cardStyle, whiteSpace: "pre-wrap" }}>{assignment.instructions}</div>}
      {assignment.rubric.length > 0 && (
        <div style={mutedText}>เกณฑ์การให้คะแนน: {assignment.rubric.map(r => `${r.criterion} (${r.max_points})`).join(" • ")}</div>
      )}
      <ErrorBox message={error} />

      {submission && (
        <div style={cardStyle}>
          <div style={mutedText}>ส่งล่าสุด {formatWhen(submission.submitted_at)} (ครั้งที่ {submission.version})</div>
          {submission.text_content && <div style={{ whiteSpace: "pre-wrap", margin: "8px 0" }}>{submission.text_content}</div>}
          {submission.files.map((f, i) => (
            <button key={i} className="tech-button-outline" style={{ ...smallButton, marginRight: "6px" }}
              onClick={() => downloadWithAuth(`/assignment-submissions/${submission.id}/files/${i}`, api.token, f.name).catch(err => setError(err.message))}>
              <Paperclip size={14} /> {f.name}
            </button>
          ))}
          {submission.status === "graded" && (
            <p style={{ marginTop: "8px", fontWeight: 600 }}>คะแนน {submission.final_score}/{assignment.max_score}
              {submission.final_score !== submission.score ? <span style={mutedText}> (ก่อนหักส่งช้า {submission.score})</span> : null}</p>
          )}
          {submission.feedback && <p style={{ marginTop: "6px" }}>ความเห็นผู้สอน: {submission.feedback}</p>}
        </div>
      )}

      {!locked && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {submission?.status === "returned" && <p style={{ color: "var(--warning)", fontSize: "13px" }}>ผู้สอนส่งงานกลับให้แก้ไข กรุณาส่งใหม่</p>}
          {assignment.allow_text && (
            <Field label="คำตอบ">
              <textarea className="form-input" rows={6} value={text} maxLength={50000} onChange={e => setText(e.target.value)} />
            </Field>
          )}
          {assignment.allow_files && (
            <div>
              <div style={rowFlex}>
                <button type="button" className="tech-button-outline" style={smallButton} disabled={uploading || files.length >= 5} onClick={() => fileRef.current?.click()}>
                  <Upload size={14} /> {uploading ? "กำลังอัปโหลด..." : "แนบไฟล์"}
                </button>
                <span style={mutedText}>PDF, DOCX, ZIP หรือรูปภาพ ไม่เกิน 20 MB สูงสุด 5 ไฟล์{submission?.files.length ? " (การส่งใหม่จะแทนที่ไฟล์เดิม)" : ""}</span>
                <input ref={fileRef} type="file" accept={ACCEPT} hidden onChange={e => e.target.files?.[0] && upload(e.target.files[0])} />
              </div>
              {files.map(f => (
                <div key={f.key} style={{ ...rowFlex, fontSize: "13px", marginTop: "6px" }}>
                  <Paperclip size={14} /> {f.name} <span style={mutedText}>({Math.ceil(f.size / 1024)} KB)</span>
                  <button type="button" onClick={() => setFiles(files.filter(x => x.key !== f.key))} aria-label="นำออก" style={{ background: "none", border: "none", cursor: "pointer" }}><X size={14} /></button>
                </div>
              ))}
            </div>
          )}
          <div style={{ ...rowFlex, justifyContent: "flex-end" }}>
            {overdue && <span style={{ ...mutedText, color: "var(--warning)" }}>เลยกำหนดส่งแล้ว</span>}
            <button className="tech-button-primary" onClick={submit} disabled={saving || uploading || (!text.trim() && !files.length)}>
              {saving ? "กำลังส่ง..." : submission ? "ส่งงานใหม่" : "ส่งงาน"}
            </button>
          </div>
        </div>
      )}
      {locked && !submission && <p style={{ color: "var(--danger)", fontSize: "13px" }}>เลยกำหนดส่งแล้ว งานนี้ไม่รับงานส่งช้า</p>}
    </div>
  );
};

// ==========================================
// Instructor: create assignments and review submissions
// ==========================================

type Draft = Pick<Assignment, "lesson_id" | "title" | "instructions" | "max_score" | "due_at" | "late_policy" | "late_penalty_percent" |
  "allow_text" | "allow_files" | "rubric" | "status">;

const AssignmentEditor: React.FC<{ courseId: string; lessons: LessonRef[]; assignment: Assignment | null; onSaved: () => void; onClose: () => void }> = ({ courseId, lessons, assignment, onSaved, onClose }) => {
  const api = useApi();
  const [d, setD] = useState<Draft>(() => assignment ? { ...assignment } : {
    lesson_id: lessons[0]?.id ?? "", title: "", instructions: "", max_score: 100, due_at: null, late_policy: "accept", late_penalty_percent: 0,
    allow_text: true, allow_files: true, rubric: [], status: "draft"
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD(prev => ({ ...prev, [k]: v }));
  const setCriterion = (i: number, patch: Partial<Criterion>) => set("rubric", d.rubric.map((r, j) => j === i ? { ...r, ...patch } : r));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (assignment) await api.patch(`/instructor/assignments/${assignment.id}`, d);
      else await api.post(`/instructor/courses/${courseId}/assignments`, d);
      onSaved();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={assignment ? "แก้ไขงานที่มอบหมาย" : "สร้างงานที่มอบหมาย"} onClose={onClose} width={760}>
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <ErrorBox message={error} />
        <div style={grid2}>
          <Field label="ชื่องาน" span><input className="form-input" value={d.title} onChange={e => set("title", e.target.value)} required maxLength={200} /></Field>
          <Field label="บทเรียน">
            <select className="form-input" value={d.lesson_id} onChange={e => set("lesson_id", e.target.value)} required>
              {lessons.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
            </select>
          </Field>
          <Field label="สถานะ">
            <select className="form-input" value={d.status} onChange={e => set("status", e.target.value as Draft["status"])}>
              <option value="draft">ฉบับร่าง</option><option value="published">เผยแพร่</option>
            </select>
          </Field>
          <Field label="คำชี้แจง" span><textarea className="form-input" rows={4} value={d.instructions ?? ""} onChange={e => set("instructions", e.target.value)} /></Field>
          <Field label="กำหนดส่ง" hint="เว้นว่าง = ไม่มีกำหนด">
            <input className="form-input" type="datetime-local" value={toLocalInput(d.due_at)} onChange={e => set("due_at", fromLocalInput(e.target.value))} />
          </Field>
          <Field label="งานส่งช้า">
            <select className="form-input" value={d.late_policy} onChange={e => set("late_policy", e.target.value as Draft["late_policy"])}>
              {(Object.keys(LATE_POLICY_LABEL) as Draft["late_policy"][]).map(k => <option key={k} value={k}>{LATE_POLICY_LABEL[k]}</option>)}
            </select>
          </Field>
          {d.late_policy === "penalty" && (
            <Field label="หักคะแนน (%)"><input className="form-input" type="number" min={0} max={100} value={d.late_penalty_percent} onChange={e => set("late_penalty_percent", Number(e.target.value))} /></Field>
          )}
          {!d.rubric.length && (
            <Field label="คะแนนเต็ม"><input className="form-input" type="number" min={1} value={d.max_score} onChange={e => set("max_score", Number(e.target.value))} /></Field>
          )}
        </div>
        <div style={rowFlex}>
          <label style={rowFlex}><input type="checkbox" checked={d.allow_text} onChange={e => set("allow_text", e.target.checked)} /> รับคำตอบแบบพิมพ์</label>
          <label style={rowFlex}><input type="checkbox" checked={d.allow_files} onChange={e => set("allow_files", e.target.checked)} /> รับไฟล์แนบ</label>
        </div>
        <Field label="เกณฑ์การให้คะแนน (Rubric)" hint="ถ้ากำหนดเกณฑ์ คะแนนเต็มคือผลรวมของทุกเกณฑ์">
          {d.rubric.map((r, i) => (
            <div key={i} style={{ ...rowFlex, flexWrap: "nowrap" }}>
              <input className="form-input" value={r.criterion} placeholder="เกณฑ์" onChange={e => setCriterion(i, { criterion: e.target.value })} />
              <input className="form-input" style={{ width: "100px" }} type="number" min={1} value={r.max_points} onChange={e => setCriterion(i, { max_points: Number(e.target.value) })} aria-label="คะแนนเต็มของเกณฑ์" />
              <button type="button" className="tech-button-outline" style={smallButton} onClick={() => set("rubric", d.rubric.filter((_, j) => j !== i))}>ลบ</button>
            </div>
          ))}
          <button type="button" className="tech-button-outline" style={{ ...smallButton, alignSelf: "flex-start" }} onClick={() => set("rubric", [...d.rubric, { criterion: "", max_points: 10 }])}>+ เพิ่มเกณฑ์</button>
        </Field>
        <div style={{ ...rowFlex, justifyContent: "flex-end" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary">บันทึก</button>
        </div>
      </form>
    </Modal>
  );
};

const Submissions: React.FC<{ assignmentId: string }> = ({ assignmentId }) => {
  const api = useApi();
  const [data, setData] = useState<{ assignment: Assignment; submissions: Submission[] } | null>(null);
  const [grading, setGrading] = useState<Submission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.request<{ assignment: Assignment; submissions: Submission[] }>(`/instructor/assignments/${assignmentId}/submissions`).then(setData).catch(err => setError(err.message));
  }, [api.request, assignmentId]);
  useEffect(() => { load(); }, [load]);
  if (!data) return error ? <ErrorBox message={error} /> : <Empty text="กำลังโหลด..." />;
  if (grading) return <SubmissionGrader assignment={data.assignment} submission={grading} onDone={() => { setGrading(null); load(); }} />;
  if (!data.submissions.length) return <Empty text="ยังไม่มีผู้ส่งงาน" />;
  return (
    <table style={tableStyle}>
      <thead><tr><th style={thStyle}>ผู้เรียน</th><th style={thStyle}>สถานะ</th><th style={thStyle}>คะแนน</th><th style={thStyle}>ส่งเมื่อ</th><th style={thStyle}></th></tr></thead>
      <tbody>
        {data.submissions.map(s => (
          <tr key={s.id}>
            <td style={tdStyle}>{s.user_name}<div style={mutedText}>{s.user_email}</div></td>
            <td style={tdStyle}><Chip {...SUBMISSION_STATUS[s.status]} />{s.is_late && <div style={mutedText}>ส่งช้า</div>}</td>
            <td style={tdStyle}>{s.final_score ?? "-"}/{data.assignment.max_score}</td>
            <td style={tdStyle}>{formatWhen(s.submitted_at)}<div style={mutedText}>ครั้งที่ {s.version}</div></td>
            <td style={tdStyle}><button className="tech-button-outline" style={smallButton} onClick={() => setGrading(s)}>ตรวจ</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/** Instructor list of a course's assignments. */
export const AssignmentManager: React.FC<{ courseId: string; lessons: LessonRef[] }> = ({ courseId, lessons }) => {
  const api = useApi();
  const [items, setItems] = useState<Assignment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Assignment | "new" | null>(null);
  const [viewing, setViewing] = useState<Assignment | null>(null);
  const load = useCallback(() => {
    api.request<{ assignments: Assignment[] }>(`/instructor/courses/${courseId}/assignments`).then(res => setItems(res.assignments)).catch(err => setError(err.message));
  }, [api.request, courseId]);
  useEffect(() => { load(); }, [load]);

  const remove = async (a: Assignment) => {
    if (!confirm(`ลบงาน "${a.title}" พร้อมงานที่ผู้เรียนส่งทั้งหมด?`)) return;
    try {
      await api.request(`/instructor/assignments/${a.id}`, { method: "DELETE" });
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div>
      <div style={{ ...rowFlex, justifyContent: "flex-end", marginBottom: "16px" }}>
        <button className="tech-button-primary" style={smallButton} disabled={!lessons.length} onClick={() => setEditing("new")}><Plus size={14} /> สร้างงาน</button>
      </div>
      <ErrorBox message={error} />
      {!lessons.length && <Empty text="ต้องมีบทเรียนก่อนจึงจะสร้างงานได้" />}
      {items.length === 0 ? <Empty text="ยังไม่มีงานที่มอบหมาย" /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {items.map(a => (
            <div key={a.id} style={cardStyle}>
              <div style={{ ...rowFlex, justifyContent: "space-between" }}>
                <div>
                  <div style={rowFlex}>
                    <strong>{a.title}</strong>
                    <Chip label={a.status === "published" ? "เผยแพร่" : "ฉบับร่าง"} color={a.status === "published" ? "var(--accent)" : "var(--text-secondary)"}
                      bg={a.status === "published" ? "var(--accent-glow)" : "rgba(100,116,139,0.12)"} />
                    {!!a.pending_count && <Chip label={`รอตรวจ ${a.pending_count}`} color="var(--warning)" bg="rgba(245,158,11,0.12)" />}
                  </div>
                  <div style={{ ...mutedText, marginTop: "4px" }}>
                    บทเรียน: {a.lesson_title} • กำหนดส่ง {formatWhen(a.due_at)} • {LATE_POLICY_LABEL[a.late_policy]} • เต็ม {a.max_score} • ส่งแล้ว {a.submission_count ?? 0} คน
                  </div>
                </div>
                <div style={rowFlex}>
                  <button className="tech-button-outline" style={smallButton} onClick={() => setViewing(a)}>งานที่ส่ง</button>
                  <button className="tech-button-outline" style={smallButton} onClick={() => setEditing(a)} aria-label="แก้ไข"><Pencil size={14} /></button>
                  <button className="tech-button-outline" style={{ ...smallButton, color: "var(--danger)" }} onClick={() => remove(a)} aria-label="ลบ"><Trash2 size={14} /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && <AssignmentEditor courseId={courseId} lessons={lessons} assignment={editing === "new" ? null : editing}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {viewing && (
        <Modal title={`งานที่ส่ง: ${viewing.title}`} onClose={() => { setViewing(null); load(); }} width={860}>
          <Submissions assignmentId={viewing.id} />
        </Modal>
      )}
    </div>
  );
};

export default AssignmentPanel;
