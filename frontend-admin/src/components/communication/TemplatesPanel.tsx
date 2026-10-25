import React, { useEffect, useState } from "react";
import { Eye, RotateCcw, Save } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, ErrorBox, Field, formatDateTime } from "../site-admin/ui";

interface Template {
  key: string; label: string; variables: string[]; default_subject: string; default_body: string;
  override: { subject: string; body_html: string; updated_at: string; updated_by_name: string | null } | null;
}

/** Email templates editor (communication.manage): override subject/body of system emails, preview with sample values. */
export const TemplatesPanel: React.FC = () => {
  const api = useApi();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [key, setKey] = useState<string>("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (select?: string) => {
    try {
      const data = await api.get<{ templates: Template[] }>("/communication/templates");
      setTemplates(data.templates);
      const current = data.templates.find(t => t.key === (select ?? key)) ?? data.templates[0];
      if (current) pick(current);
    } catch (err: any) { setError(err.message); }
  };
  useEffect(() => { load(); }, [api.token]);

  const pick = (t: Template) => {
    setKey(t.key);
    setSubject(t.override?.subject ?? t.default_subject);
    setBody(t.override?.body_html ?? t.default_body);
    setPreview(null);
    setNotice(null);
  };

  const current = templates.find(t => t.key === key);
  const run = async (action: () => Promise<void>) => {
    try { setBusy(true); setError(null); setNotice(null); await action(); } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const doPreview = () => run(async () => setPreview(await api.post(`/communication/templates/${key}/preview`, { subject, body })));
  const save = () => run(async () => {
    await api.request(`/communication/templates/${key}`, { method: "PUT", body: JSON.stringify({ subject, body }) });
    setNotice("บันทึกแล้ว อีเมลประเภทนี้จะใช้แม่แบบนี้ทันที");
    await load(key);
  });
  const reset = () => run(async () => {
    if (!window.confirm("กลับไปใช้อีเมลมาตรฐานของระบบ?")) return;
    await api.request(`/communication/templates/${key}`, { method: "DELETE" });
    setNotice("กลับไปใช้อีเมลมาตรฐานแล้ว");
    await load(key);
  });

  const insertVar = (name: string) => setBody(b => `${b}{{${name}}}`);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 240px) 1fr", gap: "20px", alignItems: "start" }}>
      <nav aria-label="แม่แบบอีเมล">
        {templates.map(t => (
          <button key={t.key} type="button" onClick={() => pick(t)} aria-current={t.key === key}
            style={{ display: "block", width: "100%", textAlign: "left", border: "none", borderRadius: "8px", padding: "8px 10px", marginBottom: "4px", cursor: "pointer", background: t.key === key ? "var(--primary-glow)" : "transparent" }}>
            <div style={{ fontSize: "14px", fontWeight: 600 }}>{t.label}</div>
            <div style={{ fontSize: "11px", color: t.override ? "var(--accent)" : "var(--text-muted)" }}>{t.override ? "แก้ไขแล้ว" : "มาตรฐาน"}</div>
          </button>
        ))}
      </nav>
      {current && (
        <div>
          <ErrorBox message={error} />
          {notice && <div role="status" style={{ color: "var(--accent)", fontSize: "13px", marginBottom: "10px" }}>{notice}</div>}
          <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "12px" }}>
            <h3 style={{ margin: 0, fontSize: "16px", flex: 1 }}>{current.label}</h3>
            {current.override
              ? <Chip label={`แก้ไขล่าสุด ${formatDateTime(current.override.updated_at)}${current.override.updated_by_name ? ` โดย ${current.override.updated_by_name}` : ""}`} color="var(--accent)" bg="var(--accent-glow)" />
              : <Chip label="ใช้อีเมลมาตรฐาน" color="var(--text-secondary)" bg="rgba(100,116,139,0.12)" />}
          </div>
          <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "10px" }}>
            ตัวแปร (กดเพื่อแทรก):{" "}
            {current.variables.map(v => (
              <button key={v} type="button" onClick={() => insertVar(v)} style={{ fontFamily: "monospace", fontSize: "12px", border: "1px solid rgba(0,0,0,0.1)", borderRadius: "6px", padding: "1px 6px", marginRight: "4px", background: "#fff", cursor: "pointer" }}>{`{{${v}}}`}</button>
            ))}
            <div style={{ marginTop: "4px" }}>ค่าตัวแปรถูกแปลงเป็นข้อความปลอดภัยเสมอ แท็กที่ไม่อนุญาต (script, iframe, ฟอร์ม, on*) จะถูกตัดออกตอนบันทึก</div>
          </div>
          <Field label="หัวเรื่องอีเมล"><input className="form-input" maxLength={300} value={subject} onChange={e => setSubject(e.target.value)} /></Field>
          <Field label="เนื้อหา (HTML)" hint="ระบบใส่กรอบและท้ายอีเมลมาตรฐานให้อัตโนมัติ">
            <textarea className="form-input" rows={12} value={body} onChange={e => setBody(e.target.value)} style={{ fontFamily: "monospace", fontSize: "13px" }} />
          </Field>
          <div style={{ display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap" }}>
            <button type="button" className="tech-button-outline" disabled={busy} onClick={doPreview} style={{ padding: "6px 12px", display: "inline-flex", gap: "6px", alignItems: "center" }}><Eye size={14} />ดูตัวอย่าง</button>
            <button type="button" className="tech-button-primary" disabled={busy || !subject.trim() || !body.trim()} onClick={save} style={{ padding: "6px 12px", display: "inline-flex", gap: "6px", alignItems: "center" }}><Save size={14} />บันทึก</button>
            {current.override && <button type="button" className="tech-button-outline" disabled={busy} onClick={reset} style={{ padding: "6px 12px", display: "inline-flex", gap: "6px", alignItems: "center", color: "var(--danger)" }}><RotateCcw size={14} />กลับไปใช้มาตรฐาน</button>}
          </div>
          {preview && (
            <div style={{ marginTop: "16px" }}>
              <div style={{ fontSize: "13px", marginBottom: "6px" }}><strong>หัวเรื่อง:</strong> {preview.subject}</div>
              {/* Rendered in a sandboxed frame (no scripts) exactly as the email body. */}
              <iframe title="ตัวอย่างอีเมล" sandbox="" srcDoc={preview.html} style={{ width: "100%", height: "420px", border: "1px solid rgba(0,0,0,0.1)", borderRadius: "8px", background: "#fff" }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
