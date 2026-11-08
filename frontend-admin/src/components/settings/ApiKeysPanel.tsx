import React, { useEffect, useState } from "react";
import { Plus, Ban, ExternalLink, Bot, Pause, Play, Pencil } from "lucide-react";
import { API_BASE_URL, useApi } from "../../hooks/useApi";
import { Chip, ErrorBox, Empty, Field, Modal, tableStyle, thStyle, tdStyle } from "../site-admin/ui";
import { Card, Notice, SecretOnce, Toggle, formatInstant } from "./shared";
import { useDangerousDelete } from "../security/DangerConfirmDialog";

interface ApiKey {
  id: string; name: string; prefix: string; scopes: string[]; rate_limit_per_minute: number; created_at?: string;
  last_used_at: string | null; revoked_at: string | null; expires_at: string | null; created_by_name?: string | null;
  kind: "integration" | "agent"; description: string | null; daily_limit: number | null; allowed_hours: string | null;
  allowed_days: string | null; allowed_ips: string | null; paused_at: string | null; mcp_access?: "off" | "read" | "write";
}
interface ScopeInfo { name: string; label: string }

const DAY_LABELS = ["จ", "อ", "พ", "พฤ", "ศ", "ส", "อา"];
const daysText = (days: string | null) => days ? days.split(",").map(d => DAY_LABELS[Number(d) - 1]).join(" ") : "ทุกวัน";
const MCP_LABEL: Record<string, string> = { off: "ปิด MCP", read: "MCP: อ่านอย่างเดียว", write: "MCP: อ่าน + ส่งงาน" };
const smallButton: React.CSSProperties = { padding: "4px 10px", fontSize: "12px" };

/**
 * School API keys for /api/v1: scopes, per-key rate limit, last used, revoke. The key is shown once.
 * Agent keys (for external AI agents) also have a daily quota, a time window (Thai time), an IP
 * allowlist and a pause switch; their write requests go to the approval queue (AgentQueuePage).
 */
