import React, { useEffect, useMemo, useState } from "react";
import { RotateCcw, Save } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Empty, ErrorBox, Field, grid2 } from "../site-admin/ui";
import { ImageInput, Notice, SelectInput, TextInput } from "./adminKit";
import { DEFAULT_THEME, FONTS, FontName, Theme, contrastRatio, fontStack, isHex, loadFont, publishTheme, themeVars } from "./theme";
import logo from "../../../logo/NetPrimeLogo.png";
import "../../site/site.css";

/**
 * Tab "ธีมและแบรนด์": school name, logo, favicon, colors (contrast-checked like the server), font and corner radius,
 * with a live preview of the public header and buttons. Saving applies the theme everywhere immediately.
 */
export const ThemePanel: React.FC = () => {
  const api = useApi();
  const [theme, setTheme] = useState<Theme | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ theme: Theme }>("/website/theme").then(d => setTheme(d.theme)).catch(err => setError(err.message));
  }, [api.token]);
  useEffect(() => { if (theme) loadFont(theme.font); }, [theme?.font]);

  const checks = useMemo(() => {
    if (!theme) return [];
    return ([["primary_color", "สีหลัก (ปุ่ม ลิงก์) กับตัวอักษรสีขาว"], ["secondary_color", "สีรอง (หัวข้อ ตัวอักษร) บนพื้นขาว"]] as const).map(([key, label]) => {
      const value = theme[key];
      const ratio = isHex(value) ? contrastRatio(value, "#ffffff") : 0;
      return { key, label, ratio, ok: ratio >= 4.5 };
    });
  }, [theme]);

  if (!theme) return error ? <ErrorBox message={error} /> : <Empty text="กำลังโหลด…" />;
  const set = (patch: Partial<Theme>) => { setTheme({ ...theme, ...patch }); setNotice(null); };
  const valid = checks.every(c => c.ok) && theme.school_name.trim() !== "";

  const save = async () => {
    setSaving(true); setError(null); setNotice(null);
    try {
      const d = await api.request<{ theme: Theme }>("/website/theme", { method: "PUT", body: JSON.stringify(theme) });
      setTheme(d.theme);
      publishTheme(d.theme);
      setNotice("บันทึกธีมแล้ว หน้าเว็บและคอนโซลใช้สีใหม่ทันที (ผู้เข้าชมคนอื่นเห็นภายใน 5 นาที)");
    } catch (err: any) { setError(err.message); } finally { setSaving(false); }
  };

  const vars = themeVars(theme) as React.CSSProperties;
  return (
    <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", alignItems: "start" }}>
      <div className="glass-card" style={{ padding: 20, display: "grid", gap: 14 }}>
        <ErrorBox message={error} />
        {notice && <Notice>{notice}</Notice>}
        <div style={grid2}>
          <TextInput label="ชื่อโรงเรียน" required value={theme.school_name} max={80} onChange={v => set({ school_name: v })} />
          <TextInput label="คำโปรยใต้ชื่อ" value={theme.tagline} max={120} onChange={v => set({ tagline: v })} />
          <ImageInput label="โลโก้" value={theme.logo_url} token={api.token} hint="PNG พื้นใส สูงอย่างน้อย 80px (ว่าง = โลโก้ NetPrime)" onChange={v => set({ logo_url: v || null })} span />
          <ImageInput label="ไอคอนแท็บเบราว์เซอร์ (favicon)" value={theme.favicon_url} token={api.token} hint="PNG สี่เหลี่ยมจัตุรัส 64×64 ขึ้นไป" onChange={v => set({ favicon_url: v || null })} span />
          {(["primary_color", "secondary_color"] as const).map(key => (
            <Field key={key} label={key === "primary_color" ? "สีหลัก" : "สีรอง"}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="color" value={isHex(theme[key]) ? theme[key] : "#000000"} onChange={e => set({ [key]: e.target.value } as Partial<Theme>)} style={{ width: 44, height: 38, border: 0, background: "none", padding: 0 }} aria-label={key === "primary_color" ? "เลือกสีหลัก" : "เลือกสีรอง"} />
                <input className="form-input" value={theme[key]} maxLength={7} onChange={e => set({ [key]: e.target.value } as Partial<Theme>)} />
              </div>
            </Field>
          ))}
          <SelectInput label="ฟอนต์ (รองรับภาษาไทย)" value={theme.font} options={FONTS.map(f => [f, f === "Anuphan" ? "Anuphan (ค่าเริ่มต้น)" : f] as [FontName, string])} onChange={v => set({ font: v })} />
          <Field label={`ความมนของมุม: ${theme.radius}px`}>
            <input type="range" min={0} max={24} value={theme.radius} onChange={e => set({ radius: Number(e.target.value) })} />
          </Field>
        </div>
        <div style={{ display: "grid", gap: 6 }}>
          {checks.map(c => (
            <div key={c.key} style={{ fontSize: 13, color: c.ok ? "#047857" : "var(--danger)" }}>
              {c.ok ? "✓" : "✕"} {c.label}: คอนทราสต์ {c.ratio.toFixed(2)}:1 {c.ok ? "(ผ่าน WCAG AA)" : "— ต้องอย่างน้อย 4.5:1 เลือกสีที่เข้มขึ้น"}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="tech-button-primary" disabled={saving || !valid} onClick={save}><Save size={16} />{saving ? "กำลังบันทึก…" : "บันทึกธีม"}</button>
          <button type="button" className="tech-button-outline" onClick={() => set(DEFAULT_THEME)}><RotateCcw size={16} />ค่าเริ่มต้น</button>
        </div>
      </div>

      <div style={{ display: "grid", gap: 8, position: "sticky", top: 12 }}>
        <strong style={{ fontSize: 14 }}>ตัวอย่างสด</strong>
        <div className="ps" style={{ ...vars, minHeight: 0, borderRadius: 14, overflow: "hidden", border: "1px solid rgba(0,0,0,0.08)", fontFamily: fontStack(theme.font) }}>
          <div className="ps-header" style={{ position: "static" }}>
            <div className="ps-container ps-header-inner" style={{ padding: "12px 16px" }}>
              <span className="ps-brand">
                <img src={theme.logo_url && /^(https?:\/\/|\/)/.test(theme.logo_url) ? theme.logo_url : logo} alt="" />
                <span><strong>{theme.school_name || "—"}</strong><small>{theme.tagline}</small></span>
              </span>
              <span className="ps-nav"><a href="#preview" aria-current="page" onClick={e => e.preventDefault()}>หลักสูตร</a><a href="#preview" onClick={e => e.preventDefault()}>บทความ</a></span>
            </div>
          </div>
          <div style={{ padding: "24px 16px", display: "grid", gap: 14 }}>
            <span className="ps-eyebrow">คอร์สแนะนำ</span>
            <h2 style={{ margin: 0, fontSize: 26 }}>อบรม Network และ Cloud กับผู้เชี่ยวชาญ</h2>
            <p className="ps-muted" style={{ margin: 0 }}>ข้อความตัวอย่างสำหรับดูฟอนต์ {theme.font} — ภาษาไทยอ่านง่าย 0123456789</p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <span className="ps-btn ps-btn-primary">ลงทะเบียนอบรม</span>
              <span className="ps-btn ps-btn-outline">ดูหลักสูตร</span>
              <span className="ps-btn ps-btn-dark">ติดต่อเรา</span>
            </div>
            <div className="ps-card" style={{ padding: 16 }}><strong>การ์ดตัวอย่าง</strong><p className="ps-muted" style={{ margin: "6px 0 0" }}>มุมโค้งตามค่าที่ตั้งไว้</p></div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ThemePanel;
