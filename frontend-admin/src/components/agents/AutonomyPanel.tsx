import React, { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, Empty, ErrorBox, Field, Modal, tableStyle, thStyle, tdStyle } from "../site-admin/ui";
import { Notice, Toggle } from "../settings/shared";

/**
 * Phase 4 of the agent platform: auto-approval rules (integrations.manage). A rule lets one agent's
 * requests for one act tool run without waiting, when they meet the conditions, up to a daily cap,
 * acting as the admin who last saved the rule. The 30-day track record helps decide where an agent
 * has earned that.
 */
interface ConditionSpec { type: "boolean" | "number" | "list"; label: string; options?: string[]; default?: unknown; required?: boolean }
interface CatalogEntry { tool: string; label: string; conditions: Record<string, ConditionSpec> }
interface Rule {
  id: string; api_key_id: string; agent_name: string | null; tool: string; tool_label: string; conditions: Record<string, unknown>;
  max_per_day: number; enabled: boolean; note: string | null; created_by_name: string | null; used_today: number;
}
interface Stat { api_key_id: string; agent_name: string; tool: string; approved: number; auto_approved: number; rejected: number; failed: number; pending: number }
interface AgentOption { id: string; name: string; revoked_at: string | null }

const describe = (value: unknown) => Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? (value ? "ใช่" : "ไม่") : String(value);