export const ApiKeysPanel: React.FC = () => {
  const api = useApi();
  const { confirmDelete, dangerDialog } = useDangerousDelete();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [scopes, setScopes] = useState<ScopeInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [editing, setEditing] = useState<ApiKey | "new-integration" | "new-agent" | null>(null);

  const load = () => api.get<{ keys: ApiKey[]; scopes: ScopeInfo[] }>("/admin/platform/api-keys")
    .then(d => { setKeys(d.keys); setScopes(d.scopes); }).catch(err => setError(err.message));
  useEffect(() => { load(); }, [api.token]);

  const revoke = async (key: ApiKey) => {
    try {
      const done = await confirmDelete<{ message: string }>({ action: "api_key.revoke", targetId: key.id, path: `/admin/platform/api-keys/${key.id}`,
        confirmMessage: `เพิกถอน ${key.name}? ระบบที่ใช้ key นี้จะเรียก API ไม่ได้ทันที` });
      if (!done) return;
      setNotice(done.message);
      await load();
    } catch (err: any) { setError(err.message); }
  };

  const togglePause = async (key: ApiKey) => {
    try {
      setError(null);
      const res = await api.post<{ message: string }>(`/admin/agents/keys/${key.id}/${key.paused_at ? "resume" : "pause"}`, {});
      setNotice(res.message);
      await load();
    } catch (err: any) { setError(err.message); }
  };

  return (
    <div style={{ display: "grid", gap: "16px" }}>
      {dangerDialog}
      <ErrorBox message={error} />
      <Notice message={notice} />
      {secret && <SecretOnce label="API key ใหม่" value={secret} onDone={() => setSecret(null)} />}
      <Card title="API keys" description={<>ใช้เรียก REST API ที่ <code>{API_BASE_URL}/v1</code> ด้วย header <code>Authorization: Bearer npk_…</code> ระบบเก็บเฉพาะค่า hash ของ key · <strong>agent key</strong> สำหรับ AI agent ภายนอก: งานที่ส่งอีเมล ยืนยันเงิน หรือเผยแพร่ ต้องรอคนอนุมัติในหน้า "คิวอนุมัติ AI agent" · ต่อผ่าน MCP ได้ที่ <code>{API_BASE_URL.replace(/\/api$/, "")}/mcp</code></>}
        actions={<div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button className="tech-button-outline" onClick={() => setEditing("new-agent")}><Bot size={16} />สร้าง agent key</button>
          <button className="tech-button-primary" onClick={() => setEditing("new-integration")}><Plus size={16} />สร้าง API key</button>
        </div>}>
        {keys.length === 0 ? <Empty text="ยังไม่มี API key" /> : (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead><tr><th style={thStyle}>ชื่อ</th><th style={thStyle}>สิทธิ์</th><th style={thStyle}>จำกัด</th><th style={thStyle}>ใช้ล่าสุด</th><th style={thStyle}></th></tr></thead>
              <tbody>
                {keys.map(k => (
                  <tr key={k.id} style={{ opacity: k.revoked_at ? 0.55 : 1 }}>
                    <td style={tdStyle}><strong>{k.name}</strong>{" "}
                      {k.kind === "agent" && <Chip label="AI agent" color="#7c3aed" bg="rgba(124,58,237,0.1)" />}{" "}
                      {k.revoked_at ? <Chip label="เพิกถอนแล้ว" color="var(--danger)" bg="rgba(239,68,68,0.1)" />
                        : k.paused_at ? <Chip label="หยุดชั่วคราว" color="#b45309" bg="rgba(245,158,11,0.12)" /> : null}
                      {k.description && <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{k.description}</div>}
                      <div style={{ fontSize: "12px", color: "var(--text-muted)" }}><code>{k.prefix}…</code>{k.created_by_name ? ` · โดย ${k.created_by_name}` : ""}{k.expires_at ? ` · หมดอายุ ${formatInstant(k.expires_at)}` : ""}</div></td>
                    <td style={{ ...tdStyle, fontSize: "12px" }}>{k.scopes.map(s => <code key={s} style={{ marginRight: 6, display: "inline-block" }}>{s}</code>)}</td>
                    <td style={{ ...tdStyle, fontSize: "12px", whiteSpace: "nowrap" }}>
                      {k.rate_limit_per_minute.toLocaleString("th-TH")}/นาที
                      {k.kind === "agent" && <>
                        <div>{k.daily_limit ? `${k.daily_limit.toLocaleString("th-TH")}/วัน` : "ไม่จำกัดต่อวัน"}</div>
                        <div>{daysText(k.allowed_days)} {k.allowed_hours ?? "ทุกเวลา"}</div>
                        {k.allowed_ips && <div title={k.allowed_ips}>จำกัด IP {k.allowed_ips.split(",").length} รายการ</div>}
                        <div>{MCP_LABEL[k.mcp_access ?? "read"]}</div>
                      </>}
                    </td>
                    <td style={tdStyle}>{formatInstant(k.last_used_at)}</td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{!k.revoked_at && <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
                      {k.kind === "agent" && <button className="tech-button-outline" style={smallButton} onClick={() => togglePause(k)}>
                        {k.paused_at ? <><Play size={14} />เปิดใช้</> : <><Pause size={14} />หยุด</>}</button>}
                      <button className="tech-button-outline" style={smallButton} onClick={() => setEditing(k)}><Pencil size={14} />แก้ไข</button>
                      <button className="tech-button-outline" style={{ ...smallButton, color: "var(--danger)" }} onClick={() => revoke(k)}><Ban size={14} />เพิกถอน</button>
                    </div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <KeyForm scopes={scopes} existing={typeof editing === "string" ? null : editing}
        kind={typeof editing === "string" ? (editing === "new-agent" ? "agent" : "integration") : editing.kind}
        onClose={() => setEditing(null)}
        onSaved={s => { setEditing(null); if (s) setSecret(s); else setNotice("บันทึกการตั้งค่า key แล้ว"); load(); }} />}
    </div>
  );
};

/** Agent keys start with read-only reporting scopes; write scopes are opt-in. */
const AGENT_DEFAULT_SCOPES = ["sessions:read", "registrations:read", "inquiries:read", "leads:read", "reports:read", "events:read"];

const KeyForm: React.FC<{ scopes: ScopeInfo[]; existing: ApiKey | null; kind: ApiKey["kind"]; onClose: () => void; onSaved: (secret: string | null) => void }> = ({ scopes, existing, kind, onClose, onSaved }) => {
  const api = useApi();
  const agent = kind === "agent";
  const [hoursFrom, hoursTo] = (existing?.allowed_hours ?? "").split("-");
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [selected, setSelected] = useState<string[]>(existing?.scopes ?? (agent ? AGENT_DEFAULT_SCOPES : []));
  const [limit, setLimit] = useState(existing?.rate_limit_per_minute ?? (agent ? 60 : 120));
  const [daily, setDaily] = useState(existing?.daily_limit ? String(existing.daily_limit) : agent && !existing ? "2000" : "");
  const [from, setFrom] = useState(hoursFrom || "");
  const [to, setTo] = useState(hoursTo || "");
  const [days, setDays] = useState<number[]>(existing?.allowed_days ? existing.allowed_days.split(",").map(Number) : [1, 2, 3, 4, 5, 6, 7]);
  const [ips, setIps] = useState(existing?.allowed_ips ?? "");
  const [mcp, setMcp] = useState<string>(existing?.mcp_access ?? "read");
  const [expires, setExpires] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((from && !to) || (!from && to)) { setError("กรุณาระบุทั้งเวลาเริ่มและเวลาสิ้นสุด หรือเว้นว่างทั้งคู่"); return; }
    try {
      setError(null);
      const body: Record<string, unknown> = { name, scopes: selected, rate_limit_per_minute: limit };
      if (agent) Object.assign(body, {
        description, daily_limit: daily ? Number(daily) : null, allowed_hours: from && to ? `${from}-${to}` : null,
        allowed_days: days.length === 7 ? null : days, allowed_ips: ips.trim() || null, mcp_access: mcp
      });
      if (existing) {
        await api.patch(`/admin/platform/api-keys/${existing.id}`, body);
        onSaved(null);
      } else {
        const res = await api.post<{ secret: string }>("/admin/platform/api-keys", {
          ...body, kind, expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : undefined
        });
        onSaved(res.secret);
      }
    } catch (err: any) { setError(err.message); }
  };
  const title = existing ? `แก้ไข ${existing.name}` : agent ? "สร้าง agent key" : "สร้าง API key";
  return (
    <Modal title={title} onClose={onClose} width={720}>
      <form onSubmit={submit} style={{ display: "grid", gap: "14px" }}>
        <ErrorBox message={error} />
        {agent && !existing && <Notice tone="warn" message="agent key อ่านข้อมูลได้ตาม scope แต่จะแก้ข้อมูลโดยตรงไม่ได้ งานระดับ 'ร่าง' (บันทึกภายใน) ทำได้ทันที ส่วนงานระดับ 'ลงมือ' (ส่งอีเมล/LINE ยืนยันเงิน เผยแพร่ ให้สิทธิ์เรียน) ต้องมีคนกดอนุมัติ" />}
        <Field label="ชื่อ *" hint={agent ? "ระบุ agent ที่ใช้ เช่น Claude, Hermes (DGX Spark)" : "ระบุระบบที่ใช้ เช่น HRIS, Zapier"}><input className="form-input" required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></Field>
        {agent && <Field label="คำอธิบาย" hint="agent นี้ทำงานอะไร ใครดูแล"><input className="form-input" maxLength={500} value={description} onChange={e => setDescription(e.target.value)} /></Field>}
        <fieldset style={{ border: "1px solid rgba(0,0,0,0.08)", borderRadius: "8px", padding: "12px 14px", display: "grid", gap: "8px" }}>
          <legend className="form-label" style={{ padding: "0 6px" }}>สิทธิ์ (scope) — ให้เท่าที่จำเป็น</legend>
          {scopes.map(s => <Toggle key={s.name} checked={selected.includes(s.name)} label={s.label} hint={s.name}
            onChange={on => setSelected(prev => on ? [...prev, s.name] : prev.filter(x => x !== s.name))} />)}
        </fieldset>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "14px" }}>
          <Field label="จำกัดการเรียกต่อนาที"><input className="form-input" type="number" min={1} max={10000} value={limit} onChange={e => setLimit(Number(e.target.value))} /></Field>
          {agent && <Field label="โควตาต่อวัน" hint="นับตามวันเวลาไทย เว้นว่าง = ไม่จำกัด"><input className="form-input" type="number" min={1} max={1000000} value={daily} onChange={e => setDaily(e.target.value)} /></Field>}
          {!existing && <Field label="วันหมดอายุ" hint="เว้นว่าง = ไม่หมดอายุ"><input className="form-input" type="date" value={expires} onChange={e => setExpires(e.target.value)} /></Field>}
        </div>
        {agent && <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "14px" }}>
            <Field label="ทำงานได้ตั้งแต่ (เวลาไทย)" hint="เว้นว่าง = ทุกเวลา"><input className="form-input" type="time" value={from} onChange={e => setFrom(e.target.value)} /></Field>
            <Field label="ถึง" hint="ถ้าน้อยกว่าเวลาเริ่ม = ข้ามเที่ยงคืน"><input className="form-input" type="time" value={to} onChange={e => setTo(e.target.value)} /></Field>
          </div>
          <Field label="วันที่ทำงานได้">
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              {DAY_LABELS.map((label, i) => {
                const on = days.includes(i + 1);
                return <button key={label} type="button" className={on ? "tech-button-primary" : "tech-button-outline"} style={{ ...smallButton, minWidth: 40 }}
                  onClick={() => setDays(prev => on ? prev.filter(d => d !== i + 1) : [...prev, i + 1])}>{label}</button>;
              })}
            </div>
          </Field>
          <Field label="การใช้ผ่าน MCP" hint="MCP client เช่น Claude เพิ่ม server ด้วย URL /mcp แล้ววาง key นี้ในหน้าอนุญาต หรือส่ง key เป็น Bearer token">
            <select className="form-input" value={mcp} onChange={e => setMcp(e.target.value)}>
              <option value="read">อ่านอย่างเดียว (แนะนำเริ่มต้น)</option>
              <option value="write">อ่าน + ส่งงานร่าง/ลงมือ (งานลงมือยังต้องอนุมัติ)</option>
              <option value="off">ปิด ใช้ REST API เท่านั้น</option>
            </select>
          </Field>
          <Field label="IP ที่อนุญาต" hint="เช่น IP ภายนอกของออฟฟิศที่ DGX Spark ใช้ออกอินเทอร์เน็ต หรือ CIDR 203.0.113.0/24 คั่นด้วยจุลภาค เว้นว่าง = ทุกที่">
            <input className="form-input" value={ips} onChange={e => setIps(e.target.value)} placeholder="203.0.113.10, 198.51.100.0/24" />
          </Field>
        </>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={!selected.length || (agent && days.length === 0)}>{existing ? "บันทึก" : "สร้าง key"}</button>
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
  ["GET", "/orders?status=paid", "คำสั่งซื้อคอร์ส (orders:read)"],
  ["GET", "/me · /tools", "ข้อมูลของ key และรายการเครื่องมือ (อ่าน / ร่าง / ลงมือ) พร้อม input_schema"],
  ["GET", "/training-sessions?status=open&from=YYYY-MM-DD", "รอบอบรมพร้อมที่นั่งคงเหลือ (sessions:read)"],
  ["GET", "/registrations?session_id=…&since=ISO", "ผู้สมัครรอบอบรม (registrations:read)"],
  ["GET", "/leads · /inquiries?status=new", "lead และข้อความติดต่อ (leads:read, inquiries:read)"],
  ["GET", "/reports/summary?from=…&to=…", "ตัวเลขสรุปช่วงวันที่ (reports:read)"],
  ["GET", "/ops/daily-summary", "สรุปงานประจำวันของเจ้าหน้าที่ประสานงาน (reports:read)"],
  ["POST", "/actions", "ส่งงาน { tool, input, dry_run?, idempotency_key?, reason? } งานลงมือได้ 202 และรอคนอนุมัติ"],
  ["GET", "/actions/{id}", "สถานะงาน pending / executed / failed / rejected / cancelled / expired"],
  ["GET", "/events?since=…", "ฟีดเหตุการณ์แบบดึงเอง เก็บ next_since ไว้ใช้ครั้งถัดไป (events:read)"]
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
