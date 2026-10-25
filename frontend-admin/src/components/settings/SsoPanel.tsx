import React, { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, PlugZap, Copy } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, ErrorBox, Empty, Field, Modal, grid2, tableStyle, thStyle, tdStyle } from "../site-admin/ui";
import { Card, Notice, Toggle, del, formatInstant } from "./shared";

interface SsoProvider {
  id: string; name: string; issuer: string; client_id: string; allowed_domains: string[]; default_role: "student" | "instructor";
  auto_create: boolean; jit_tags: string[]; partner_id: string | null; partner_name: string | null; enabled: boolean;
  last_login_at: string | null; linked_users: number;
}

const PRESETS: Array<[string, string]> = [
  ["Microsoft Entra ID", "https://login.microsoftonline.com/<tenant-id>/v2.0"],
  ["Google Workspace", "https://accounts.google.com"],
  ["Okta", "https://<your-org>.okta.com"]
];

/** Enterprise SSO (OpenID Connect) connections, optionally one per partner organization. */
export const SsoPanel: React.FC = () => {
  const api = useApi();
  const [providers, setProviders] = useState<SsoProvider[]>([]);
  const [partners, setPartners] = useState<Array<{ id: string; company_name: string }>>([]);
  const [redirectUri, setRedirectUri] = useState("");
  const [editing, setEditing] = useState<Partial<SsoProvider> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => api.get<{ providers: SsoProvider[]; partners: Array<{ id: string; company_name: string }>; redirect_uri: string }>("/admin/platform/sso")
    .then(d => { setProviders(d.providers); setPartners(d.partners); setRedirectUri(d.redirect_uri); }).catch(err => setError(err.message));
  useEffect(() => { load(); }, [api.token]);

  const test = async (p: SsoProvider) => {
    try {
      setError(null);
      const res = await api.post<{ ok: boolean; issuer: string }>(`/admin/platform/sso/${p.id}/test`, {});
      setNotice(`เชื่อมต่อ ${p.name} สำเร็จ (issuer ${res.issuer})`);
    } catch (err: any) { setError(err.message); }
  };
  const remove = async (p: SsoProvider) => {
    if (!confirm(`ลบการเชื่อมต่อ ${p.name}? ผู้ใช้ยังเข้าสู่ระบบด้วยรหัสผ่านได้`)) return;
    try { await del(api, `/admin/platform/sso/${p.id}`); await load(); } catch (err: any) { setError(err.message); }
  };

  return (
    <div style={{ display: "grid", gap: "16px" }}>
      <ErrorBox message={error} />
      <Notice message={notice} />
      <Card title="SSO องค์กร (OpenID Connect)" description="ให้พนักงานเข้าสู่ระบบด้วยบัญชีองค์กร รองรับ Microsoft Entra ID (Azure AD), Google Workspace และ Okta ผู้ใช้กดปุ่ม “เข้าสู่ระบบด้วย SSO องค์กร” แล้วกรอกอีเมลงาน"
        actions={<button className="tech-button-primary" onClick={() => setEditing({ default_role: "student", auto_create: true, enabled: true, allowed_domains: [], jit_tags: [] })}><Plus size={16} />เพิ่มการเชื่อมต่อ</button>}>
        <div style={{ fontSize: "13px", marginBottom: "14px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <span className="form-label">Redirect URI สำหรับลงทะเบียนแอปที่ IdP:</span>
          <code style={{ wordBreak: "break-all" }}>{redirectUri}</code>
          <button type="button" className="tech-button-outline" style={{ padding: "2px 8px", fontSize: "12px" }} onClick={() => navigator.clipboard?.writeText(redirectUri)}><Copy size={12} />คัดลอก</button>
        </div>
        {providers.length === 0 ? <Empty text="ยังไม่มีการเชื่อมต่อ SSO" /> : (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead><tr><th style={thStyle}>การเชื่อมต่อ</th><th style={thStyle}>โดเมน</th><th style={thStyle}>ผู้ใช้ใหม่</th><th style={thStyle}>ใช้ล่าสุด</th><th style={thStyle}></th></tr></thead>
              <tbody>
                {providers.map(p => (
                  <tr key={p.id}>
                    <td style={tdStyle}><strong>{p.name}</strong> {!p.enabled && <Chip label="ปิดอยู่" color="var(--text-secondary)" bg="rgba(100,116,139,0.12)" />}
                      <div style={{ fontSize: "12px", color: "var(--text-muted)", wordBreak: "break-all" }}>{p.issuer}</div>
                      {p.partner_name && <div style={{ fontSize: "12px" }}>องค์กร: {p.partner_name}</div>}</td>
                    <td style={{ ...tdStyle, fontSize: "13px" }}>{p.allowed_domains.join(", ")}</td>
                    <td style={{ ...tdStyle, fontSize: "13px" }}>{p.auto_create ? `สร้างอัตโนมัติ (${p.default_role === "instructor" ? "ผู้สอน" : "ผู้เรียน"})` : "เฉพาะบัญชีที่มีอยู่"}
                      {p.jit_tags.length > 0 && <div style={{ color: "var(--text-muted)" }}>แท็ก: {p.jit_tags.join(", ")}</div>}</td>
                    <td style={{ ...tdStyle, fontSize: "13px" }}>{formatInstant(p.last_login_at)}<div style={{ color: "var(--text-muted)" }}>เชื่อมแล้ว {p.linked_users} คน</div></td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={() => test(p)}><PlugZap size={14} />ทดสอบ</button>
                        <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={() => setEditing(p)} aria-label="แก้ไข"><Pencil size={14} /></button>
                        <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px", color: "var(--danger)" }} onClick={() => remove(p)} aria-label="ลบ"><Trash2 size={14} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "14px 0 0" }}>
          บัญชีเดิมจะถูกเชื่อมด้วยอีเมลเฉพาะเมื่อโดเมนตรงกับโดเมนที่อนุญาต · SAML ยังไม่รองรับ (IdP หลักทั้งหมดรองรับ OIDC อยู่แล้ว)
        </p>
      </Card>
      {editing && <SsoForm initial={editing} partners={partners} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
};

const SsoForm: React.FC<{ initial: Partial<SsoProvider>; partners: Array<{ id: string; company_name: string }>; onClose: () => void; onSaved: () => void }> = ({ initial, partners, onClose, onSaved }) => {
  const api = useApi();
  const [form, setForm] = useState({
    name: initial.name || "", issuer: initial.issuer || "", client_id: initial.client_id || "", client_secret: "",
    allowed_domains: (initial.allowed_domains || []).join(", "), jit_tags: (initial.jit_tags || []).join(", "),
    default_role: initial.default_role || "student", auto_create: initial.auto_create ?? true, enabled: initial.enabled ?? true, partner_id: initial.partner_id || ""
  });
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm(prev => ({ ...prev, [key]: e.target.value }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setError(null);
      const body: Record<string, unknown> = { ...form, partner_id: form.partner_id || null, jit_tags: form.jit_tags.split(",").map(t => t.trim()).filter(Boolean) };
      if (initial.id && !form.client_secret) delete body.client_secret;
      if (initial.id) await api.patch(`/admin/platform/sso/${initial.id}`, body);
      else await api.post("/admin/platform/sso", body);
      onSaved();
    } catch (err: any) { setError(err.message); }
  };
  return (
    <Modal title={initial.id ? "แก้ไขการเชื่อมต่อ SSO" : "เพิ่มการเชื่อมต่อ SSO"} onClose={onClose} width={720}>
      <form onSubmit={submit} style={grid2}>
        <div style={{ gridColumn: "1 / -1" }}><ErrorBox message={error} /></div>
        <Field label="ชื่อ *"><input className="form-input" required maxLength={80} value={form.name} onChange={set("name")} placeholder="Microsoft Entra – บริษัท ABC" /></Field>
        <Field label="องค์กรพาร์ตเนอร์" hint="ผู้ใช้ใหม่จะสังกัดองค์กรนี้">
          <select className="form-input" value={form.partner_id} onChange={set("partner_id")}>
            <option value="">— ทั้งโรงเรียน —</option>
            {partners.map(p => <option key={p.id} value={p.id}>{p.company_name}</option>)}
          </select>
        </Field>
        <Field label="Issuer URL *" span hint={<>ตัวอย่าง: {PRESETS.map(([n, u]) => <span key={n} style={{ display: "block" }}>{n}: <code>{u}</code></span>)}</> as any}>
          <input className="form-input" required type="url" maxLength={300} value={form.issuer} onChange={set("issuer")} />
        </Field>
        <Field label="Client ID *"><input className="form-input" required maxLength={200} value={form.client_id} onChange={set("client_id")} /></Field>
        <Field label={initial.id ? "Client secret (เว้นว่าง = ใช้ค่าเดิม)" : "Client secret *"}>
          <input className="form-input" type="password" autoComplete="new-password" required={!initial.id} maxLength={500} value={form.client_secret} onChange={set("client_secret")} />
        </Field>
        <Field label="โดเมนอีเมลที่อนุญาต *" hint="คั่นด้วยจุลภาค เช่น abc.co.th" span><input className="form-input" required value={form.allowed_domains} onChange={set("allowed_domains")} /></Field>
        <Field label="บทบาทของผู้ใช้ใหม่">
          <select className="form-input" value={form.default_role} onChange={set("default_role")}>
            <option value="student">ผู้เรียน</option>
            <option value="instructor">ผู้สอน</option>
          </select>
        </Field>
        <Field label="แท็กสำหรับผู้ใช้ใหม่ (JIT)" hint="คั่นด้วยจุลภาค ใช้แบ่งกลุ่มรายงาน/ประกาศ"><input className="form-input" value={form.jit_tags} onChange={set("jit_tags")} /></Field>
        <div style={{ gridColumn: "1 / -1", display: "grid", gap: "8px" }}>
          <Toggle checked={form.auto_create} onChange={v => setForm(prev => ({ ...prev, auto_create: v }))} label="สร้างบัญชีให้อัตโนมัติเมื่อเข้าสู่ระบบครั้งแรก" />
          <Toggle checked={form.enabled} onChange={v => setForm(prev => ({ ...prev, enabled: v }))} label="เปิดใช้งาน" />
        </div>
        <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary">บันทึก</button>
        </div>
      </form>
    </Modal>
  );
};
