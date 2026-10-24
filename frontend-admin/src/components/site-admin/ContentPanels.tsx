import React, { useEffect, useState } from "react";
import { Pencil, Trash2, Plus, ImageUp, Phone, Mail, Save, ExternalLink } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { IconButton } from "./SessionsPanel";
import {
  Chip, Modal, Field, ErrorBox, Empty, grid2, tableStyle, thStyle, tdStyle, formatDate, formatDateTime, uploadImage
} from "./ui";

type Api = ReturnType<typeof useApi>;

const INQUIRY_STATUS = {
  new: { label: "ใหม่", color: "var(--primary)", bg: "var(--primary-glow)" },
  in_progress: { label: "กำลังดำเนินการ", color: "var(--secondary)", bg: "var(--secondary-glow)" },
  closed: { label: "ปิดแล้ว", color: "var(--text-secondary)", bg: "rgba(100,116,139,0.12)" }
} as const;
type InquiryStatus = keyof typeof INQUIRY_STATUS;

// ==========================================
// Contact inquiries
// ==========================================

interface Inquiry {
  id: string; name: string; email: string; phone: string | null; company: string | null; topic: string | null;
  message: string; status: InquiryStatus; admin_note: string | null; created_at: string;
}

export const InquiriesPanel: React.FC = () => {
  const api = useApi();
  const [status, setStatus] = useState<InquiryStatus | "">("new");
  const [items, setItems] = useState<Inquiry[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.get<{ inquiries: Inquiry[] }>(`/admin/site/inquiries${status ? `?status=${status}` : ""}`);
      setItems(data.inquiries);
      setNotes(Object.fromEntries(data.inquiries.map(i => [i.id, i.admin_note || ""])));
    } catch (err: any) { setError(err.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [status, api.token]);

  const update = async (item: Inquiry, body: Record<string, unknown>) => {
    try {
      await api.patch(`/admin/site/inquiries/${item.id}`, body);
      await load();
    } catch (err: any) { setError(err.message); }
  };
  const remove = async (item: Inquiry) => {
    if (!confirm(`ลบข้อความจาก ${item.name}?`)) return;
    try {
      await api.request(`/admin/site/inquiries/${item.id}`, { method: "DELETE" });
      await load();
    } catch (err: any) { setError(err.message); }
  };

  return (
    <div className="site-form">
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
        {([["new", "ใหม่"], ["in_progress", "กำลังดำเนินการ"], ["closed", "ปิดแล้ว"], ["", "ทั้งหมด"]] as const).map(([key, label]) => (
          <button key={key} onClick={() => setStatus(key)} className={status === key ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "6px 14px", fontSize: "13px" }}>{label}</button>
        ))}
      </div>
      <ErrorBox message={error} />
      {loading ? <Empty text="กำลังโหลด…" /> : items.length === 0 ? <div className="glass-card"><Empty text="ไม่มีข้อความในกลุ่มนี้" /></div> : (
        <div style={{ display: "grid", gap: "14px" }}>
          {items.map(item => (
            <div key={item.id} className="glass-card" style={{ padding: "20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
                <div>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    <strong style={{ fontSize: "16px" }}>{item.name}</strong>
                    <Chip {...INQUIRY_STATUS[item.status]} />
                    {item.topic && <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>· {item.topic}</span>}
                  </div>
                  <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "4px", display: "flex", gap: "14px", flexWrap: "wrap" }}>
                    {item.company && <span>{item.company}</span>}
                    {item.phone && <a href={`tel:${item.phone}`} style={{ color: "inherit" }}><Phone size={12} /> {item.phone}</a>}
                    <a href={`mailto:${item.email}`} style={{ color: "inherit" }}><Mail size={12} /> {item.email}</a>
                    <span>{formatDateTime(item.created_at)}</span>
                  </div>
                </div>
                <div>
                  <select className="form-input" value={item.status} onChange={e => update(item, { status: e.target.value })} style={{ padding: "6px 10px", width: "auto" }}>
                    {Object.entries(INQUIRY_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                  <IconButton title="ลบ" danger onClick={() => remove(item)}><Trash2 size={16} /></IconButton>
                </div>
              </div>
              <p style={{ marginTop: "12px", whiteSpace: "pre-wrap", fontSize: "14px" }}>{item.message}</p>
              <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                <input className="form-input" placeholder="บันทึกการติดตาม เช่น โทรกลับแล้ว ส่งใบเสนอราคาแล้ว" value={notes[item.id] ?? ""}
                  onChange={e => setNotes(prev => ({ ...prev, [item.id]: e.target.value }))} />
                <button className="tech-button-outline" disabled={(notes[item.id] ?? "") === (item.admin_note || "")}
                  onClick={() => update(item, { admin_note: notes[item.id], ...(item.status === "new" ? { status: "in_progress" } : {}) })}>
                  <Save size={14} />บันทึก
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ==========================================
// Articles
// ==========================================

const ImageInput: React.FC<{ api: Api; value: string; onChange: (url: string) => void; onError: (message: string) => void }> = ({ api, value, onChange, onError }) => {
  const [uploading, setUploading] = useState(false);
  return (
    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
      <input className="form-input" value={value} onChange={e => onChange(e.target.value)} placeholder="https://… หรืออัปโหลด" />
      <label className="tech-button-outline" style={{ whiteSpace: "nowrap", cursor: "pointer" }}>
        <ImageUp size={16} />{uploading ? "กำลังอัปโหลด…" : "อัปโหลด"}
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={async e => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          try { setUploading(true); onChange(await uploadImage(file, api.token)); }
          catch (err: any) { onError(err.message); } finally { setUploading(false); }
        }} />
      </label>
      {value && <img src={value} alt="" style={{ height: "40px", width: "64px", objectFit: "cover", borderRadius: "8px" }} />}
    </div>
  );
};

interface Promotion {
  id: string; title: string; description: string | null; voucher_code: string | null; link_url: string | null; image_url: string | null;
  starts_at: string | null; ends_at: string | null; active: number; sort_order: number;
}

export const PromotionsPanel: React.FC = () => {
  const api = useApi();
  const [items, setItems] = useState<Promotion[]>([]);
  const [editing, setEditing] = useState<Partial<Promotion> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try { setItems((await api.get<{ promotions: Promotion[] }>("/admin/site/promotions")).promotions); }
    catch (err: any) { setError(err.message); }
  };
  useEffect(() => { load(); }, [api.token]);

  const toggle = async (p: Promotion) => {
    try { await api.patch(`/admin/site/promotions/${p.id}`, { active: !p.active }); await load(); }
    catch (err: any) { setError(err.message); }
  };
  const remove = async (p: Promotion) => {
    if (!confirm(`ลบโปรโมชั่น "${p.title}"?`)) return;
    try { await api.request(`/admin/site/promotions/${p.id}`, { method: "DELETE" }); await load(); }
    catch (err: any) { setError(err.message); }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", gap: "12px", flexWrap: "wrap" }}>
        <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>โค้ดส่วนลดที่ใช้ซื้อคอร์สออนไลน์ต้องสร้างในเมนู ผู้สอน › โค้ดส่วนลด ด้วย</p>
        <button className="tech-button-primary" onClick={() => setEditing({ active: 1, sort_order: 0 })}><Plus size={16} />เพิ่มโปรโมชั่น</button>
      </div>
      <ErrorBox message={error} />
      {items.length === 0 ? <div className="glass-card"><Empty text="ยังไม่มีโปรโมชั่น" /></div> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "16px" }}>
          {items.map(p => (
            <div key={p.id} className="glass-card" style={{ padding: "20px", opacity: p.active ? 1 : 0.6 }}>
              {p.image_url && <img src={p.image_url} alt="" style={{ width: "100%", height: "120px", objectFit: "cover", borderRadius: "12px", marginBottom: "12px" }} />}
              <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                <strong>{p.title}</strong>
                {p.active ? <Chip label="แสดงอยู่" color="var(--accent)" bg="var(--accent-glow)" /> : <Chip label="ปิด" color="var(--text-secondary)" bg="rgba(100,116,139,0.12)" />}
              </div>
              {p.description && <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "6px" }}>{p.description}</p>}
              <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "8px" }}>
                {p.voucher_code && <>โค้ด <code>{p.voucher_code}</code> · </>}{formatDate(p.starts_at)} – {formatDate(p.ends_at)}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "12px" }}>
                <button className="tech-button-outline" style={{ padding: "4px 12px", fontSize: "12px" }} onClick={() => toggle(p)}>{p.active ? "ปิดการแสดง" : "เปิดการแสดง"}</button>
                <IconButton title="แก้ไข" onClick={() => setEditing(p)}><Pencil size={16} /></IconButton>
                <IconButton title="ลบ" danger onClick={() => remove(p)}><Trash2 size={16} /></IconButton>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && <PromotionForm api={api} initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
};

const PromotionForm: React.FC<{ api: Api; initial: Partial<Promotion>; onClose: () => void; onSaved: () => void }> = ({ api, initial, onClose, onSaved }) => {
  const [form, setForm] = useState({
    title: initial.title || "", description: initial.description || "", voucher_code: initial.voucher_code || "",
    link_url: initial.link_url || "", image_url: initial.image_url || "", starts_at: initial.starts_at || "",
    ends_at: initial.ends_at || "", active: initial.active !== 0, sort_order: initial.sort_order ?? 0
  });
  const [error, setError] = useState<string | null>(null);
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(prev => ({ ...prev, [key]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setError(null);
      const body = { ...form, sort_order: Number(form.sort_order) };
      if (initial.id) await api.patch(`/admin/site/promotions/${initial.id}`, body);
      else await api.post("/admin/site/promotions", body);
      onSaved();
    } catch (err: any) { setError(err.message); }
  };
  return (
    <Modal title={initial.id ? "แก้ไขโปรโมชั่น" : "เพิ่มโปรโมชั่น"} onClose={onClose}>
      <ErrorBox message={error} />
      <form onSubmit={save} style={grid2}>
        <Field label="ชื่อโปรโมชั่น *" span><input className="form-input" required maxLength={160} value={form.title} onChange={set("title")} /></Field>
        <Field label="รายละเอียด" span><textarea className="form-input" rows={3} maxLength={1000} value={form.description} onChange={set("description")} /></Field>
        <Field label="โค้ดส่วนลด"><input className="form-input" maxLength={40} value={form.voucher_code} onChange={set("voucher_code")} /></Field>
        <Field label="ลิงก์ปุ่ม" hint="เช่น #schedule หรือ https://…"><input className="form-input" maxLength={500} value={form.link_url} onChange={set("link_url")} /></Field>
        <Field label="รูปภาพ" span><ImageInput api={api} value={form.image_url} onChange={url => setForm(prev => ({ ...prev, image_url: url }))} onError={setError} /></Field>
        <Field label="เริ่มแสดง"><input className="form-input" type="date" value={form.starts_at} onChange={set("starts_at")} /></Field>
        <Field label="สิ้นสุด"><input className="form-input" type="date" value={form.ends_at} min={form.starts_at || undefined} onChange={set("ends_at")} /></Field>
        <Field label="ลำดับการแสดง" hint="น้อย = แสดงก่อน"><input className="form-input" type="number" min={0} max={1000} value={form.sort_order} onChange={set("sort_order")} /></Field>
        <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "14px" }}><input type="checkbox" checked={form.active} onChange={set("active")} />เปิดการแสดง</label>
        <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary">บันทึก</button>
        </div>
      </form>
    </Modal>
  );
};

// ==========================================
// Site settings
// ==========================================

export const SettingsPanel: React.FC = () => {
  const api = useApi();
  const [form, setForm] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get<{ settings: Record<string, any> }>("/admin/site/settings")
      .then(data => setForm({ ...data.settings, announcement: { ...data.settings.announcement } }))
      .catch(err => setError(err.message));
  }, [api.token]);

  if (!form) return <><ErrorBox message={error} /><Empty text="กำลังโหลด…" /></>;
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setSaved(false); setForm(prev => ({ ...prev!, [key]: e.target.value })); };
  const setAnn = (key: string, value: unknown) => { setSaved(false); setForm(prev => ({ ...prev!, announcement: { ...prev!.announcement, [key]: value } })); };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setError(null);
      const data = await api.request<{ settings: Record<string, any> }>("/admin/site/settings", { method: "PUT", body: JSON.stringify(form) });
      setForm(data.settings);
      setSaved(true);
    } catch (err: any) { setError(err.message); }
  };

  return (
    <form onSubmit={save} className="site-form" style={{ display: "grid", gap: "20px", maxWidth: "860px" }}>
      <ErrorBox message={error} />
      <div className="glass-card" style={{ padding: "24px" }}>
        <h3 style={{ fontSize: "16px", marginBottom: "4px" }}>แถบประกาศบนสุดของเว็บ</h3>
        <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "14px" }}>ใช้แจ้งรอบอบรมใหม่ วันหยุด หรือโปรโมชั่นด่วน</p>
        <div style={grid2}>
          <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "14px", gridColumn: "1 / -1" }}>
            <input type="checkbox" checked={!!form.announcement.active} onChange={e => setAnn("active", e.target.checked)} />แสดงประกาศ
          </label>
          <Field label="ข้อความ" span><input className="form-input" maxLength={200} value={form.announcement.text || ""} onChange={e => setAnn("text", e.target.value)} /></Field>
          <Field label="ลิงก์เมื่อกด" hint="เช่น #schedule หรือ https://…" span><input className="form-input" maxLength={500} value={form.announcement.link || ""} onChange={e => setAnn("link", e.target.value)} /></Field>
        </div>
      </div>
      <div className="glass-card" style={{ padding: "24px" }}>
        <h3 style={{ fontSize: "16px", marginBottom: "14px" }}>ข้อมูลติดต่อ (แสดงที่ header, footer และหน้าติดต่อ)</h3>
        <div style={grid2}>
          <Field label="เบอร์โทร"><input className="form-input" maxLength={40} value={form.phone || ""} onChange={set("phone")} /></Field>
          <Field label="อีเมลติดต่อ"><input className="form-input" type="email" maxLength={254} value={form.email || ""} onChange={set("email")} /></Field>
          <Field label="LINE Official"><input className="form-input" maxLength={60} value={form.line || ""} onChange={set("line")} placeholder="@netprime" /></Field>
          <Field label="เวลาทำการ"><input className="form-input" maxLength={80} value={form.hours || ""} onChange={set("hours")} /></Field>
          <Field label="ที่อยู่" span><textarea className="form-input" rows={2} maxLength={300} value={form.address || ""} onChange={set("address")} /></Field>
          <Field label="ลิงก์ Google Maps"><input className="form-input" maxLength={500} value={form.map_url || ""} onChange={set("map_url")} /></Field>
          <Field label="ลิงก์ Facebook"><input className="form-input" maxLength={500} value={form.facebook_url || ""} onChange={set("facebook_url")} /></Field>
        </div>
      </div>
      <div className="glass-card" style={{ padding: "24px" }}>
        <h3 style={{ fontSize: "16px", marginBottom: "14px" }}>การแจ้งเตือนเจ้าหน้าที่</h3>
        <Field label="อีเมลที่รับแจ้งเมื่อมีผู้ลงทะเบียนหรือติดต่อใหม่" hint="คั่นหลายอีเมลด้วย , (สูงสุด 10)">
          <input className="form-input" maxLength={1000} value={form.notify_emails || ""} onChange={set("notify_emails")} placeholder="sales@company.com, training@company.com" />
        </Field>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "12px" }}>
        {saved && <span style={{ color: "var(--accent)", fontSize: "14px" }}>บันทึกแล้ว · หน้าเว็บจะอัปเดตภายใน 1 นาที</span>}
        <button type="submit" className="tech-button-primary"><Save size={16} />บันทึกการตั้งค่า</button>
      </div>
    </form>
  );
};

