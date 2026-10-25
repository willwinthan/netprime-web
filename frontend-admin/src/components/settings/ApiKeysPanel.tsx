import React, { useEffect, useState } from "react";
import { Plus, Ban, ExternalLink } from "lucide-react";
import { API_BASE_URL, useApi } from "../../hooks/useApi";
import { Chip, ErrorBox, Empty, Field, Modal, tableStyle, thStyle, tdStyle } from "../site-admin/ui";
import { Card, Notice, SecretOnce, Toggle, del, formatInstant } from "./shared";

interface ApiKey {
  id: string; name: string; prefix: string; scopes: string[]; rate_limit_per_minute: number; created_at?: string;
  last_used_at: string | null; revoked_at: string | null; expires_at: string | null; created_by_name?: string | null;
}
interface ScopeInfo { name: string; label: string }

/** School API keys for /api/v1: scopes, per-key rate limit, last used, revoke. The key is shown once. */
export const ApiKeysPanel: React.FC = () => {
  const api = useApi();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [scopes, setScopes] = useState<ScopeInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => api.get<{ keys: ApiKey[]; scopes: ScopeInfo[] }>("/admin/platform/api-keys")
    .then(d => { setKeys(d.keys); setScopes(d.scopes); }).catch(err => setError(err.message));
  useEffect(() => { load(); }, [api.token]);

  const revoke = async (key: ApiKey) => {
    if (!confirm(`เพิกถอน ${key.name}? ระบบที่ใช้ key นี้จะเรียก API ไม่ได้ทันที`)) return;
    try { setNotice((await del<{ message: string }>(api, `/admin/platform/api-keys/${key.id}`)).message); await load(); } catch (err: any) { setError(err.message); }
  };

  return (
    <div style={{ display: "grid", gap: "16px" }}>
      <ErrorBox message={error} />
      <Notice message={notice} />
      {secret && <SecretOnce label="API key ใหม่" value={secret} onDone={() => setSecret(null)} />}
      <Card title="API keys" description={<>ใช้เรียก REST API ที่ <code>{API_BASE_URL}/v1</code> ด้วย header <code>Authorization: Bearer npk_…</code> ระบบเก็บเฉพาะค่า hash ของ key</>}
        actions={<button className="tech-button-primary" onClick={() => setCreating(true)}><Plus size={16} />สร้าง API key</button>}>
        {keys.length === 0 ? <Empty text="ยังไม่มี API key" /> : (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead><tr><th style={thStyle}>ชื่อ</th><th style={thStyle}>สิทธิ์</th><th style={thStyle}>จำกัด/นาที</th><th style={thStyle}>ใช้ล่าสุด</th><th style={thStyle}></th></tr></thead>
              <tbody>
                {keys.map(k => (
                  <tr key={k.id} style={{ opacity: k.revoked_at ? 0.55 : 1 }}>
                    <td style={tdStyle}><strong>{k.name}</strong> {k.revoked_at && <Chip label="เพิกถอนแล้ว" color="var(--danger)" bg="rgba(239,68,68,0.1)" />}
                      <div style={{ fontSize: "12px", color: "var(--text-muted)" }}><code>{k.prefix}…</code>{k.created_by_name ? ` · โดย ${k.created_by_name}` : ""}{k.expires_at ? ` · หมดอายุ ${formatInstant(k.expires_at)}` : ""}</div></td>
                    <td style={{ ...tdStyle, fontSize: "12px" }}>{k.scopes.map(s => <code key={s} style={{ marginRight: 6 }}>{s}</code>)}</td>
                    <td style={tdStyle}>{k.rate_limit_per_minute.toLocaleString("th-TH")}</td>
                    <td style={tdStyle}>{formatInstant(k.last_used_at)}</td>
                    <td style={tdStyle}>{!k.revoked_at && <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px", color: "var(--danger)" }} onClick={() => revoke(k)}><Ban size={14} />เพิกถอน</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <CreateKey scopes={scopes} onClose={() => setCreating(false)} onCreated={s => { setCreating(false); setSecret(s); load(); }} />}
    </div>
  );
};

const CreateKey: React.FC<{ scopes: ScopeInfo[]; onClose: () => void; onCreated: (secret: string) => void }> = ({ scopes, onClose, onCreated }) => {
  const api = useApi();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [limit, setLimit] = useState(120);
  const [expires, setExpires] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setError(null);
      const res = await api.post<{ secret: string }>("/admin/platform/api-keys", {
        name, scopes: selected, rate_limit_per_minute: limit, expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : undefined
      });
      onCreated(res.secret);
    } catch (err: any) { setError(err.message); }
  };
  return (
    <Modal title="สร้าง API key" onClose={onClose}>
      <form onSubmit={submit} style={{ display: "grid", gap: "14px" }}>
        <ErrorBox message={error} />
        <Field label="ชื่อ *" hint="ระบุระบบที่ใช้ เช่น HRIS, Zapier"><input className="form-input" required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></Field>
        <fieldset style={{ border: "1px solid rgba(0,0,0,0.08)", borderRadius: "8px", padding: "12px 14px", display: "grid", gap: "8px" }}>
          <legend className="form-label" style={{ padding: "0 6px" }}>สิทธิ์ (scope) — ให้เท่าที่จำเป็น</legend>
          {scopes.map(s => <Toggle key={s.name} checked={selected.includes(s.name)} label={s.label} hint={s.name}
            onChange={on => setSelected(prev => on ? [...prev, s.name] : prev.filter(x => x !== s.name))} />)}
        </fieldset>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "14px" }}>
          <Field label="จำกัดการเรียกต่อนาที"><input className="form-input" type="number" min={1} max={10000} value={limit} onChange={e => setLimit(Number(e.target.value))} /></Field>
          <Field label="วันหมดอายุ" hint="เว้นว่าง = ไม่หมดอายุ"><input className="form-input" type="date" value={expires} onChange={e => setExpires(e.target.value)} /></Field>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={!selected.length}>สร้าง key</button>
        </div>
      </form>
    </Modal>
  );
};

const EXAMPLES: Array<[string, string, string]> = [
  ["GET", "/users?limit=50", "รายชื่อผู้ใช้ (users:read) · ใช้ next_cursor เพื่อดึงหน้าถัดไป ?cursor=…"],
  ["GET", "/users/{id}", "ข้อมูลผู้ใช้หนึ่งคน (users:read)"],
  ["POST", "/users", "สร้างผู้เรียนและส่งอีเมลเชิญ { email, name, tags?, send_invite? } (users:write)"],
  ["GET", "/courses", "คอร์สที่เผยแพร่แล้ว (courses:read)"],
  ["GET", "/enrollments?user_id=…&course_id=…", "การลงทะเบียนเรียน (enrollments:read)"],
  ["POST", "/enrollments", "ลงทะเบียนผู้เรียน { course_id, user_id | email, expires_at? } เรียกซ้ำได้ไม่ซ้ำซ้อน (enrollments:write)"],
  ["GET", "/orders?status=paid", "คำสั่งซื้อคอร์ส (orders:read)"]
];

/** Human-readable API reference with a link to the OpenAPI document. */
export const ApiDocsPanel: React.FC = () => (
  <div style={{ display: "grid", gap: "16px", maxWidth: "920px" }}>
    <Card title="เอกสาร REST API v1" description="ผลลัพธ์แบบรายการอยู่ในรูป { data: [...], next_cursor } · ข้อผิดพลาดอยู่ในรูป { error, code }"
      actions={<a className="tech-button-outline" href={`${API_BASE_URL}/v1/openapi.json`} target="_blank" rel="noreferrer"><ExternalLink size={16} />OpenAPI JSON</a>}>
      <table style={tableStyle}>
        <thead><tr><th style={thStyle}>Method</th><th style={thStyle}>Path</th><th style={thStyle}>คำอธิบาย</th></tr></thead>
        <tbody>{EXAMPLES.map(([m, p, d]) => <tr key={m + p}><td style={tdStyle}><code>{m}</code></td><td style={tdStyle}><code>{p}</code></td><td style={{ ...tdStyle, fontSize: "13px" }}>{d}</td></tr>)}</tbody>
      </table>
    </Card>
    <Card title="ตัวอย่างการเรียก">
      <pre style={{ fontSize: "12px", background: "rgba(15,23,42,0.04)", padding: "12px", borderRadius: "8px", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 }}>{`curl -H "Authorization: Bearer npk_xxx" "${API_BASE_URL}/v1/courses?limit=20"

curl -X POST -H "Authorization: Bearer npk_xxx" -H "Content-Type: application/json" \\
  -d '{"email":"learner@company.co.th","course_id":"course_cisco_ccna"}' \\
  "${API_BASE_URL}/v1/enrollments"`}</pre>
      <ul style={{ fontSize: "13px", color: "var(--text-secondary)", margin: "12px 0 0", paddingLeft: "18px" }}>
        <li>401 = ไม่มี key หรือ key ถูกเพิกถอน/หมดอายุ · 403 = key ไม่มี scope ที่ต้องใช้ (ดู required_scope) · 429 = เกินอัตราต่อนาที (Retry-After: 60)</li>
        <li>การลงทะเบียนซ้ำจะตอบ 200 พร้อม created: false และเปิดใช้การลงทะเบียนที่ถูกระงับอีกครั้ง</li>
        <li>ตรวจลายเซ็น webhook: คำนวณ HMAC-SHA256 ด้วย secret ของ "t.body ดิบ" แล้วเทียบกับค่า v1 และปฏิเสธ t ที่เก่ากว่า 5 นาที</li>
      </ul>
    </Card>
  </div>
);
