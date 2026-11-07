import React, { useEffect, useRef, useState } from "react";
import { ErrorBox, Field, Modal } from "../site-admin/ui";
import { COVER_TEMPLATES, CoverOptions, coverFile, drawCover, loadCoverFonts } from "./coverTemplates";

interface Props {
  title: string;
  category?: string;
  slug?: string;
  onClose: () => void;
  /** Receives the finished JPEG; the editor uploads it and sets it as the cover. */
  onUse: (file: File) => Promise<void>;
}

/**
 * "สร้างหน้าปกจาก template": pick one of the ready-made designs, the title is placed in the middle,
 * optionally over the writer's own background photo. Everything is drawn in the browser.
 */
export const CoverMaker: React.FC<Props> = ({ title: initialTitle, category, slug, onClose, onUse }) => {
  const [title, setTitle] = useState(initialTitle);
  const [label, setLabel] = useState(category ?? "");
  const [brand, setBrand] = useState(true);
  const [photo, setPhoto] = useState<HTMLImageElement | null>(null);
  const [selected, setSelected] = useState(COVER_TEMPLATES[0].id);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [fontsReady, setFontsReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(document.createElement("canvas"));

  useEffect(() => { loadCoverFonts().then(() => setFontsReady(true)); }, []);

  // Redraw the thumbnails shortly after typing stops.
  useEffect(() => {
    if (!fontsReady) return;
    const timer = window.setTimeout(() => {
      const options: CoverOptions = { title, label, brand, photo };
      const next: Record<string, string> = {};
      for (const template of COVER_TEMPLATES) {
        drawCover(canvas.current, template, options);
        next[template.id] = canvas.current.toDataURL("image/jpeg", 0.8);
      }
      setPreviews(next);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [title, label, brand, photo, fontsReady]);

  const choosePhoto = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { setError("เลือกไฟล์รูป PNG, JPG, WEBP หรือ GIF"); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setPhoto(img);
    img.onerror = () => { setError("เปิดไฟล์รูปนี้ไม่ได้"); URL.revokeObjectURL(url); };
    img.src = url;
  };

  const use = async () => {
    const template = COVER_TEMPLATES.find(t => t.id === selected)!;
    setBusy(true);
    setError(null);
    try {
      drawCover(canvas.current, template, { title, label, brand, photo });
      await onUse(await coverFile(canvas.current, slug ?? ""));
    } catch (err: any) {
      setError(err.message || "ใช้หน้าปกนี้ไม่สำเร็จ");
      setBusy(false);
    }
  };

  const selectedPreview = previews[selected];

  return (
    <Modal title="สร้างหน้าปกจาก template" onClose={onClose} width={920}>
      <ErrorBox message={error} />
      <div style={{ display: "grid", gap: 16 }}>
        <div className="np-covermaker-preview">
          {selectedPreview ? <img src={selectedPreview} alt="ตัวอย่างหน้าปก" /> : <span>กำลังเตรียมตัวอย่าง...</span>}
        </div>

        <div role="radiogroup" aria-label="แบบหน้าปก" className="np-covermaker-grid">
          {COVER_TEMPLATES.map(t => (
            <button key={t.id} type="button" role="radio" aria-checked={selected === t.id} className="np-covermaker-option" onClick={() => setSelected(t.id)}>
              {previews[t.id] ? <img src={previews[t.id]} alt="" /> : <span className="np-covermaker-blank" />}
              <span>{t.name}</span>
            </button>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "14px 16px" }}>
          <Field label="หัวข้อบนหน้าปก" hint="ยาวได้ 3 บรรทัด ตัวอักษรจะเล็กลงเองถ้าหัวข้อยาว">
            <input className="form-input" value={title} onChange={e => setTitle(e.target.value)} maxLength={140} />
          </Field>
          <Field label="ป้ายเหนือหัวข้อ (ไม่บังคับ)" hint="เช่น หมวดหมู่บทความ">
            <input className="form-input" value={label} onChange={e => setLabel(e.target.value)} maxLength={40} placeholder="เช่น Network" />
          </Field>
        </div>

        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", fontSize: 14 }}>
          <label className="tech-button-outline" style={{ borderRadius: "1rem", cursor: "pointer", padding: "8px 14px", fontSize: 13 }}>
            {photo ? "เปลี่ยนรูปพื้นหลัง" : "ใช้รูปของฉันเป็นพื้นหลัง"}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={e => { choosePhoto(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          {photo && <button type="button" className="np-icon-button" onClick={() => setPhoto(null)}>ใช้พื้นหลังของ template</button>}
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={brand} onChange={e => setBrand(e.target.checked)} /> แสดงชื่อ NetPrime ด้านล่าง
          </label>
        </div>
        {photo && <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>ระบบใส่สีของแบบที่เลือกทับรูปไว้บางๆ เพื่อให้อ่านหัวข้อได้ชัด</p>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button type="button" className="tech-button-outline" onClick={onClose} style={{ borderRadius: "1rem" }}>ยกเลิก</button>
          <button type="button" className="tech-button-primary" onClick={use} disabled={busy || !selectedPreview} style={{ borderRadius: "1rem" }}>
            {busy ? "กำลังบันทึก..." : "ใช้หน้าปกนี้"}
          </button>
        </div>
      </div>
    </Modal>
  );
};
