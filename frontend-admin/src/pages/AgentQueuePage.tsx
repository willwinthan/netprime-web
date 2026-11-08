import React, { useEffect, useState } from "react";
import { Bot, Check, X, RefreshCw, Pause, AlertTriangle } from "lucide-react";
import { can, useApi } from "../hooks/useApi";
import { AutonomyPanel } from "../components/agents/AutonomyPanel";
import { Chip, Empty, ErrorBox, Modal, Field, tableStyle, thStyle, tdStyle, formatDateTime } from "../components/site-admin/ui";
import { Notice } from "../components/settings/shared";

/**
 * Approval queue for external AI agents (permission agents.approve). "Act" tools an agent asks for
 * (email/LINE, payment confirmation, publishing, course access) wait here; approving re-checks the
 * target and runs the same staff flow as the console button. Approving a tool also needs that tool's
 * own permission (e.g. payments.manage). History and the agents' request log are in the other tabs.
 */
interface Preview { summary: string; target: Record<string, unknown>; warnings: string[] }
interface Action {
  id: string; tool: string; tool_label: string; tier: "draft" | "act"; status: string; summary: string; reason: string | null;
  input: Record<string, unknown> | null; preview: Preview | null; result: unknown; error: string | null;
  agent_name: string | null; api_key_id: string; decided_by_name: string | null; decided_at: string | null; decision_note: string | null;
  executed_at: string | null; expires_at: string; created_at: string; updated_at: string; approver_permission?: string | null; can_approve?: boolean; auto_approved?: boolean;
}
interface AgentRow {
  id: string; name: string; description: string | null; prefix: string; paused_at: string | null; revoked_at: string | null;
  last_used_at: string | null; pending: number; requests_24h: number; daily_limit: number | null; allowed_hours: string | null;
}
interface ActivityRow { id: number; agent_name: string; method: string; path: string; status: number; ip: string | null; action_id: string | null; created_at: string }

const STATUS: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: "รออนุมัติ", color: "#b45309", bg: "rgba(245,158,11,0.12)" },
  executing: { label: "กำลังทำ", color: "#2563eb", bg: "rgba(37,99,235,0.1)" },
  executed: { label: "ทำแล้ว", color: "#15803d", bg: "rgba(34,197,94,0.12)" },
  failed: { label: "ไม่สำเร็จ", color: "var(--danger)", bg: "rgba(239,68,68,0.1)" },
  rejected: { label: "ไม่อนุมัติ", color: "var(--danger)", bg: "rgba(239,68,68,0.08)" },
  cancelled: { label: "agent ถอนคำขอ", color: "var(--text-muted)", bg: "rgba(100,116,139,0.1)" },
  expired: { label: "หมดเวลา", color: "var(--text-muted)", bg: "rgba(100,116,139,0.1)" }
};
const statusChip = (status: string) => { const s = STATUS[status] ?? STATUS.pending; return <Chip label={s.label} color={s.color} bg={s.bg} />; };
const TABS = [["pending", "รออนุมัติ"], ["history", "ประวัติ"], ["agents", "agent และบันทึกการเรียก"], ["rules", "อนุมัติอัตโนมัติ"]] as const;
type Tab = typeof TABS[number][0];