// ==========================================
// Audit log
// ==========================================

const ACTION_LABEL: Record<string, string> = {
  create: "สร้าง", update: "แก้ไข", delete: "ลบ", duplicate: "ทำสำเนา", upload: "อัปโหลด", grant: "ให้สิทธิ์", revoke: "ถอนสิทธิ์",
  import: "นำเข้า", remove_member: "นำออกจากองค์กร", transfer: "ย้ายองค์กร", reset_password: "ตั้งรหัสผ่านใหม่",
  sign_out: "ออกจากระบบทุกอุปกรณ์", invite: "ส่งคำเชิญ", run: "สั่งงานประจำวัน", reset: "คืนค่าเริ่มต้น", restore: "กู้คืนฉบับเก่า",
  approve: "อนุมัติ", reject: "ปฏิเสธ"
};
const ENTITY_LABEL: Record<string, string> = {
  session: "รอบอบรม", registration: "ผู้สมัคร", inquiry: "ข้อความติดต่อ", article: "บทความ", promotion: "โปรโมชั่น", settings: "การตั้งค่า",
  image: "รูปภาพ", coordinator: "เจ้าหน้าที่ประสานงาน", organization: "องค์กร", user: "ผู้ใช้", role: "บทบาท",
  jobs: "(อีเมลเตือน/ล้างลิงก์หมดอายุ)", privacy_request: "คำขอลบข้อมูลส่วนบุคคล"
};

