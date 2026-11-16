import React, { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { CheckCircle, FilePlus2, Pencil, Play, Save, Trash2, Users } from "lucide-react";
import { sampleSpec } from "@netprime/lab-engine";
import { useApi } from "../hooks/useApi";
import { Chip, Empty, ErrorBox, Field, Modal, formatDateTime, tableStyle, tdStyle, thStyle } from "../components/site-admin/ui";
import { IconBtn, Notice } from "../components/builder/adminKit";
import { LabDesigner } from "../components/labs/LabDesigner";
import { asDoc, blankSpec } from "../components/labs/labSpec";

// Console tab "Virtual Lab" (permission labs.manage): the lab library instructors pick from when they add a
// lab lesson to a course. A lab is a JSON definition run by packages/lab-engine. API: backend handlers/labs.ts.
// Guide: docs/VIRTUAL-LAB.md.

const LabPlayer = lazy(() => import("../components/course/LabPlayer"));

type Api = ReturnType<typeof useApi>;

interface LabSummary {
  id: string; title: string; description: string | null; status: "draft" | "published"; version: number; updated_at: string;
  updated_by_name: string | null; lesson_count: number; learner_count: number; passed_count: number;
}
interface LabDetail {
  lab: LabSummary & { spec: unknown };
  versions: { version: number; created_at: string; created_by_name: string | null }[];
  lessons: { id: string; title: string; course_id: string; course_title: string }[];
}
interface SpecError { path: string; message: string }
interface ProgressRow {
  user_id: string; name: string; email: string; lesson_title: string; course_title: string; passed_count: number; total: number;
  attempts: number; passed_at: string | null; passed_lab_version: number | null; updated_at: string;
}

const STATUS = {
  draft: { label: "ฉบับร่าง", color: "#3a4660", bg: "#eceff4" },
  published: { label: "เผยแพร่แล้ว", color: "#1f6b45", bg: "#dff3e8" }
};

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

export const LabsAdminPage: React.FC = () => {
  const api = useApi();
  const [labs, setLabs] = useState<LabSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [results, setResults] = useState<LabSummary | null>(null);

  const load = () => api.get<{ labs: LabSummary[] }>("/labs").then(d => setLabs(d.labs)).catch(err => setError(err.message));
  useEffect(() => { load(); }, [api.token]);

  const remove = async (lab: LabSummary) => {
    if (!window.confirm(`ลบ lab "${lab.title}" และทุกเวอร์ชันถาวร?`)) return;
    try { await api.request(`/labs/${lab.id}`, { method: "DELETE" }); load(); } catch (err: any) { setError(err.message); }
  };

  return (
    <div>
      <div className="header-row">
        <div>
          <h1 className="header-title">Virtual Lab</h1>
          <p className="header-desc">คลัง lab เครือข่ายจำลอง lab ที่เผยแพร่แล้วผู้สอนเลือกใส่เป็นบทเรียนในคอร์สได้ ระบบตรวจผลจากสถานะอุปกรณ์ และนับเป็นเงื่อนไขเรียนจบและออกใบประกาศ</p>
        </div>
        <button type="button" className="tech-button-primary" onClick={() => setEditing("new")}><FilePlus2 size={16} />สร้าง lab</button>
      </div>
      <div style={{ display: "grid", gap: 16 }}>
        <ErrorBox message={error} />
        {!labs ? <Empty text="กำลังโหลด…" /> : labs.length === 0 ? <Empty text="ยังไม่มี lab กด สร้าง lab เพื่อเริ่ม (เริ่มจากตัวอย่าง LAB-001 ได้)" /> : (
          <div className="glass-card" style={{ padding: 8, overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead><tr><th style={thStyle}>Lab</th><th style={thStyle}>สถานะ</th><th style={thStyle}>เวอร์ชัน</th><th style={thStyle}>ผู้เรียน</th><th style={thStyle}>แก้ไขล่าสุด</th><th style={thStyle} /></tr></thead>
              <tbody>
                {labs.map(lab => (
                  <tr key={lab.id}>
                    <td style={tdStyle}>
                      <button type="button" onClick={() => setEditing(lab.id)} style={{ background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left" }}>
                        <div style={{ fontWeight: 700, color: "var(--text-primary)" }}>{lab.title}</div>
                        {lab.description && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{lab.description}</div>}
                      </button>
                    </td>
                    <td style={tdStyle}>
                      <Chip {...STATUS[lab.status]} />
                      {lab.lesson_count > 0 && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>ใช้ใน {lab.lesson_count} บทเรียน</div>}
                    </td>
                    <td style={{ ...tdStyle, fontSize: 13 }}>v{lab.version}</td>
                    <td style={{ ...tdStyle, fontSize: 13 }}>{lab.learner_count ? <>{lab.learner_count} คน<div style={{ color: "var(--text-muted)" }}>ผ่าน {lab.passed_count}</div></> : "—"}</td>
                    <td style={{ ...tdStyle, fontSize: 13, color: "var(--text-secondary)" }}>{formatDateTime(lab.updated_at)}{lab.updated_by_name && <div>{lab.updated_by_name}</div>}</td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      <span style={{ display: "inline-flex", gap: 4 }}>
                        <IconBtn label="แก้ไข" onClick={() => setEditing(lab.id)}><Pencil size={14} /></IconBtn>
                        <IconBtn label="ผลของผู้เรียน" onClick={() => setResults(lab)}><Users size={14} /></IconBtn>
                        <IconBtn label="ลบ" danger onClick={() => remove(lab)}><Trash2 size={14} /></IconBtn>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && <LabEditor api={api} labId={editing === "new" ? null : editing} onClose={() => { setEditing(null); load(); }} onCreated={id => { load(); setEditing(id); }} />}
      {results && <LabResults api={api} lab={results} onClose={() => setResults(null)} />}
    </div>
  );
};

const LabEditor: React.FC<{ api: Api; labId: string | null; onClose: () => void; onCreated: (id: string) => void }> = ({ api, labId, onClose, onCreated }) => {
  const [detail, setDetail] = useState<LabDetail | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [specText, setSpecText] = useState(labId ? "" : pretty(sampleSpec()));
  const [specErrors, setSpecErrors] = useState<SpecError[] | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [trying, setTrying] = useState<unknown | null>(null);
  const [view, setView] = useState<"design" | "json">("design");
  // The designer edits the same JSON text; it is shown whenever that text parses.
  const designDoc = useMemo(() => { try { return asDoc(JSON.parse(specText)); } catch { return null; } }, [specText]);

  const load = () => labId && api.get<LabDetail>(`/labs/${labId}`).then(d => {
    setDetail(d); setTitle(d.lab.title); setDescription(d.lab.description ?? ""); setSpecText(pretty(d.lab.spec));
  }).catch(err => setError(err.message));
  useEffect(() => { load(); }, [labId]);

  const parseSpec = (): unknown | undefined => {
    try { return JSON.parse(specText); } catch (err: any) { setSpecErrors([{ path: "$", message: `JSON ไม่ถูกต้อง: ${err.message}` }]); return undefined; }
  };

  /** Checks the spec on the server and shows each problem with its JSON path; true when it is valid. */
  const check = async (spec: unknown, quiet = false): Promise<boolean> => {
    try {
      const res = await api.post<{ ok: boolean; errors?: SpecError[]; summary?: { title: string; devices: number; objectives: number } }>("/labs/validate", { spec });
      if (!res.ok) { setSpecErrors(res.errors ?? []); return false; }
      if (!quiet && res.summary) setChecked(`ถูกต้อง: ${res.summary.title} · ${res.summary.devices} อุปกรณ์ · ${res.summary.objectives} ข้อที่ต้องทำ`);
      return true;
    } catch (err: any) { setError(err.message); return false; }
  };

  const validate = async () => {
    setSpecErrors(null); setChecked(null); setError(null);
    const spec = parseSpec();
    if (spec !== undefined) await check(spec);
  };

  const save = async () => {
    setSpecErrors(null); setChecked(null); setError(null); setNotice(null);
    const spec = parseSpec();
    if (spec === undefined) return;
    setBusy(true);
    try {
      if (!(await check(spec, true))) return;
      if (!labId) {
        const res = await api.post<{ lab: LabSummary }>("/labs", { title: title.trim() || undefined, description: description.trim() || null, spec });
        onCreated(res.lab.id);
        return;
      }
      const res = await api.patch<{ lab: LabSummary }>(`/labs/${labId}`, { title: title.trim(), description: description.trim() || null, spec });
      setNotice(res.lab.version !== detail?.lab.version ? `บันทึกแล้ว เป็นเวอร์ชัน ${res.lab.version} (ผู้เรียนที่ทำค้างไว้ต้องเริ่มใหม่ ผลที่ผ่านแล้วยังอยู่)` : "บันทึกแล้ว");
      load();
    } catch (err: any) {
      setError(err.message);
    } finally { setBusy(false); }
  };

  const setStatus = async (publish: boolean) => {
    setError(null); setNotice(null);
    try {
      await api.post(`/labs/${labId}/${publish ? "publish" : "unpublish"}`, {});
      setNotice(publish ? "เผยแพร่แล้ว ผู้สอนเลือก lab นี้ในบทเรียนได้" : "ยกเลิกการเผยแพร่แล้ว");
      load();
    } catch (err: any) { setError(err.message); }
  };

  const tryIt = async () => {
    setSpecErrors(null); setChecked(null);
    const spec = parseSpec();
    if (spec !== undefined && await check(spec, true)) setTrying(spec);
  };

  const lab = detail?.lab;
  return (
    <Modal title={labId ? `แก้ไข lab: ${lab?.title ?? ""}` : "สร้าง lab"} onClose={onClose} width={1240}>
      <div style={{ display: "grid", gap: 14 }}>
        <ErrorBox message={error} />
        {notice && <Notice>{notice}</Notice>}
        {lab && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13, color: "var(--text-secondary)" }}>
            <Chip {...STATUS[lab.status]} /> <span>เวอร์ชัน {lab.version}</span>
            {lab.status === "draft"
              ? <button type="button" className="tech-button-primary" onClick={() => setStatus(true)}><CheckCircle size={14} />เผยแพร่</button>
              : <button type="button" className="tech-button-outline" onClick={() => setStatus(false)}>ยกเลิกการเผยแพร่</button>}
          </div>
        )}
        <Field label="ชื่อ lab" hint={labId ? undefined : "เว้นว่างได้ จะใช้ title ใน JSON"}>
          <input className="form-input" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Field label="คำอธิบายสั้น ๆ (สำหรับผู้สอนตอนเลือก lab)">
          <input className="form-input" value={description} onChange={e => setDescription(e.target.value)} maxLength={500} />
        </Field>
        <div role="tablist" style={{ display: "flex", gap: 6 }}>
          {([["design", "ออกแบบบนบอร์ด"], ["json", "JSON (ขั้นสูง)"]] as const).map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? "tech-button-primary" : "tech-button-outline"}
              style={{ borderRadius: "0.8rem", padding: "6px 14px" }}
              onClick={() => { if (key === "design" && !designDoc) { setSpecErrors([{ path: "$", message: "JSON ยังอ่านไม่ได้ แก้ในแท็บ JSON ก่อนกลับไปออกแบบ" }]); return; } setView(key); }}>{label}</button>
          ))}
        </div>
        {view === "design" && designDoc ? (
          <LabDesigner doc={designDoc} onChange={next => { setSpecText(pretty(next)); setChecked(null); setSpecErrors(null); }} />
        ) : (
          <Field label="นิยาม lab (JSON)" hint="อุปกรณ์ สายเชื่อม ค่าเริ่มต้น และข้อที่ต้องทำ รูปแบบดูได้ที่ docs/VIRTUAL-LAB.md">
            <textarea className="form-input" value={specText} onChange={e => { setSpecText(e.target.value); setChecked(null); }} spellCheck={false}
              style={{ minHeight: 320, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12.5, lineHeight: 1.5 }} />
          </Field>
        )}
        {specErrors && (
          <div role="alert" style={{ background: "rgba(220,38,38,0.06)", borderRadius: 12, padding: "10px 14px", fontSize: 13 }}>
            <strong style={{ color: "var(--danger)" }}>นิยาม lab ยังไม่ถูกต้อง</strong>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {specErrors.map((e, i) => <li key={i}><code>{e.path}</code> {e.message}</li>)}
            </ul>
          </div>
        )}
        {checked && <Notice>{checked}</Notice>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="tech-button-outline" onClick={() => { if (window.confirm("ล้างบอร์ดแล้วเริ่มใหม่?")) { setSpecText(pretty(blankSpec())); setChecked(null); setSpecErrors(null); } }}>เริ่มบอร์ดว่าง</button>
          <button type="button" className="tech-button-outline" onClick={() => { setSpecText(pretty(sampleSpec())); setChecked(null); setSpecErrors(null); }}>ใช้ตัวอย่าง LAB-001</button>
          <button type="button" className="tech-button-outline" onClick={validate}>ตรวจรูปแบบ</button>
          <button type="button" className="tech-button-outline" onClick={tryIt}><Play size={14} />ลองทำ</button>
          <button type="button" className="tech-button-primary" onClick={save} disabled={busy}><Save size={14} />{busy ? "กำลังบันทึก..." : labId ? "บันทึก" : "สร้าง (ฉบับร่าง)"}</button>
        </div>
        {detail && detail.lessons.length > 0 && (
          <div style={{ fontSize: 13 }}>
            <strong>บทเรียนที่ใช้ lab นี้</strong>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{detail.lessons.map(l => <li key={l.id}>{l.course_title} · {l.title}</li>)}</ul>
          </div>
        )}
        {detail && detail.versions.length > 1 && (
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            ประวัติเวอร์ชัน: {detail.versions.map(v => `v${v.version} (${formatDateTime(v.created_at)}${v.created_by_name ? `, ${v.created_by_name}` : ""})`).join(" · ")}
          </div>
        )}
      </div>
      {trying !== null && (
        <Modal title="ลองทำ lab (ไม่บันทึกผล)" onClose={() => setTrying(null)} width={1200}>
          <Suspense fallback={<Empty text="กำลังเตรียม lab…" />}>
            <LabPlayer lessonId={null} preview completed={false} onCompleted={() => undefined} onReload={() => undefined}
              lab={{ id: "try", title: title || "lab", description: null, version: 0, spec: trying, progress: null }} />
          </Suspense>
        </Modal>
      )}
    </Modal>
  );
};

const LabResults: React.FC<{ api: Api; lab: LabSummary; onClose: () => void }> = ({ api, lab, onClose }) => {
  const [rows, setRows] = useState<ProgressRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<{ progress: ProgressRow[] }>(`/labs/${lab.id}/progress`).then(d => setRows(d.progress)).catch(err => setError(err.message)); }, [lab.id]);
  return (
    <Modal title={`ผลของผู้เรียน: ${lab.title}`} onClose={onClose} width={960}>
      <ErrorBox message={error} />
      {!rows ? <Empty text="กำลังโหลด…" /> : rows.length === 0 ? <Empty text="ยังไม่มีผู้เรียนทำ lab นี้" /> : (
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead><tr><th style={thStyle}>ผู้เรียน</th><th style={thStyle}>คอร์ส / บทเรียน</th><th style={thStyle}>ล่าสุด</th><th style={thStyle}>ผ่านเมื่อ</th><th style={thStyle}>ครั้งที่</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={`${r.user_id}-${r.lesson_title}-${r.course_title}`}>
                  <td style={tdStyle}><div style={{ fontWeight: 600 }}>{r.name}</div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>{r.email}</div></td>
                  <td style={{ ...tdStyle, fontSize: 13 }}>{r.course_title}<div style={{ color: "var(--text-muted)" }}>{r.lesson_title}</div></td>
                  <td style={{ ...tdStyle, fontSize: 13 }}>{r.passed_count}/{r.total}<div style={{ color: "var(--text-muted)" }}>{formatDateTime(r.updated_at)}</div></td>
                  <td style={{ ...tdStyle, fontSize: 13 }}>{r.passed_at ? <>{formatDateTime(r.passed_at)}<div style={{ color: "var(--text-muted)" }}>lab v{r.passed_lab_version}</div></> : "—"}</td>
                  <td style={{ ...tdStyle, fontSize: 13 }}>{r.attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
};
