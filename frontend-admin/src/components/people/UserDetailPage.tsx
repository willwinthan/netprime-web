import React, { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, Mail, Plus, Save, ShieldOff, ShieldCheck, StickyNote, Tag, Trash2, X } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, Empty, ErrorBox, Field, grid2, tableStyle, tdStyle, thStyle, formatDateTime, formatBaht } from "../site-admin/ui";
import { CourseOption, displayValue, FieldInput, noticeStyle, ProfileField, smallButton } from "./shared";

type Role = "admin" | "coordinator" | "instructor" | "partner" | "student";
interface Detail {
  user: {
    id: string; name: string; email: string; roles: Role[]; tags: string[]; status: "active" | "suspended";
    company_name: string | null; created_at: string; last_login_at: string | null; email_verified_at: string | null; invite_expires_at: string | null;
  };
  profile_fields: ProfileField[];
  enrollments: Array<{ id: string; course_id: string; course_title: string | null; progress_percent: number; status: string; enrolled_at: string; completed_at: string | null; expires_at: string | null; last_lesson_at: string | null }>;
  orders: Array<{ id: string; reference: string; course_title: string | null; amount: number; status: string; receipt_no: string | null; paid_at: string | null; created_at: string }>;
  payments: Array<{ id: string; course_title: string | null; amount: number; currency: string; status: string; created_at: string }>;
  certificates: Array<{ id: string; course_title: string | null; certificate_code: string; issued_at: string; revoked_at: string | null }>;
  events: Array<{ id: number; type: string; course_title: string | null; created_at: string }>;
  notes: Array<{ id: string; body: string; author_name: string | null; author_id: string | null; created_at: string }> | null;
  canManage: boolean;
}

const ROLE_LABEL: Record<Role, string> = { admin: "ผู้ดูแลระบบ", coordinator: "เจ้าหน้าที่ประสานงาน", instructor: "ผู้สอน", partner: "พาร์ตเนอร์องค์กร", student: "ผู้เรียน" };
const EVENT_LABEL: Record<string, string> = {
  login: "เข้าสู่ระบบ", signup: "สมัครสมาชิก", course_view: "เปิดดูคอร์ส", lesson_view: "เปิดบทเรียน", lesson_complete: "เรียนจบบทเรียน",
  course_complete: "เรียนจบคอร์ส", enroll: "ลงทะเบียนเรียน", order_created: "สร้างคำสั่งซื้อ", order_paid: "ชำระเงินแล้ว", quiz_submit: "ส่งแบบทดสอบ",
  exam_submit: "ส่งข้อสอบ", assignment_submit: "ส่งงาน", certificate_issued: "ได้รับใบประกาศ", post_created: "โพสต์ในกระดานสนทนา"
};
const ORDER_STATUS: Record<string, string> = { pending: "รอชำระ", partial: "ชำระบางส่วน", paid: "ชำระแล้ว", rejected: "ปฏิเสธ", cancelled: "ยกเลิก", expired: "หมดอายุ", refunded: "คืนเงินแล้ว", completed: "สำเร็จ", failed: "ไม่สำเร็จ" };
const ENROLL_STATUS: Record<string, string> = { active: "กำลังเรียน", completed: "เรียนจบ", suspended: "ระงับสิทธิ์" };

const section: React.CSSProperties = { padding: 20 };
const h2: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 16, margin: "0 0 12px" };

/**
 * User 360: profile, roles, organization, tags, custom fields, learning, purchases, certificates,
 * recent activity and staff notes, with quick actions. Needs users.view; actions need users.manage.
 */
