import React, { useEffect, useState } from "react";
import { Plus, Send, RefreshCw, Trash2, KeyRound, ArrowLeft, Pencil } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, ErrorBox, Empty, Field, Modal, tableStyle, thStyle, tdStyle } from "../site-admin/ui";
import { Card, Notice, SecretOnce, STATUS_TONE, Toggle, del, formatInstant } from "./shared";

interface Endpoint {
  id: string; name: string; url: string; events: string[]; active: boolean; created_at: string;
  last_status: string | null; last_delivery_at: string | null; failed_count: number; pending_count: number;
}
interface Delivery {
  id: string; event: string; payload: string; status: string; attempts: number; response_code: number | null; duration_ms: number | null;
  error: string | null; response_excerpt: string | null; next_attempt_at: string | null; created_at: string; last_attempt_at: string | null;
}
interface EventInfo { name: string; label: string }

/** Outgoing webhooks: endpoints, event subscriptions, signed test ping, delivery log and redeliver. */
export const WebhooksPanel: React.FC = () => {
  const api = useApi();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [events, setEvents] = useState<EventInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<Endpoint> | null>(null);
  const [selected, setSelected] = useState<Endpoint | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      setError(null);
      const data = await api.get<{ endpoints: Endpoint[]; events: EventInfo[] }>("/admin/platform/webhooks");
      setEndpoints(data.endpoints);
      setEvents(data.events);
    } catch (err: any) { setError(err.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [api.token]);

  const test = async (endpoint: Endpoint) => {
    try {
      setError(null);
      const res = await api.post<{ delivery: Delivery }>(`/admin/platform/webhooks/${endpoint.id}/test`, {});
      const d = res.delivery;
      setNotice(d.status === "success" ? `ส่ง ping สำเร็จ (HTTP ${d.response_code}, ${d.duration_ms} ms)` : `ส่ง ping ไม่สำเร็จ: ${d.error || "ไม่ทราบสาเหตุ"}`);
      await load();
    } catch (err: any) { setError(err.message); }
  };
  const rotate = async (endpoint: Endpoint) => {
    if (!confirm(`สร้าง secret ใหม่ให้ ${endpoint.name}? ระบบปลายทางต้องอัปเดต secret ก่อนรับข้อมูลครั้งถัดไป`)) return;
    try { setSecret((await api.post<{ secret: string }>(`/admin/platform/webhooks/${endpoint.id}/rotate-secret`, {})).secret); } catch (err: any) { setError(err.message); }
  };
  const remove = async (endpoint: Endpoint) => {
    if (!confirm(`ลบปลายทาง ${endpoint.name} และประวัติการส่งทั้งหมด?`)) return;
    try { await del(api, `/admin/platform/webhooks/${endpoint.id}`); await load(); } catch (err: any) { setError(err.message); }
  };

  if (selected) return <DeliveryLog endpoint={selected} onBack={() => { setSelected(null); load(); }} />;

  const label = (name: string) => name === "*" ? "ทุกเหตุการณ์" : events.find(e => e.name === name)?.label || name;

  return (
    <div style={{ display: "grid", gap: "16px" }}>
      <ErrorBox message={error} />
      <Notice message={notice} />
      {secret && <SecretOnce label="Signing secret ของ webhook" value={secret} onDone={() => setSecret(null)} />}
      <Card title="Webhook ขาออก" description={<>ส่งข้อมูลเหตุการณ์ไปยัง Zapier, Make หรือระบบของคุณแบบ JSON ทุกคำขอมีลายเซ็น <code>X-NetPrime-Signature: t=…,v1=…</code> (HMAC-SHA256 ของ "t.body") ส่งไม่สำเร็จจะลองใหม่อัตโนมัติ 5 ครั้ง</>}
        actions={<button className="tech-button-primary" onClick={() => setEditing({ name: "", url: "", events: ["*"], active: true })}><Plus size={16} />เพิ่มปลายทาง</button>}>
        {loading ? <Empty text="กำลังโหลด…" /> : endpoints.length === 0 ? <Empty text="ยังไม่มีปลายทาง webhook" /> : (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead><tr><th style={thStyle}>ปลายทาง</th><th style={thStyle}>เหตุการณ์</th><th style={thStyle}>ล่าสุด</th><th style={thStyle}></th></tr></thead>
              <tbody>
                {endpoints.map(e => (
                  <tr key={e.id}>
                    <td style={tdStyle}>
                      <strong>{e.name}</strong> {!e.active && <Chip label="ปิดอยู่" color="var(--text-secondary)" bg="rgba(100,116,139,0.12)" />}
                      <div style={{ fontSize: "12px", color: "var(--text-muted)", wordBreak: "break-all" }}>{e.url}</div>
                    </td>
                    <td style={{ ...tdStyle, fontSize: "13px" }}>{e.events.map(label).join(", ")}</td>
                    <td style={tdStyle}>
                      {e.last_status ? <Chip {...(STATUS_TONE[e.last_status] || STATUS_TONE.pending)} /> : <span style={{ color: "var(--text-muted)" }}>-</span>}
                      <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{formatInstant(e.last_delivery_at)}</div>
                      {e.failed_count > 0 && <div style={{ fontSize: "12px", color: "var(--danger)" }}>ล้มเหลว {e.failed_count}</div>}
                      {e.pending_count > 0 && <div style={{ fontSize: "12px", color: "var(--warning)" }}>รอส่งซ้ำ {e.pending_count}</div>}
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={() => test(e)}><Send size={14} />ทดสอบ</button>
                        <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={() => setSelected(e)}>ประวัติการส่ง</button>
                        <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={() => setEditing(e)} aria-label="แก้ไข"><Pencil size={14} /></button>
                        <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={() => rotate(e)} title="สร้าง secret ใหม่"><KeyRound size={14} /></button>
                        <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px", color: "var(--danger)" }} onClick={() => remove(e)} aria-label="ลบ"><Trash2 size={14} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <EndpointForm initial={editing} events={events} onClose={() => setEditing(null)}
        onSaved={(newSecret) => { setEditing(null); if (newSecret) setSecret(newSecret); load(); }} />}
    </div>
  );
};

const EndpointForm: React.FC<{ initial: Partial<Endpoint>; events: EventInfo[]; onClose: () => void; onSaved: (secret?: string) => void }> = ({ initial, events, onClose, onSaved }) => {
  const api = useApi();
  const [name, setName] = useState(initial.name || "");
  const [url, setUrl] = useState(initial.url || "");
  const [selected, setSelected] = useState<string[]>(initial.events || ["*"]);
  const [active, setActive] = useState(initial.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const all = selected.includes("*");
  const toggle = (event: string, on: boolean) => setSelected(prev => on ? [...prev.filter(e => e !== "*"), event] : prev.filter(e => e !== event));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSaving(true);
      setError(null);
      const body = { name, url, events: selected, active };
      if (initial.id) { await api.patch(`/admin/platform/webhooks/${initial.id}`, body); onSaved(); }
      else onSaved((await api.post<{ secret: string }>("/admin/platform/webhooks", body)).secret);
    } catch (err: any) { setError(err.message); } finally { setSaving(false); }
  };

  return (
    <Modal title={initial.id ? "แก้ไขปลายทาง webhook" : "เพิ่มปลายทาง webhook"} onClose={onClose}>
      <form onSubmit={submit} style={{ display: "grid", gap: "14px" }}>
        <ErrorBox message={error} />
        <Field label="ชื่อ *"><input className="form-input" required maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="Zapier – ผู้เรียนใหม่" /></Field>
        <Field label="URL ปลายทาง *" hint="ต้องเป็น https:// และเป็นโดเมนสาธารณะ (ไม่รับ IP ภายในหรือ localhost)">
          <input className="form-input" required type="url" maxLength={500} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://hooks.zapier.com/hooks/catch/…" />
        </Field>
        <fieldset style={{ border: "1px solid rgba(0,0,0,0.08)", borderRadius: "8px", padding: "12px 14px", display: "grid", gap: "8px" }}>
          <legend className="form-label" style={{ padding: "0 6px" }}>เหตุการณ์ที่ต้องการรับ</legend>
          <Toggle checked={all} onChange={v => setSelected(v ? ["*"] : [])} label="ทุกเหตุการณ์ (รวมเหตุการณ์ที่เพิ่มในอนาคต)" />
          {!all && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "6px" }}>
            {events.map(ev => <Toggle key={ev.name} checked={selected.includes(ev.name)} onChange={v => toggle(ev.name, v)} label={ev.label} hint={ev.name} />)}
          </div>}
        </fieldset>
        <Toggle checked={active} onChange={setActive} label="เปิดใช้งาน" />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={saving || !selected.length}>{saving ? "กำลังบันทึก…" : "บันทึก"}</button>
        </div>
      </form>
    </Modal>
  );
};

const DeliveryLog: React.FC<{ endpoint: Endpoint; onBack: () => void }> = ({ endpoint, onBack }) => {
  const api = useApi();
  const [rows, setRows] = useState<Delivery[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.get<{ deliveries: Delivery[] }>(`/admin/platform/webhooks/${endpoint.id}/deliveries?limit=100`)
    .then(d => setRows(d.deliveries)).catch(err => setError(err.message));
  useEffect(() => { load(); }, [endpoint.id, api.token]);
  const redeliver = async (d: Delivery) => {
    try { setError(null); await api.post(`/admin/platform/webhook-deliveries/${d.id}/redeliver`, {}); await load(); } catch (err: any) { setError(err.message); }
  };
  const pretty = (json: string) => { try { return JSON.stringify(JSON.parse(json), null, 2); } catch { return json; } };

  return (
    <div>
      <button className="tech-button-outline" onClick={onBack} style={{ padding: "6px 14px", fontSize: "13px", marginBottom: "16px" }}><ArrowLeft size={14} />กลับ</button>
      <ErrorBox message={error} />
      <Card title={`ประวัติการส่ง: ${endpoint.name}`} description="เก็บไว้ 30 วัน · คลิกแถวเพื่อดู payload"
        actions={<button className="tech-button-outline" onClick={load}><RefreshCw size={16} />รีเฟรช</button>}>
        {rows.length === 0 ? <Empty text="ยังไม่มีการส่ง" /> : (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead><tr><th style={thStyle}>เวลา</th><th style={thStyle}>เหตุการณ์</th><th style={thStyle}>สถานะ</th><th style={thStyle}>HTTP</th><th style={thStyle}>เวลาตอบ</th><th style={thStyle}>ครั้งที่</th><th style={thStyle}></th></tr></thead>
              <tbody>
                {rows.map(d => (
                  <React.Fragment key={d.id}>
                    <tr onClick={() => setOpen(open === d.id ? null : d.id)} style={{ cursor: "pointer" }}>
                      <td style={tdStyle}>{formatInstant(d.created_at)}</td>
                      <td style={tdStyle}><code>{d.event}</code></td>
                      <td style={tdStyle}><Chip {...(STATUS_TONE[d.status] || STATUS_TONE.pending)} />
                        {d.status === "pending" && d.next_attempt_at && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>ลองใหม่ {formatInstant(d.next_attempt_at)}</div>}</td>
                      <td style={tdStyle}>{d.response_code ?? "-"}</td>
                      <td style={tdStyle}>{d.duration_ms != null ? `${d.duration_ms} ms` : "-"}</td>
                      <td style={tdStyle}>{d.attempts}</td>
                      <td style={tdStyle}><button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={e => { e.stopPropagation(); redeliver(d); }}><RefreshCw size={14} />ส่งอีกครั้ง</button></td>
                    </tr>
                    {open === d.id && (
                      <tr><td colSpan={7} style={{ ...tdStyle, background: "rgba(15,23,42,0.03)" }}>
                        {d.error && <p style={{ color: "var(--danger)", fontSize: "13px", margin: "0 0 8px" }}>{d.error}</p>}
                        <pre style={{ fontSize: "12px", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 }}>{pretty(d.payload)}</pre>
                        {d.response_excerpt && <><div className="form-label" style={{ marginTop: "8px" }}>คำตอบจากปลายทาง</div><pre style={{ fontSize: "12px", whiteSpace: "pre-wrap", margin: 0 }}>{d.response_excerpt}</pre></>}
                      </td></tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};
