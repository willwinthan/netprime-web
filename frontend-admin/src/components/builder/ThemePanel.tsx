import React, { useEffect, useMemo, useState } from "react";
import { RotateCcw, Save } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Empty, ErrorBox, Field, grid2 } from "../site-admin/ui";
import { ImageInput, Notice, SelectInput, TextInput } from "./adminKit";
import { Background, ButtonStyle, DEFAULT_THEME, FONTS, FontName, FooterStyle, HeaderStyle, HeroLayout, Theme, contrastRatio, fontStack, isHex, loadFont, publishTheme, themeVars } from "./theme";
import fullLogo from "../../../logo/NetPrimeFullLogo.png";
import "../../site/site.css";
import { useBuilderPreview, usePreviewSync } from "./SitePreview";

/**
 * Tab "ธีมและแบรนด์": school name, logo, favicon, colors (contrast-checked like the server), font and corner radius,
 * with a live preview of the public header and buttons. Saving applies the theme everywhere immediately.
 */
/** Ready-made looks: colors and styles only (name, logo and favicon stay as they are). */
type ThemeStyle = Omit<Theme, "school_name" | "tagline" | "logo_url" | "favicon_url" | "hero_image_url">;
const PRESETS: Array<{ name: string; style: ThemeStyle }> = [
  { name: "NetPrime (ค่าเริ่มต้น)", style: { primary_color: "#c2541a", secondary_color: "#182443", accent_color: null, font: "Anuphan", heading_font: null, radius: 14, header_style: "light", button_style: "solid", background: "cream", footer_style: "dark", hero_layout: "split" } },
  { name: "องค์กร", style: { primary_color: "#1d4ea8", secondary_color: "#14213d", accent_color: "#5b8def", font: "IBM Plex Sans Thai", heading_font: null, radius: 8, header_style: "dark", button_style: "solid", background: "white", footer_style: "dark", hero_layout: "split" } },
  { name: "สดใส", style: { primary_color: "#c2410c", secondary_color: "#1f2937", accent_color: "#f59e0b", font: "Anuphan", heading_font: "Kanit", radius: 18, header_style: "brand", button_style: "pill", background: "white", footer_style: "light", hero_layout: "center" } },
  { name: "ธรรมชาติ", style: { primary_color: "#1d6f5f", secondary_color: "#16302b", accent_color: "#6fbf9f", font: "Sarabun", heading_font: "Prompt", radius: 16, header_style: "light", button_style: "pill", background: "cream", footer_style: "brand", hero_layout: "split" } },
  { name: "มินิมอล", style: { primary_color: "#1f2937", secondary_color: "#111827", accent_color: "#9ca3af", font: "IBM Plex Sans Thai", heading_font: null, radius: 4, header_style: "light", button_style: "outline", background: "white", footer_style: "light", hero_layout: "center" } },
  { name: "เทคโนโลยี", style: { primary_color: "#5b3cc4", secondary_color: "#1e1b4b", accent_color: "#a78bfa", font: "Noto Sans Thai", heading_font: "Prompt", radius: 12, header_style: "dark", button_style: "solid", background: "gray", footer_style: "dark", hero_layout: "split" } }
];

const isPreset = (theme: Theme, style: ThemeStyle) => (Object.keys(style) as Array<keyof ThemeStyle>).every(k => (theme[k] ?? null) === (style[k] ?? null));