export const AutonomyPanel: React.FC = () => {
  const api = useApi();
  const [rules, setRules] = useState<Rule[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [stats, setStats] = useState<Stat[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ api_key_id?: string; tool?: string } | null>(null);

  const load = async () => {
    try {
      setError(null);
      const [d, a] = await Promise.all([
        api.get<{ rules: Rule[]; catalog: CatalogEntry[]; stats: Stat[] }>("/admin/agents/rules"),
        api.get<{ agents: AgentOption[] }>("/admin/agents/activity?limit=1")
      ]);
      setRules(d.rules); setCatalog(d.catalog); setStats(d.stats); setAgents(a.agents.filter(x => !x.revoked_at));
    } catch (err: any) { setError(err.message); }
  };
  useEffect(() => { load(); }, [api.token]);

  const toggle = async (rule: Rule) => {
    try { await api.patch(`/admin/agents/rules/${rule.id}`, { enabled: !rule.enabled }); await load(); } catch (err: any) { setError(err.message); }
  };
  const remove = async (rule: Rule) => {
    if (!window.confirm(`ลบกฎ ${rule.tool_label} ของ ${rule.agent_name}?`)) return;
    try { const res = await api.request<{ message: string }>(`/admin/agents/rules/${rule.id}`, { method: "DELETE" }); setNotice(res.message); await load(); }
    catch (err: any) { setError(err.message); }
  };
  const ruled = new Set(rules.map(r => `${r.api_key_id}:${r.tool}`));

  return (
    <div style={{ display: "grid", gap: "16px" }}>
      <ErrorBox message={error} />
      <Notice message={notice} />
      <Notice tone="warn" message="กฎอนุมัติอัตโนมัติทำงานในนามผู้ดูแลที่บันทึกกฎล่าสุด ระบบยังตรวจข้อมูลล่าสุดและเงื่อนไขทุกครั้ง งานที่ไม่ตรงเงื่อนไขหรือเกินจำนวนต่อวันจะรอคนอนุมัติตามปกติ หยุด agent ได้ทันทีจากแท็บ agent" />

      <div className="glass-panel" style={{ overflowX: "auto", padding: 0 }}>
        <div style={{ padding: "14px 16px 4px", fontWeight: 600 }}>ผลงาน 30 วันที่ผ่านมา (งานระดับลงมือ)</div>
        {stats.length === 0 ? <div style={{ padding: "0 16px 16px" }}><Empty text="ยังไม่มีงานระดับลงมือ" /></div> : (
          <table style={tableStyle}>
            <thead><tr><th style={thStyle}>agent</th><th style={thStyle}>งาน</th><th style={thStyle}>คนอนุมัติ</th><th style={thStyle}>อัตโนมัติ</th><th style={thStyle}>ไม่อนุมัติ</th><th style={thStyle}>ไม่สำเร็จ</th><th style={thStyle}></th></tr></thead>
            <tbody>{stats.map(s => {
              const label = catalog.find(c => c.tool === s.tool)?.label ?? s.tool;
              const decided = s.approved + s.rejected;
              const rate = decided ? Math.round((s.approved / decided) * 100) : null;
              return (
                <tr key={`${s.api_key_id}:${s.tool}`}>
                  <td style={tdStyle}>{s.agent_name}</td>
                  <td style={tdStyle}>{label}</td>
                  <td style={tdStyle}>{s.approved}{rate !== null && <span style={{ fontSize: "12px", color: "var(--text-muted)" }}> ({rate}%)</span>}</td>
                  <td style={tdStyle}>{s.auto_approved}</td>
                  <td style={{ ...tdStyle, color: s.rejected ? "var(--danger)" : undefined }}>{s.rejected}</td>
                  <td style={tdStyle}>{s.failed}</td>
                  <td style={tdStyle}>{!ruled.has(`${s.api_key_id}:${s.tool}`) && catalog.some(c => c.tool === s.tool) &&
                    <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={() => setCreating({ api_key_id: s.api_key_id, tool: s.tool })}>ตั้งกฎ</button>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>

      <div className="glass-panel" style={{ overflowX: "auto", padding: 0 }}>
        <div style={{ padding: "14px 16px 4px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>กฎอนุมัติอัตโนมัติ</strong>
          <button className="tech-button-primary" onClick={() => setCreating({})} disabled={!agents.length}><Plus size={16} />เพิ่มกฎ</button>
        </div>
        {rules.length === 0 ? <div style={{ padding: "0 16px 16px" }}><Empty text="ยังไม่มีกฎ ทุกงานระดับลงมือรอคนอนุมัติ" /></div> : (
          <table style={tableStyle}>
            <thead><tr><th style={thStyle}>agent</th><th style={thStyle}>งาน</th><th style={thStyle}>เงื่อนไข</th><th style={thStyle}>วันนี้</th><th style={thStyle}>สถานะ</th><th style={thStyle}></th></tr></thead>
            <tbody>{rules.map(r => {
              const specs = catalog.find(c => c.tool === r.tool)?.conditions ?? {};
              return (
                <tr key={r.id} style={{ opacity: r.enabled ? 1 : 0.6 }}>
                  <td style={tdStyle}>{r.agent_name}</td>
                  <td style={tdStyle}><strong>{r.tool_label}</strong>{r.note && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{r.note}</div>}</td>
                  <td style={{ ...tdStyle, fontSize: "12px" }}>{Object.keys(r.conditions).length === 0 ? "ไม่มีคำเตือนจากระบบ" :
                    Object.entries(r.conditions).map(([k, v]) => <div key={k}>{specs[k]?.label ?? k}: {describe(v)}</div>)}
                    <div style={{ color: "var(--text-muted)" }}>ทำงานในนาม {r.created_by_name}</div></td>
                  <td style={tdStyle}>{r.used_today} / {r.max_per_day}</td>
                  <td style={tdStyle}>{r.enabled ? <Chip label="เปิด" color="#15803d" bg="rgba(34,197,94,0.12)" /> : <Chip label="ปิด" color="var(--text-muted)" bg="rgba(100,116,139,0.1)" />}</td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px", marginRight: 6 }} onClick={() => toggle(r)}>{r.enabled ? "ปิด" : "เปิด"}</button>
                    <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px", color: "var(--danger)" }} onClick={() => remove(r)}><Trash2 size={14} /></button>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>

      {creating && <RuleForm catalog={catalog} agents={agents} initial={creating} onClose={() => setCreating(null)}
        onSaved={() => { setCreating(null); setNotice("บันทึกกฎแล้ว"); load(); }} />}
    </div>
  );
};

const RuleForm: React.FC<{ catalog: CatalogEntry[]; agents: AgentOption[]; initial: { api_key_id?: string; tool?: string }; onClose: () => void; onSaved: () => void }> = ({ catalog, agents, initial, onClose, onSaved }) => {
  const api = useApi();
  const [keyId, setKeyId] = useState(initial.api_key_id ?? agents[0]?.id ?? "");
  const [tool, setTool] = useState(initial.tool ?? catalog[0]?.tool ?? "");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [maxPerDay, setMaxPerDay] = useState(10);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const specs = catalog.find(c => c.tool === tool)?.conditions ?? {};
  useEffect(() => {
    setValues(Object.fromEntries(Object.entries(specs).filter(([, s]) => s.default !== undefined).map(([k, s]) => [k, s.default])));
  }, [tool]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setError(null);
      await api.post("/admin/agents/rules", { api_key_id: keyId, tool, conditions: values, max_per_day: maxPerDay, note });
      onSaved();
    } catch (err: any) { setError(err.message); }
  };
  const set = (k: string, v: unknown) => setValues(prev => ({ ...prev, [k]: v }));

  return (
    <Modal title="เพิ่มกฎอนุมัติอัตโนมัติ" onClose={onClose}>
      <form onSubmit={submit} style={{ display: "grid", gap: "14px" }}>
        <ErrorBox message={error} />
        <Field label="agent"><select className="form-input" value={keyId} onChange={e => setKeyId(e.target.value)}>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="งาน"><select className="form-input" value={tool} onChange={e => setTool(e.target.value)}>{catalog.map(c => <option key={c.tool} value={c.tool}>{c.label}</option>)}</select></Field>
        {Object.entries(specs).map(([key, spec]) => spec.type === "boolean" ? (
          <Toggle key={key} checked={values[key] === true} label={spec.label} onChange={on => set(key, on)} />
        ) : spec.type === "number" ? (
          <Field key={key} label={`${spec.label}${spec.required ? " *" : ""}`}><input className="form-input" type="number" min={0} value={String(values[key] ?? "")} onChange={e => set(key, e.target.value === "" ? undefined : Number(e.target.value))} /></Field>
        ) : spec.options ? (
          <Field key={key} label={`${spec.label}${spec.required ? " *" : ""}`}>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>{spec.options.map(o => {
              const list = Array.isArray(values[key]) ? values[key] as string[] : [];
              const on = list.includes(o);
              return <button key={o} type="button" className={on ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "4px 10px", fontSize: "12px" }}
                onClick={() => set(key, on ? list.filter(x => x !== o) : [...list, o])}>{o}</button>;
            })}</div>
          </Field>
        ) : (
          <Field key={key} label={`${spec.label}${spec.required ? " *" : ""}`} hint="คั่นด้วยจุลภาค">
            <input className="form-input" value={Array.isArray(values[key]) ? (values[key] as string[]).join(", ") : ""}
              onChange={e => set(key, e.target.value.split(",").map(s => s.trim()).filter(Boolean))} />
          </Field>
        ))}
        {Object.keys(specs).length === 0 && <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>งานนี้ทำอัตโนมัติเฉพาะเมื่อระบบไม่มีคำเตือน</div>}
        <Field label="จำนวนสูงสุดต่อวัน (เวลาไทย)"><input className="form-input" type="number" min={1} max={1000} value={maxPerDay} onChange={e => setMaxPerDay(Number(e.target.value))} /></Field>
        <Field label="หมายเหตุ" hint="แสดงในบันทึกการอนุมัติ"><input className="form-input" maxLength={300} value={note} onChange={e => setNote(e.target.value)} /></Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={!keyId || !tool}>บันทึกกฎ</button>
        </div>
      </form>
    </Modal>
  );
};