export const AuditPanel: React.FC = () => {
  const api = useApi();
  const [entries, setEntries] = useState<Array<{ id: string; user_name: string | null; action: string; entity: string; entity_id: string | null; detail: string | null; created_at: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ entries: typeof entries }>("/admin/site/audit?limit=200").then(d => setEntries(d.entries)).catch(err => setError(err.message));
  }, [api.token]);
  return (
    <div className="glass-card" style={{ padding: "8px", overflowX: "auto" }}>
      <ErrorBox message={error} />
      {entries.length === 0 ? <Empty text="ยังไม่มีประวัติการแก้ไข" /> : (
        <table style={tableStyle}>
          <thead><tr><th style={thStyle}>เวลา</th><th style={thStyle}>ผู้แก้ไข</th><th style={thStyle}>การกระทำ</th><th style={thStyle}>รายละเอียด</th></tr></thead>
          <tbody>
            {entries.map(e => (
              <tr key={e.id}>
                <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{formatDateTime(e.created_at)}</td>
                <td style={tdStyle}>{e.user_name || "-"}</td>
                <td style={tdStyle}>{ACTION_LABEL[e.action] || e.action} {ENTITY_LABEL[e.entity] || e.entity}</td>
                <td style={{ ...tdStyle, fontSize: "12px", color: "var(--text-muted)", maxWidth: "420px", wordBreak: "break-word" }}>{e.detail || e.entity_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
