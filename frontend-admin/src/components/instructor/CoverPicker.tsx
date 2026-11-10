import React, { useEffect, useRef, useState } from "react";
import { API_BASE_URL, useApi } from "../../hooks/useApi";
import {
  COVER_H, COVER_LIMITS, COVER_PALETTES, COVER_TEMPLATES, COVER_W, DEFAULT_PALETTE_ID, DEFAULT_TEMPLATE_ID,
  STOCK_COVERS, suggestStockCover
} from "./coverLayout";
import type { CoverMode } from "./coverLayout";
import {
  drawCoverTemplate, drawPhotoCover, ensureCoverFonts, loadImageFile, makeCoverCanvas, renderPhotoBlob, renderTemplateBlob
} from "./coverTemplates";

type TabId = "template" | "photo" | "stock" | "link";
const TABS: { id: TabId; label: string }[] = [
  { id: "template", label: "แม่แบบสำเร็จรูป" },
  { id: "photo", label: "อัปโหลดรูปของฉัน" },
  { id: "stock", label: "รูปประกอบสำเร็จรูป" },
  { id: "link", label: "ใช้ลิงก์" }
];

/** Canvas that redraws whenever `draw` changes; `scale` shrinks the 1280x720 drawing for previews. */
const CoverCanvas: React.FC<{ scale: number; draw: (ctx: CanvasRenderingContext2D) => void; label: string; deps: unknown[] }> = ({ scale, draw, label, deps }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    ensureCoverFonts().then(() => {
      const canvas = ref.current;
      if (!live || !canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, COVER_W, COVER_H);
      draw(ctx);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, ...deps]);
  return <canvas ref={ref} width={Math.round(COVER_W * scale)} height={Math.round(COVER_H * scale)} role="img" aria-label={label}
    style={{ width: "100%", height: "auto", aspectRatio: "16 / 9", display: "block", borderRadius: "0.6rem" }} />;
};

/**
 * Course cover chooser: ready-made templates (colour + text), the instructor's own photo fitted to 16:9,
 * stock pictures, or a link. Generated covers are JPEGs drawn in the browser and stored through the
 * existing POST /instructor/images, so the rest of the system only ever sees a normal cover URL.
 */