/** A row of choice buttons (radio group). */
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="form-group" style={{ display: "grid", gap: 6 }}>
      <span className="form-label">{label}</span>
      <div role="radiogroup" aria-label={label} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {options.map(([key, text]) => (
          <button key={key} type="button" role="radio" aria-checked={value === key} onClick={() => onChange(key)}
            className={value === key ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "6px 12px", fontSize: 13, borderRadius: 10 }}>{text}</button>
        ))}
      </div>
    </div>
  );
}

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
  const preview = useBuilderPreview();
  usePreviewSync("theme", theme);

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
  const valid = checks.every(c => c.ok) && theme.school_name.trim() !== "" && (theme.hero_layout !== "image" || !!theme.hero_image_url);

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
    <div style={{ display: "grid", gap: 20, gridTemplateColumns: preview.active ? "minmax(0, 1fr)" : "repeat(auto-fit, minmax(340px, 1fr))", alignItems: "start" }}>
      <div className="glass-card" style={{ padding: 20, display: "grid", gap: 14 }}>
        <ErrorBox message={error} />
        {notice && <Notice>{notice}</Notice>}
        <div style={{ display: "grid", gap: 8 }}>
          <span className="form-label">ธีมสำเร็จรูป</span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
            {PRESETS.map(p => {
              const on = isPreset(theme, p.style);
              return (
                <button key={p.name} type="button" aria-pressed={on} onClick={() => set(p.style)}
                  style={{ display: "grid", gap: 6, padding: 10, borderRadius: 12, cursor: "pointer", textAlign: "left", font: "inherit", fontSize: 13,
                    background: "#fff", border: on ? "2px solid var(--primary)" : "1px solid var(--border-subtle)" }}>
                  <span style={{ display: "flex", gap: 4 }}>
                    {[p.style.primary_color, p.style.secondary_color, p.style.accent_color ?? p.style.primary_color].map((c, i) => (
                      <span key={i} style={{ width: 22, height: 22, borderRadius: 6, background: c }} />
                    ))}
                  </span>
                  <span style={{ fontWeight: on ? 700 : 500 }}>{p.name}</span>
                </button>
              );
            })}
          </div>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>กดแล้วปรับต่อได้ทุกค่า ชื่อโรงเรียนและโลโก้ไม่เปลี่ยน</span>
        </div>
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
          <SelectInput label="ฟอนต์หัวข้อ" value={(theme.heading_font ?? "") as FontName | ""}
            options={[["", "เหมือนฟอนต์หลัก"] as [FontName | "", string], ...FONTS.map(f => [f, f] as [FontName | "", string])]}
            onChange={v => set({ heading_font: (v || null) as FontName | null })} />
          <Field label="สีเน้น" hint="ใช้กับป้ายและจุดตกแต่ง">
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input type="color" value={theme.accent_color && isHex(theme.accent_color) ? theme.accent_color : "#e56b25"} onChange={e => set({ accent_color: e.target.value })} style={{ width: 44, height: 38, border: 0, background: "none", padding: 0 }} aria-label="เลือกสีเน้น" />
              <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" checked={theme.accent_color === null} onChange={e => set({ accent_color: e.target.checked ? null : theme.primary_color })} />ใช้สีจากสีหลักอัตโนมัติ
              </label>
            </div>
          </Field>
        </div>
        <div style={{ display: "grid", gap: 14, borderTop: "1px solid var(--border-subtle)", paddingTop: 14 }}>
          <strong style={{ fontSize: 14 }}>รูปแบบหน้าเว็บ</strong>
          <Choice<HeaderStyle> label="แถบเมนูด้านบน" value={theme.header_style} onChange={v => set({ header_style: v })}
            options={[["light", "พื้นขาว"], ["brand", "สีหลัก"], ["dark", "สีเข้ม"]]} />
          <Choice<ButtonStyle> label="ปุ่ม" value={theme.button_style} onChange={v => set({ button_style: v })}
            options={[["solid", "ทึบ"], ["pill", "ทรงแคปซูล"], ["outline", "ขอบเส้น"]]} />
          <Choice<Background> label="พื้นหลังหน้าเว็บ" value={theme.background} onChange={v => set({ background: v })}
            options={[["cream", "ครีม"], ["white", "ขาว"], ["gray", "เทาอ่อน"]]} />
          <Choice<FooterStyle> label="ส่วนท้าย" value={theme.footer_style} onChange={v => set({ footer_style: v })}
            options={[["dark", "สีเข้ม"], ["light", "พื้นขาว"], ["brand", "สีหลัก"]]} />
          <Choice<HeroLayout> label="ส่วนหัวของหน้าแรก" value={theme.hero_layout} onChange={v => set({ hero_layout: v })}
            options={[["split", "ข้อความกับรูป"], ["center", "ข้อความตรงกลาง"], ["image", "รูปเต็มพื้นหลัง"]]} />
          {theme.hero_layout === "image" && (
            <ImageInput label="รูปพื้นหลังส่วนหัว" value={theme.hero_image_url} token={api.token} hint="รูปแนวนอนกว้างอย่างน้อย 1600px ระบบใส่สีเข้มทับให้อ่านข้อความได้" onChange={v => set({ hero_image_url: v || null })} span />
          )}
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

      {/* Small sample only when the full-site preview is hidden. */}
      {!preview.active && <div style={{ display: "grid", gap: 8, position: "sticky", top: 12 }}>
        <strong style={{ fontSize: 14 }}>ตัวอย่างสด</strong>
        <div className="ps" style={{ ...vars, minHeight: 0, borderRadius: 14, overflow: "hidden", border: "1px solid rgba(0,0,0,0.08)", fontFamily: fontStack(theme.font) }}>
          <div className="ps-header" style={{ position: "static" }}>
            <div className="ps-container ps-header-inner" style={{ padding: "12px 16px" }}>
              <span className="ps-brand">
                {theme.logo_url && /^(https?:\/\/|\/)/.test(theme.logo_url) ? <>
                  <img src={theme.logo_url} alt="" />
                  <span><strong>{theme.school_name || "—"}</strong><small>{theme.tagline}</small></span>
                </> : <img className="ps-brand-full" src={fullLogo} alt={theme.school_name} />}
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
      </div>}
    </div>
  );
};

export default ThemePanel;