export const AgentQueuePage: React.FC = () => {
  const api = useApi();
  const [tab, setTab] = useState<Tab>("pending");
  const [actions, setActions] = useState<Action[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<{ action: Action; mode: "approve" | "reject" } | null>(null);

  const load = async () => {
    try {
      setError(null);
      if (tab === "rules") return;
      if (tab === "agents") {
        const d = await api.get<{ agents: AgentRow[]; activity: ActivityRow[] }>("/admin/agents/activity?limit=200");
        setAgents(d.agents); setActivity(d.activity);
      } else {
        const d = await api.get<{ actions: Action[]; counts: Record<string, number> }>(`/admin/agents/actions?status=${tab}&limit=100`);
        setActions(d.actions); setCounts(d.counts);
      }
    } catch (err: any) { setError(err.message); }
  };
  useEffect(() => { load(); }, [tab, api.token]);

  const pause = async (agent: AgentRow) => {
    try {
      const res = await api.post<{ message: string }>(`/admin/agents/keys/${agent.id}/pause`, {});
      setNotice(res.message);
      await load();
    } catch (err: any) { setError(err.message); }
  };

  return (
    <div>
      <div className="header-row">
        <div>
          <h1 className="header-title">คิวอนุมัติ AI agent</h1>
          <p className="header-desc">งานที่ AI agent ภายนอกขอทำและต้องให้คนตัดสินใจก่อน เช่น ส่งอีเมล/LINE ยืนยันการชำระเงิน เผยแพร่ และให้สิทธิ์เรียน ระบบตรวจข้อมูลล่าสุดอีกครั้งก่อนทำทุกครั้ง</p>
        </div>
        <button className="tech-button-outline" onClick={load}><RefreshCw size={16} />รีเฟรช</button>
      </div>
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
        {TABS.filter(([key]) => key !== "rules" || can(api.user, "integrations.manage")).map(([key, label]) => (
          <button key={key} className={tab === key ? "tech-button-primary" : "tech-button-outline"} onClick={() => setTab(key)}>
            {label}{key === "pending" && counts.pending ? ` (${counts.pending})` : ""}
          </button>
        ))}
      </div>
      <ErrorBox message={error} />
      <Notice message={notice} />

      {tab === "pending" && (actions.length === 0 ? <Empty text="ไม่มีงานรออนุมัติ" /> : (
        <div style={{ display: "grid", gap: "12px" }}>
          {actions.map(a => (
            <div key={a.id} className="glass-panel" style={{ padding: "16px 18px", display: "grid", gap: "8px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <Bot size={18} /><strong>{a.agent_name}</strong><Chip label={a.tool_label} color="#7c3aed" bg="rgba(124,58,237,0.1)" />
                  <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>ขอเมื่อ {formatDateTime(a.created_at)} · หมดเวลา {formatDateTime(a.expires_at)}</span>
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button className="tech-button-outline" style={{ color: "var(--danger)" }} onClick={() => setDeciding({ action: a, mode: "reject" })}><X size={16} />ไม่อนุมัติ</button>
                  <button className="tech-button-primary" disabled={!a.can_approve} title={a.can_approve ? "" : `ต้องมีสิทธิ์ ${a.approver_permission}`}
                    onClick={() => setDeciding({ action: a, mode: "approve" })}><Check size={16} />ตรวจและอนุมัติ</button>
                </div>
              </div>
              <div style={{ fontSize: "15px" }}>{a.summary}</div>
              {a.reason && <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>เหตุผลจาก agent: {a.reason}</div>}
              <Warnings list={a.preview?.warnings} />
              {!a.can_approve && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>บัญชีของคุณอนุมัติงานนี้ไม่ได้ ต้องมีสิทธิ์ {a.approver_permission}</div>}
            </div>
          ))}
        </div>
      ))}

      {tab === "history" && (actions.length === 0 ? <Empty text="ยังไม่มีประวัติ" /> : (
        <div className="glass-panel" style={{ overflowX: "auto", padding: 0 }}>
          <table style={tableStyle}>
            <thead><tr><th style={thStyle}>เวลา</th><th style={thStyle}>agent</th><th style={thStyle}>งาน</th><th style={thStyle}>สถานะ</th><th style={thStyle}>ผู้ตัดสินใจ</th></tr></thead>
            <tbody>{actions.map(a => (
              <tr key={a.id}>
                <td style={{ ...tdStyle, whiteSpace: "nowrap", fontSize: "12px" }}>{formatDateTime(a.updated_at)}</td>
                <td style={tdStyle}>{a.agent_name}</td>
                <td style={tdStyle}><div><strong>{a.tool_label}</strong>{a.tier === "draft" && <span style={{ fontSize: "12px", color: "var(--text-muted)" }}> · ร่าง (ทำทันที)</span>}</div>
                  <div style={{ fontSize: "13px" }}>{a.summary}</div>
                  {a.error && <div style={{ fontSize: "12px", color: "var(--danger)" }}>{a.error}</div>}</td>
                <td style={tdStyle}>{statusChip(a.status)}{a.auto_approved && <div style={{ marginTop: 4 }}><Chip label="อัตโนมัติ" color="#7c3aed" bg="rgba(124,58,237,0.1)" /></div>}</td>
                <td style={{ ...tdStyle, fontSize: "13px" }}>{a.decided_by_name ?? "-"}{a.decision_note && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{a.decision_note}</div>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ))}

      {tab === "rules" && <AutonomyPanel />}

      {tab === "agents" && (
        <div style={{ display: "grid", gap: "16px" }}>
          {agents.length === 0 ? <Empty text="ยังไม่มี agent key (ผู้ดูแลระบบสร้างได้ที่ ตั้งค่าระบบ → API keys)" /> : (
            <div className="glass-panel" style={{ overflowX: "auto", padding: 0 }}>
              <table style={tableStyle}>
                <thead><tr><th style={thStyle}>agent</th><th style={thStyle}>สถานะ</th><th style={thStyle}>รออนุมัติ</th><th style={thStyle}>คำขอ 24 ชม.</th><th style={thStyle}>ใช้ล่าสุด</th><th style={thStyle}></th></tr></thead>
                <tbody>{agents.map(g => (
                  <tr key={g.id} style={{ opacity: g.revoked_at ? 0.55 : 1 }}>
                    <td style={tdStyle}><strong>{g.name}</strong>{g.description && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{g.description}</div>}</td>
                    <td style={tdStyle}>{g.revoked_at ? <Chip label="เพิกถอนแล้ว" color="var(--danger)" bg="rgba(239,68,68,0.1)" />
                      : g.paused_at ? <Chip label="หยุดชั่วคราว" color="#b45309" bg="rgba(245,158,11,0.12)" /> : <Chip label="ทำงาน" color="#15803d" bg="rgba(34,197,94,0.12)" />}</td>
                    <td style={tdStyle}>{g.pending}</td>
                    <td style={tdStyle}>{g.requests_24h.toLocaleString("th-TH")}{g.daily_limit ? ` / ${g.daily_limit.toLocaleString("th-TH")}` : ""}</td>
                    <td style={{ ...tdStyle, fontSize: "12px" }}>{formatDateTime(g.last_used_at)}</td>
                    <td style={tdStyle}>{!g.revoked_at && !g.paused_at && <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px", color: "var(--danger)" }} onClick={() => pause(g)}><Pause size={14} />หยุดทันที</button>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <div className="glass-panel" style={{ overflowX: "auto", padding: 0 }}>
            <table style={tableStyle}>
              <thead><tr><th style={thStyle}>เวลา</th><th style={thStyle}>agent</th><th style={thStyle}>คำขอ</th><th style={thStyle}>ผล</th><th style={thStyle}>IP</th></tr></thead>
              <tbody>{activity.length === 0 ? <tr><td style={tdStyle} colSpan={5}><Empty text="ยังไม่มีคำขอจาก agent" /></td></tr> : activity.map(r => (
                <tr key={r.id}>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap", fontSize: "12px" }}>{formatDateTime(r.created_at)}</td>
                  <td style={{ ...tdStyle, fontSize: "13px" }}>{r.agent_name}</td>
                  <td style={{ ...tdStyle, fontSize: "12px" }}><code>{r.method} {r.path}</code></td>
                  <td style={{ ...tdStyle, fontSize: "12px", color: r.status >= 400 ? "var(--danger)" : undefined }}>{r.status}</td>
                  <td style={{ ...tdStyle, fontSize: "12px" }}>{r.ip ?? "-"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      {deciding && <DecideModal action={deciding.action} mode={deciding.mode} onClose={() => setDeciding(null)}
        onDone={(message) => { setDeciding(null); setNotice(message); load(); }} />}
    </div>
  );
};

const Warnings: React.FC<{ list?: string[] }> = ({ list }) => list && list.length ? (
  <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", color: "#b45309" }}>
    {list.map(w => <li key={w}><AlertTriangle size={12} style={{ verticalAlign: "-1px", marginRight: 4 }} />{w}</li>)}
  </ul>
) : null;

/** Shows the target as it is now (fresh preview) and asks for an optional note before deciding. */
const DecideModal: React.FC<{ action: Action; mode: "approve" | "reject"; onClose: () => void; onDone: (message: string) => void }> = ({ action, mode, onClose, onDone }) => {
  const api = useApi();
  const [current, setCurrent] = useState<Preview | { error: string } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ current: Preview | { error: string } | null }>(`/admin/agents/actions/${action.id}`).then(d => setCurrent(d.current)).catch(err => setError(err.message));
  }, [action.id]);

  const submit = async () => {
    try {
      setBusy(true); setError(null);
      const res = await api.post<{ action: Action }>(`/admin/agents/actions/${action.id}/${mode}`, { note });
      if (mode === "reject") onDone("ไม่อนุมัติแล้ว agent จะเห็นเหตุผลที่ระบุ");
      else if (res.action.status === "executed") onDone(`ทำรายการแล้ว: ${res.action.summary}`);
      else { setError(`ทำรายการไม่สำเร็จ: ${res.action.error ?? ""}`); setBusy(false); }
    } catch (err: any) { setError(err.message); setBusy(false); }
  };
  const stale = current && "error" in current;
  return (
    <Modal title={mode === "approve" ? "ตรวจและอนุมัติงานของ agent" : "ไม่อนุมัติงานของ agent"} onClose={onClose}>
      <div style={{ display: "grid", gap: "12px" }}>
        <ErrorBox message={error} />
        <div><strong>{action.agent_name}</strong> ขอ: {action.summary}</div>
        {action.reason && <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>เหตุผลจาก agent: {action.reason}</div>}
        {current === null ? <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>กำลังตรวจข้อมูลล่าสุด…</div>
          : stale ? <div style={{ color: "var(--danger)", fontSize: "13px" }}>ข้อมูลเปลี่ยนไปแล้ว: {(current as { error: string }).error} (ถ้าอนุมัติ งานนี้จะไม่สำเร็จ)</div>
          : <div style={{ fontSize: "13px" }}>สถานะปัจจุบัน: {(current as Preview).summary}<Warnings list={(current as Preview).warnings} /></div>}
        <details>
          <summary style={{ cursor: "pointer", fontSize: "13px" }}>ข้อมูลที่ agent ส่งมา</summary>
          <pre style={{ fontSize: "12px", background: "rgba(15,23,42,0.04)", padding: "10px", borderRadius: "8px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{JSON.stringify(action.input, null, 2)}</pre>
        </details>
        <Field label={mode === "reject" ? "เหตุผลที่ไม่อนุมัติ *" : "หมายเหตุ (ไม่บังคับ)"} hint="agent จะเห็นข้อความนี้">
          <textarea className="form-input" rows={3} maxLength={500} value={note} onChange={e => setNote(e.target.value)} />
        </Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <button className="tech-button-outline" onClick={onClose} disabled={busy}>ยกเลิก</button>
          {mode === "approve"
            ? <button className="tech-button-primary" onClick={submit} disabled={busy || current === null}><Check size={16} />อนุมัติและทำรายการ</button>
            : <button className="tech-button-primary" style={{ background: "var(--danger)" }} onClick={submit} disabled={busy || !note.trim()}><X size={16} />ไม่อนุมัติ</button>}
        </div>
      </div>
    </Modal>
  );
};

export default AgentQueuePage;