export const CoverPicker: React.FC<{ value: string; onChange: (url: string) => void; courseTitle: string; hint?: string }> = ({ value, onChange, courseTitle, hint }) => {
  const api = useApi();
  const [tab, setTab] = useState<TabId>("template");
  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE_ID);
  const [paletteId, setPaletteId] = useState(DEFAULT_PALETTE_ID);
  const [titleText, setTitleText] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [badge, setBadge] = useState("");
  const [showBrand, setShowBrand] = useState(true);
  const [photo, setPhoto] = useState<HTMLImageElement | null>(null);
  const [mode, setMode] = useState<CoverMode>("crop");
  const [focusX, setFocusX] = useState(50);
  const [focusY, setFocusY] = useState(50);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spec = { title: titleText || courseTitle, subtitle, badge, showBrand };
  const stockHint = suggestStockCover(courseTitle).id;

  const upload = async (blob: Blob, name: string) => {
    const form = new FormData();
    form.append("file", new File([blob], name, { type: "image/jpeg" }));
    const res = await fetch(`${API_BASE_URL}/instructor/images`, { method: "POST", body: form, headers: api.token ? { Authorization: `Bearer ${api.token}` } : {} });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "อัปโหลดรูปไม่สำเร็จ");
    return data.url as string;
  };

  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await job(); } catch (err: any) { setError(err.message || "ทำรายการไม่สำเร็จ"); } finally { setBusy(false); }
  };

  const applyTemplate = () => run(async () => {
    const blob = await renderTemplateBlob(templateId, paletteId, spec, courseTitle);
    onChange(await upload(blob, "cover.jpg"));
  });

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { setError("รองรับไฟล์ PNG, JPG, WEBP หรือ GIF"); return; }
    if (file.size > 15 * 1024 * 1024) { setError("ไฟล์รูปใหญ่เกินไป (ไม่เกิน 15 MB)"); return; }
    run(async () => { setPhoto(await loadImageFile(file)); setFocusX(50); setFocusY(50); });
  };

  const applyPhoto = () => run(async () => {
    if (!photo) return;
    const blob = await renderPhotoBlob(photo, mode, focusX / 100, focusY / 100);
    if (blob.size > 5 * 1024 * 1024) throw new Error("รูปที่ได้ใหญ่เกิน 5 MB ลองใช้รูปอื่น");
    onChange(await upload(blob, "cover.jpg"));
  });

  const tabKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next.id);
    document.getElementById(`cover-tab-${next.id}`)?.focus();
  };

  const chip = (active: boolean): React.CSSProperties => ({
    border: `2px solid ${active ? "var(--accent)" : "var(--border-subtle)"}`, borderRadius: "0.7rem", padding: 4, background: "transparent", cursor: "pointer", textAlign: "left"
  });

  return (
    <div className="form-group" style={{ display: "grid", gap: 12 }}>
      <span className="form-label">รูปปกคอร์ส</span>

      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ width: 240, aspectRatio: "16 / 9", borderRadius: "0.75rem", border: "1px dashed var(--border-subtle)", background: "rgba(0,0,0,0.03)", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
          {value ? <img src={value} alt="ปกคอร์สปัจจุบัน" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : "ยังไม่มีรูปปก"}
        </div>
        <div style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)", maxWidth: 360 }}>{hint ?? "แสดงบนการ์ดคอร์สและหน้ารายละเอียดคอร์ส (สัดส่วน 16:9) เลือกแบบด้านล่างแล้วกด “ใช้เป็นปกคอร์ส”"}</span>
          {value && <button type="button" className="np-cb-btn danger" style={{ width: "fit-content" }} onClick={() => onChange("")}>เอารูปปกออก</button>}
        </div>
      </div>

      <div role="tablist" aria-label="วิธีทำรูปปก" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {TABS.map((t, i) => (
          <button key={t.id} id={`cover-tab-${t.id}`} type="button" role="tab" aria-selected={tab === t.id} aria-controls={`cover-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)} onKeyDown={e => tabKey(e, i)}
            className={tab === t.id ? "tech-button-primary" : "tech-button-outline"} style={{ borderRadius: "1rem", padding: "6px 14px", fontSize: 13 }}>
            {t.label}
          </button>
        ))}
      </div>

      <div id={`cover-panel-${tab}`} role="tabpanel" aria-labelledby={`cover-tab-${tab}`} style={{ display: "grid", gap: 12 }}>
        {tab === "template" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
              {COVER_TEMPLATES.map(t => (
                <button key={t.id} type="button" style={chip(templateId === t.id)} aria-pressed={templateId === t.id} title={t.hint} onClick={() => setTemplateId(t.id)}>
                  <CoverCanvas scale={0.22} label={`แม่แบบ ${t.name}`} deps={[t.id, paletteId, spec.title, subtitle, badge, showBrand]}
                    draw={ctx => drawCoverTemplate(ctx, t.id, paletteId, spec, courseTitle)} />
                  <span style={{ display: "block", fontSize: 12, padding: "4px 2px 0" }}>{t.name}</span>
                </button>
              ))}
            </div>
            <div role="group" aria-label="โทนสี" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 13 }}>โทนสี</span>
              {COVER_PALETTES.map(p => (
                <button key={p.id} type="button" aria-pressed={paletteId === p.id} aria-label={p.name} title={p.name} onClick={() => setPaletteId(p.id)}
                  style={{ width: 34, height: 34, borderRadius: "50%", cursor: "pointer", border: `3px solid ${paletteId === p.id ? "var(--accent)" : "transparent"}`, outline: "1px solid var(--border-subtle)", background: `linear-gradient(135deg, ${p.mid} 50%, ${p.accent} 50%)` }} />
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
              <label style={{ display: "grid", gap: 4, fontSize: 13 }}>ข้อความหลัก (เว้นว่าง = ใช้ชื่อคอร์ส)
                <input className="form-input" value={titleText} maxLength={COVER_LIMITS.title} placeholder={courseTitle || "ชื่อคอร์ส"} onChange={e => setTitleText(e.target.value)} />
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: 13 }}>บรรทัดรอง เช่น สอนโดย อ.สมชาย
                <input className="form-input" value={subtitle} maxLength={COVER_LIMITS.subtitle} onChange={e => setSubtitle(e.target.value)} />
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: 13 }}>ป้ายเล็ก เช่น คอร์สใหม่
                <input className="form-input" value={badge} maxLength={COVER_LIMITS.badge} onChange={e => setBadge(e.target.value)} />
              </label>
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={showBrand} onChange={e => setShowBrand(e.target.checked)} /> แสดงโลโก้ข้อความ “netprime” ที่มุมปก
            </label>
            <CoverCanvas scale={0.5} label="ตัวอย่างปกที่จะได้" deps={[templateId, paletteId, spec.title, subtitle, badge, showBrand]}
              draw={ctx => drawCoverTemplate(ctx, templateId, paletteId, spec, courseTitle)} />
            <button type="button" className="tech-button-primary" disabled={busy} onClick={applyTemplate} style={{ borderRadius: "1rem", width: "fit-content" }}>
              {busy ? "กำลังสร้างปก..." : "ใช้เป็นปกคอร์ส"}
            </button>
          </>
        )}

        {tab === "photo" && (
          <>
            <label className="tech-button-outline" style={{ borderRadius: "1rem", cursor: busy ? "wait" : "pointer", padding: "8px 16px", fontSize: 13, width: "fit-content" }}>
              {photo ? "เลือกรูปอื่น" : "เลือกรูปจากเครื่อง"}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: "none" }} disabled={busy}
                onChange={e => { pickFile(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            {photo ? (
              <>
                <CoverCanvas scale={0.5} label="ตัวอย่างรูปบนปก" deps={[photo, mode, focusX, focusY]}
                  draw={ctx => drawPhotoCover(ctx, photo, mode, focusX / 100, focusY / 100)} />
                <div role="group" aria-label="การจัดรูป" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" aria-pressed={mode === "crop"} className={mode === "crop" ? "tech-button-primary" : "tech-button-outline"} style={{ borderRadius: "1rem", padding: "6px 14px", fontSize: 13 }} onClick={() => setMode("crop")}>เต็มกรอบ (ตัดส่วนเกิน)</button>
                  <button type="button" aria-pressed={mode === "contain"} className={mode === "contain" ? "tech-button-primary" : "tech-button-outline"} style={{ borderRadius: "1rem", padding: "6px 14px", fontSize: 13 }} onClick={() => setMode("contain")}>เห็นทั้งรูป (พื้นหลังเบลอ)</button>
                </div>
                {mode === "crop" && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
                    <label style={{ display: "grid", gap: 4, fontSize: 13 }}>เลื่อนซ้าย-ขวา
                      <input type="range" min={0} max={100} value={focusX} onChange={e => setFocusX(Number(e.target.value))} />
                    </label>
                    <label style={{ display: "grid", gap: 4, fontSize: 13 }}>เลื่อนขึ้น-ลง
                      <input type="range" min={0} max={100} value={focusY} onChange={e => setFocusY(Number(e.target.value))} />
                    </label>
                  </div>
                )}
                <button type="button" className="tech-button-primary" disabled={busy} onClick={applyPhoto} style={{ borderRadius: "1rem", width: "fit-content" }}>
                  {busy ? "กำลังอัปโหลด..." : "ใช้เป็นปกคอร์ส"}
                </button>
              </>
            ) : <span style={{ fontSize: 12, color: "var(--text-muted)" }}>ระบบจะจัดรูปให้เป็นสัดส่วน 16:9 (1280×720 px) ให้เอง ไม่ต้องตัดรูปมาก่อน</span>}
          </>
        )}

        {tab === "stock" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8 }}>
              {STOCK_COVERS.map(s => (
                <button key={s.id} type="button" style={chip(value === s.url)} aria-pressed={value === s.url} onClick={() => onChange(s.url)}>
                  <img src={s.url} alt={s.label} loading="lazy" style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: "0.5rem", display: "block" }} />
                  <span style={{ display: "block", fontSize: 12, padding: "4px 2px 0" }}>{s.label}{s.id === stockHint && courseTitle ? " · แนะนำ" : ""}</span>
                </button>
              ))}
            </div>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>รูปจาก Unsplash คลิกเพื่อเลือกได้ทันที แล้วกด “บันทึก” ที่ฟอร์ม</span>
          </>
        )}

        {tab === "link" && (
          <input className="form-input" type="url" value={value} onChange={e => onChange(e.target.value)} placeholder="https://..." aria-label="ลิงก์รูปปก" />
        )}
      </div>
      {error && <span role="alert" style={{ fontSize: 12, color: "var(--danger)" }}>{error}</span>}
    </div>
  );
};