export const UserDetailPage: React.FC<{ userId: string; onBack: () => void }> = ({ userId, onBack }) => {
  const api = useApi();
  const [data, setData] = useState<Detail | null>(null);
  const [courses, setCourses] = useState<CourseOption[]>([]);
  const [canImport, setCanImport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [courseId, setCourseId] = useState("");
  const [note, setNote] = useState("");
  const [editingFields, setEditingFields] = useState(false);
  const [fieldDraft, setFieldDraft] = useState<Record<string, string>>({});
  const [password, setPassword] = useState("");

  const load = () => api.get<Detail>(`/admin/people/${userId}`).then(d => { setData(d); setError(null); }).catch(err => setError(err.message));
  useEffect(() => {
    load();
    api.get<{ courses: CourseOption[]; canImport: boolean }>("/admin/people-meta").then(m => { setCourses(m.courses); setCanImport(m.canImport); }).catch(() => undefined);
  }, [userId, api.token]);

  const act = async (fn: () => Promise<{ message?: string } | unknown>, done?: string) => {
    try {
      setBusy(true);
      setError(null);
      const res = await fn() as { message?: string } | undefined;
      setNotice(done ?? res?.message ?? "บันทึกแล้ว");
      await load();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  if (!data) {
    return (
      <div>
        <button className="tech-button-outline" onClick={onBack} style={{ marginBottom: 16 }}><ArrowLeft size={16} />กลับไปรายชื่อผู้ใช้</button>
        <ErrorBox message={error} />{!error && <Empty text="กำลังโหลด…" />}
      </div>
    );
  }
  const { user, canManage } = data;
  const self = user.id === api.user?.id;
  const canTag = canManage || canImport;

  return (
    <div>
      <button className="tech-button-outline" onClick={onBack} style={{ marginBottom: 16 }}><ArrowLeft size={16} />กลับไปรายชื่อผู้ใช้</button>
      <div className="header-row">
        <div>
          <h1 className="header-title">{user.name}</h1>
          <p className="header-desc">{user.email} · สมัครเมื่อ {formatDateTime(user.created_at)} · เข้าสู่ระบบล่าสุด {user.last_login_at ? formatDateTime(user.last_login_at) : "ยังไม่เคย"}</p>
        </div>
      </div>
      <ErrorBox message={error} />
      {notice && <div role="status" style={noticeStyle}>{notice}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, alignItems: "start" }}>
        <section className="glass-card" style={section}>
          <h2 style={h2}><ShieldCheck size={18} />บัญชี</h2>
          <div style={{ display: "grid", gap: 10, fontSize: 14 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{user.roles.map(r => <Chip key={r} label={ROLE_LABEL[r] ?? r} color="var(--primary)" bg="var(--primary-glow)" />)}</div>
            <div>องค์กร: <strong>{user.company_name || "ผู้เรียนรายบุคคล"}</strong></div>
            <div>สถานะ: {user.status === "active" ? <Chip label="ใช้งานอยู่" color="var(--accent)" bg="var(--accent-glow)" /> : <Chip label="ถูกระงับ" color="#b42318" bg="rgba(239,68,68,0.1)" />}
              {user.invite_expires_at && !user.last_login_at && <span style={{ fontSize: 12, color: "#9a5b00" }}> · รอตั้งรหัสผ่านจากคำเชิญ</span>}
              {!user.email_verified_at && <span style={{ fontSize: 12, color: "var(--text-muted)" }}> · ยังไม่ยืนยันอีเมล</span>}</div>
            {canManage && !self && (
              <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {user.status === "active" && <button className="tech-button-outline" style={smallButton} disabled={busy} onClick={() => act(() => api.post(`/admin/accounts/${user.id}/invite`, {}))}><Mail size={14} />ส่งคำเชิญ/ลิงก์ตั้งรหัสผ่าน</button>}
                  {user.status === "active"
                    ? <button className="tech-button-outline" style={smallButton} disabled={busy} onClick={() => window.confirm(`ระงับบัญชี ${user.name}?`) && act(() => api.patch(`/admin/accounts/${user.id}`, { status: "suspended" }), "ระงับบัญชีแล้ว")}><ShieldOff size={14} />ระงับบัญชี</button>
                    : <button className="tech-button-outline" style={smallButton} disabled={busy} onClick={() => act(() => api.patch(`/admin/accounts/${user.id}`, { status: "active" }), "เปิดใช้งานบัญชีแล้ว")}><ShieldCheck size={14} />เปิดใช้งาน</button>}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input className="form-input" type="password" placeholder="รหัสผ่านใหม่ (12 ตัวขึ้นไป)" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} style={{ flex: 1 }} />
                  <button className="tech-button-outline" style={smallButton} disabled={busy || password.length < 12} onClick={() => act(() => api.post(`/admin/accounts/${user.id}/password`, { password }).then(r => { setPassword(""); return r; }))}>ตั้งรหัสผ่าน</button>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="glass-card" style={section}>
          <h2 style={h2}><Tag size={18} />แท็ก</h2>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {user.tags.length === 0 && <span style={{ fontSize: 13, color: "var(--text-muted)" }}>ยังไม่มีแท็ก</span>}
            {user.tags.map(t => (
              <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, padding: "3px 6px 3px 10px", borderRadius: 99, background: "var(--secondary-glow)", color: "var(--secondary)" }}>
                {t}
                {canTag && <button aria-label={`ลบแท็ก ${t}`} disabled={busy} onClick={() => act(() => api.request(`/admin/people/${user.id}/tags/${encodeURIComponent(t)}`, { method: "DELETE" }), "ลบแท็กแล้ว")}
                  style={{ background: "none", border: 0, cursor: "pointer", color: "inherit", padding: 0, display: "flex" }}><X size={12} /></button>}
              </span>
            ))}
          </div>
          {canTag && (
            <form onSubmit={e => { e.preventDefault(); if (newTag.trim()) act(() => api.post(`/admin/people/${user.id}/tags`, { tag: newTag }).then(r => { setNewTag(""); return r; }), "เพิ่มแท็กแล้ว"); }} style={{ display: "flex", gap: 8 }}>
              <input className="form-input" placeholder="เพิ่มแท็ก เช่น vip" maxLength={50} value={newTag} onChange={e => setNewTag(e.target.value)} style={{ flex: 1 }} />
              <button className="tech-button-outline" style={smallButton} disabled={busy || !newTag.trim()}><Plus size={14} />เพิ่ม</button>
            </form>
          )}
        </section>

        {data.profile_fields.length > 0 && (
          <section className="glass-card" style={section}>
            <h2 style={h2}>ข้อมูลเพิ่มเติม</h2>
            {editingFields ? (
              <form onSubmit={e => { e.preventDefault(); act(() => api.request(`/admin/people/${user.id}/profile-fields`, { method: "PUT", body: JSON.stringify({ values: fieldDraft }) }).then(r => { setEditingFields(false); return r; })); }} style={grid2}>
                {data.profile_fields.map(f => (
                  <Field key={f.id} label={f.label + (f.visibility === "admin" ? " (เฉพาะเจ้าหน้าที่)" : "")}>
                    <FieldInput field={{ ...f, required: false }} value={fieldDraft[f.key] ?? ""} onChange={v => setFieldDraft(d => ({ ...d, [f.key]: v }))} />
                  </Field>
                ))}
                <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button type="button" className="tech-button-outline" onClick={() => setEditingFields(false)}>ยกเลิก</button>
                  <button type="submit" className="tech-button-primary" disabled={busy}><Save size={16} />บันทึก</button>
                </div>
              </form>
            ) : (
              <>
                <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px", margin: 0, fontSize: 14 }}>
                  {data.profile_fields.map(f => <React.Fragment key={f.id}><dt style={{ color: "var(--text-secondary)" }}>{f.label}</dt><dd style={{ margin: 0 }}>{displayValue(f, f.value)}</dd></React.Fragment>)}
                </dl>
                {canManage && <button className="tech-button-outline" style={{ ...smallButton, marginTop: 12 }} onClick={() => { setFieldDraft(Object.fromEntries(data.profile_fields.map(f => [f.key, f.value ?? ""]))); setEditingFields(true); }}>แก้ไข</button>}
              </>
            )}
          </section>
        )}
      </div>

      <section className="glass-card" style={{ ...section, marginTop: 16 }}>
        <h2 style={h2}><BookOpen size={18} />การเรียน ({data.enrollments.length})</h2>
        {canManage && (
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <select className="form-input" aria-label="เลือกคอร์สที่จะลงทะเบียนให้" value={courseId} onChange={e => setCourseId(e.target.value)} style={{ flex: "1 1 260px", maxWidth: 480 }}>
              <option value="">— เลือกคอร์สเพื่อลงทะเบียนให้ —</option>
              {courses.map(c => <option key={c.id} value={c.id}>{c.title}{c.status !== "published" ? ` (${c.status})` : ""}</option>)}
            </select>
            <button className="tech-button-outline" disabled={busy || !courseId} onClick={() => act(() => api.post("/admin/people/bulk", { action: "enroll", user_ids: [user.id], course_id: courseId }).then(r => { setCourseId(""); return r; }), "ลงทะเบียนเรียนให้แล้ว")}><Plus size={16} />ลงทะเบียนเรียน</button>
          </div>
        )}
        {data.enrollments.length === 0 ? <Empty text="ยังไม่ได้ลงทะเบียนคอร์ส" /> : (
          <div style={{ overflowX: "auto" }}><table style={tableStyle}>
            <thead><tr><th style={thStyle}>คอร์ส</th><th style={thStyle}>ความคืบหน้า</th><th style={thStyle}>สถานะ</th><th style={thStyle}>ลงทะเบียน</th><th style={thStyle}>เรียนล่าสุด</th></tr></thead>
            <tbody>{data.enrollments.map(e => (
              <tr key={e.id}>
                <td style={tdStyle}>{e.course_title ?? e.course_id}{e.expires_at && <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>หมดสิทธิ์ {formatDateTime(e.expires_at)}</div>}</td>
                <td style={tdStyle}><div style={{ minWidth: 110 }}><div style={{ fontSize: 12 }}>{e.progress_percent ?? 0}%</div>
                  <div className="progress-bar-container" style={{ height: 6 }}><div className="progress-bar-fill" style={{ width: `${Math.min(100, e.progress_percent ?? 0)}%` }} /></div></div></td>
                <td style={tdStyle}>{ENROLL_STATUS[e.status] ?? e.status}</td>
                <td style={{ ...tdStyle, fontSize: 13 }}>{formatDateTime(e.enrolled_at)}</td>
                <td style={{ ...tdStyle, fontSize: 13 }}>{formatDateTime(e.last_lesson_at)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, marginTop: 16, alignItems: "start" }}>
        <section className="glass-card" style={section}>
          <h2 style={h2}>คำสั่งซื้อและการชำระเงิน</h2>
          {data.orders.length + data.payments.length === 0 ? <Empty text="ยังไม่มีคำสั่งซื้อ" /> : (
            <table style={tableStyle}><tbody>
              {data.orders.map(o => (
                <tr key={o.id}><td style={tdStyle}>{o.reference}<div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{o.course_title}</div></td>
                  <td style={tdStyle}>{formatBaht(o.amount)}</td><td style={tdStyle}>{ORDER_STATUS[o.status] ?? o.status}{o.receipt_no && <div style={{ fontSize: 12 }}>{o.receipt_no}</div>}</td>
                  <td style={{ ...tdStyle, fontSize: 13 }}>{formatDateTime(o.paid_at ?? o.created_at)}</td></tr>
              ))}
              {data.payments.map(p => (
                <tr key={p.id}><td style={tdStyle}>ชำระออนไลน์<div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{p.course_title}</div></td>
                  <td style={tdStyle}>{formatBaht(p.amount)}</td><td style={tdStyle}>{ORDER_STATUS[p.status] ?? p.status}</td><td style={{ ...tdStyle, fontSize: 13 }}>{formatDateTime(p.created_at)}</td></tr>
              ))}
            </tbody></table>
          )}
        </section>

        <section className="glass-card" style={section}>
          <h2 style={h2}>ใบประกาศนียบัตร ({data.certificates.length})</h2>
          {data.certificates.length === 0 ? <Empty text="ยังไม่มีใบประกาศ" /> : (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, display: "grid", gap: 6 }}>
              {data.certificates.map(c => <li key={c.id}>{c.course_title} · <code>{c.certificate_code}</code> · {formatDateTime(c.issued_at)}{c.revoked_at && <span style={{ color: "#b42318" }}> (เพิกถอนแล้ว)</span>}</li>)}
            </ul>
          )}
        </section>

        <section className="glass-card" style={section}>
          <h2 style={h2}>กิจกรรมล่าสุด</h2>
          {data.events.length === 0 ? <Empty text="ยังไม่มีบันทึกกิจกรรม" /> : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: 13, display: "grid", gap: 6, maxHeight: 320, overflowY: "auto" }}>
              {data.events.map(ev => <li key={ev.id}><span style={{ color: "var(--text-secondary)" }}>{formatDateTime(ev.created_at)}</span> · {EVENT_LABEL[ev.type] ?? ev.type}{ev.course_title && ` · ${ev.course_title}`}</li>)}
            </ul>
          )}
        </section>

        {data.notes && (
          <section className="glass-card" style={section}>
            <h2 style={h2}><StickyNote size={18} />บันทึกของเจ้าหน้าที่</h2>
            <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--text-muted)" }}>เห็นเฉพาะเจ้าหน้าที่ที่จัดการผู้ใช้ได้ ผู้ใช้ไม่เห็นบันทึกนี้</p>
            <form onSubmit={e => { e.preventDefault(); act(() => api.post(`/admin/people/${user.id}/notes`, { body: note }).then(r => { setNote(""); return r; }), "บันทึกแล้ว"); }} style={{ display: "grid", gap: 8, marginBottom: 12 }}>
              <textarea className="form-input" rows={3} maxLength={4000} placeholder="เช่น โทรติดตามแล้ว สนใจคอร์สต่อ" value={note} onChange={e => setNote(e.target.value)} />
              <button className="tech-button-primary" disabled={busy || !note.trim()} style={{ justifySelf: "end" }}><Save size={16} />เพิ่มบันทึก</button>
            </form>
            <div style={{ display: "grid", gap: 10 }}>
              {data.notes.map(n => (
                <div key={n.id} style={{ padding: "10px 12px", borderRadius: 10, background: "rgba(15,23,42,0.04)", fontSize: 14 }}>
                  <div style={{ whiteSpace: "pre-wrap" }}>{n.body}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "var(--text-secondary)", marginTop: 6 }}>
                    <span>{n.author_name ?? "-"} · {formatDateTime(n.created_at)}</span>
                    {(n.author_id === api.user?.id || api.user?.roles?.includes("admin") || api.user?.role === "admin") && (
                      <button aria-label="ลบบันทึก" disabled={busy} onClick={() => window.confirm("ลบบันทึกนี้?") && act(() => api.request(`/admin/people/${user.id}/notes/${n.id}`, { method: "DELETE" }), "ลบบันทึกแล้ว")}
                        style={{ background: "none", border: 0, cursor: "pointer", color: "inherit" }}><Trash2 size={14} /></button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
};
