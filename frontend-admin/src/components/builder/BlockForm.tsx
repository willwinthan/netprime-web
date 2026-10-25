import React, { Suspense, lazy } from "react";
import { grid2 } from "../site-admin/ui";
import { ImageInput, ListEditor, SelectInput, TextInput } from "./adminKit";
import { PageBlock, videoEmbed, isSafeLink } from "./blocks";

const RichTextEditor = lazy(() => import("./RichTextEditor"));

export interface CourseOptions { courses: Array<{ id: string; title: string; category_id: string | null }>; categories: Array<{ id: string; name: string }> }

const linkHint = (value: string | null | undefined) => isSafeLink(value) ? "เช่น /schedule, /p/ชื่อหน้า, #contact หรือ https://…" : "ลิงก์ต้องขึ้นต้นด้วย https:// หรือ /";

/** Settings form for one block; `onChange` receives the whole updated block. */
export const BlockForm: React.FC<{ block: PageBlock; onChange: (block: PageBlock) => void; token: string | null; options: CourseOptions | null }> = ({ block, onChange, token, options }) => {
  const set = (patch: Record<string, unknown>) => onChange({ ...block, ...patch } as PageBlock);
  switch (block.type) {
    case "hero":
      return (
        <div style={grid2}>
          <TextInput label="หัวข้อ" required value={block.heading} max={160} onChange={v => set({ heading: v })} span />
          <TextInput label="คำอธิบาย" value={block.subheading} max={500} multiline onChange={v => set({ subheading: v })} span />
          <ImageInput label="รูปด้านข้าง (ไม่บังคับ)" value={block.image_url} token={token} onChange={v => set({ image_url: v })} span />
          <TextInput label="ข้อความปุ่ม" value={block.cta_label} max={40} onChange={v => set({ cta_label: v })} />
          <TextInput label="ลิงก์ปุ่ม" value={block.cta_href} hint={linkHint(block.cta_href)} onChange={v => set({ cta_href: v })} />
          <SelectInput label="การจัดวาง" value={block.align || "left"} options={[["left", "ชิดซ้าย"], ["center", "กึ่งกลาง"]]} onChange={v => set({ align: v })} />
          <SelectInput label="โทนสีพื้นหลัง" value={block.tone || "light"} options={[["light", "ครีมอ่อน"], ["brand", "สีแบรนด์อ่อน"], ["dark", "เข้ม"]]} onChange={v => set({ tone: v })} />
        </div>
      );
    case "richtext":
      return (
        <Suspense fallback={<div style={{ padding: 16, color: "var(--text-muted)" }}>กำลังเปิดตัวแก้ไขข้อความ…</div>}>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 6px" }}>พิมพ์ / เพื่อเพิ่มหัวข้อ รายการ ตาราง หรือโค้ด เลือกข้อความเพื่อใส่ลิงก์หรือตัวหนา</p>
          <RichTextEditor value={block.doc} onChange={doc => set({ doc })} />
        </Suspense>
      );
    case "image":
      return (
        <div style={grid2}>
          <ImageInput label="รูปภาพ" value={block.url} token={token} onChange={v => set({ url: v })} span />
          <TextInput label="คำอธิบายรูป (สำหรับผู้พิการทางสายตา)" value={block.alt} max={200} onChange={v => set({ alt: v })} />
          <TextInput label="คำบรรยายใต้รูป" value={block.caption} max={300} onChange={v => set({ caption: v })} />
          <TextInput label="ลิงก์เมื่อคลิกรูป" value={block.link} hint={linkHint(block.link)} onChange={v => set({ link: v })} />
          <SelectInput label="ความกว้าง" value={block.width || "wide"} options={[["normal", "ปกติ"], ["wide", "กว้าง"], ["full", "เต็มจอ"]]} onChange={v => set({ width: v })} />
        </div>
      );
    case "image_text":
      return (
        <div style={grid2}>
          <ImageInput label="รูปภาพ" value={block.image_url} token={token} onChange={v => set({ image_url: v })} span />
          <TextInput label="คำอธิบายรูป" value={block.alt} max={200} onChange={v => set({ alt: v })} />
          <SelectInput label="ตำแหน่งรูป" value={block.image_side || "left"} options={[["left", "รูปซ้าย"], ["right", "รูปขวา"]]} onChange={v => set({ image_side: v })} />
          <TextInput label="หัวข้อ" value={block.heading} max={160} onChange={v => set({ heading: v })} span />
          <TextInput label="ข้อความ" value={block.text} max={5000} multiline hint="รองรับ **ตัวหนา**, [ลิงก์](https://…) และรายการ - " onChange={v => set({ text: v })} span />
          <TextInput label="ข้อความปุ่ม" value={block.cta_label} max={40} onChange={v => set({ cta_label: v })} />
          <TextInput label="ลิงก์ปุ่ม" value={block.cta_href} hint={linkHint(block.cta_href)} onChange={v => set({ cta_href: v })} />
        </div>
      );
    case "features":
      return (
        <div style={grid2}>
          <TextInput label="หัวข้อ" value={block.heading} max={160} onChange={v => set({ heading: v })} />
          <SelectInput label="จำนวนคอลัมน์" value={String(block.columns || 3) as "2" | "3" | "4"} options={[["2", "2 คอลัมน์"], ["3", "3 คอลัมน์"], ["4", "4 คอลัมน์"]]} onChange={v => set({ columns: Number(v) })} />
          <TextInput label="คำอธิบาย" value={block.intro} max={500} onChange={v => set({ intro: v })} span />
          <ListEditor items={block.items} max={12} addLabel="เพิ่มการ์ด" itemLabel={i => `การ์ดที่ ${i + 1}`} blank={() => ({ title: "หัวข้อ", text: "", image_url: null, link: null })}
            onChange={items => set({ items })} render={(item, update) => <>
              <TextInput label="หัวข้อ" required value={item.title} max={120} onChange={v => update({ title: v })} />
              <TextInput label="ลิงก์ (ไม่บังคับ)" value={item.link} hint={linkHint(item.link)} onChange={v => update({ link: v })} />
              <TextInput label="ข้อความ" value={item.text} max={1000} multiline onChange={v => update({ text: v })} span />
              <ImageInput label="รูป (ไม่บังคับ)" value={item.image_url} token={token} onChange={v => update({ image_url: v })} span />
            </>} />
        </div>
      );
    case "courses": {
      const selected = block.course_ids ?? [];
      return (
        <div style={grid2}>
          <TextInput label="หัวข้อ" value={block.heading} max={160} onChange={v => set({ heading: v })} />
          <SelectInput label="แสดงคอร์ส" value={block.mode} options={[["all", "คอร์สที่เผยแพร่ทั้งหมด"], ["category", "ตามหมวดหมู่"], ["ids", "เลือกเอง"]]} onChange={v => set({ mode: v })} />
          <Field2 label="จำนวนสูงสุด">
            <input className="form-input" type="number" min={1} max={24} value={block.limit ?? 6} onChange={e => set({ limit: Math.max(1, Math.min(24, Number(e.target.value) || 1)) })} />
          </Field2>
          {block.mode === "category" && (
            <SelectInput label="หมวดหมู่" value={block.category_id || ""} options={[["", "— เลือกหมวดหมู่ —"], ...(options?.categories ?? []).map(c => [c.id, c.name] as [string, string])]}
              onChange={v => set({ category_id: v || null })} />
          )}
          {block.mode === "ids" && (
            <div style={{ gridColumn: "1 / -1", display: "grid", gap: 4, maxHeight: 220, overflowY: "auto", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 8, padding: 10 }}>
              {!options && <span style={{ color: "var(--text-muted)", fontSize: 13 }}>กำลังโหลดคอร์ส…</span>}
              {options?.courses.length === 0 && <span style={{ color: "var(--text-muted)", fontSize: 13 }}>ยังไม่มีคอร์สที่เผยแพร่</span>}
              {options?.courses.map(c => (
                <label key={c.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
                  <input type="checkbox" checked={selected.includes(c.id)} onChange={e => set({ course_ids: e.target.checked ? [...selected, c.id] : selected.filter(id => id !== c.id) })} />
                  {c.title}
                </label>
              ))}
            </div>
          )}
        </div>
      );
    }
    case "testimonials":
      return (
        <div style={grid2}>
          <TextInput label="หัวข้อ" value={block.heading} max={160} onChange={v => set({ heading: v })} span />
          <ListEditor items={block.items} max={12} addLabel="เพิ่มรีวิว" itemLabel={i => `รีวิวที่ ${i + 1}`} blank={() => ({ quote: "", name: "", role: null, avatar_url: null })}
            onChange={items => set({ items })} render={(item, update) => <>
              <TextInput label="ข้อความรีวิว" required value={item.quote} max={1000} multiline onChange={v => update({ quote: v })} span />
              <TextInput label="ชื่อ" required value={item.name} max={80} onChange={v => update({ name: v })} />
              <TextInput label="ตำแหน่ง/บริษัท" value={item.role} max={120} onChange={v => update({ role: v })} />
              <ImageInput label="รูปผู้รีวิว (ไม่บังคับ)" value={item.avatar_url} token={token} onChange={v => update({ avatar_url: v })} span />
            </>} />
        </div>
      );
    case "faq":
      return (
        <div style={grid2}>
          <TextInput label="หัวข้อ" value={block.heading} max={160} onChange={v => set({ heading: v })} span />
          <ListEditor items={block.items} max={30} addLabel="เพิ่มคำถาม" itemLabel={i => `คำถามที่ ${i + 1}`} blank={() => ({ q: "", a: "" })}
            onChange={items => set({ items })} render={(item, update) => <>
              <TextInput label="คำถาม" required value={item.q} max={300} onChange={v => update({ q: v })} span />
              <TextInput label="คำตอบ" required value={item.a} max={3000} multiline onChange={v => update({ a: v })} span />
            </>} />
        </div>
      );
    case "cta":
      return (
        <div style={grid2}>
          <TextInput label="หัวข้อ" value={block.heading} max={160} onChange={v => set({ heading: v })} span />
          <TextInput label="ข้อความ" value={block.text} max={500} onChange={v => set({ text: v })} span />
          <TextInput label="ข้อความปุ่ม" required value={block.label} max={40} onChange={v => set({ label: v })} />
          <TextInput label="ลิงก์ปุ่ม" required value={block.href} hint={linkHint(block.href)} onChange={v => set({ href: v })} />
          <SelectInput label="สีแถบ" value={block.style || "primary"} options={[["primary", "สีแบรนด์"], ["dark", "เข้ม"], ["outline", "ขาวมีกรอบ"]]} onChange={v => set({ style: v })} />
        </div>
      );
    case "video":
      return (
        <div style={grid2}>
          <TextInput label="ลิงก์วิดีโอ" required value={block.url} max={500} span placeholder="https://www.youtube.com/watch?v=… หรือ https://vimeo.com/…"
            hint={block.url && !videoEmbed(block.url) ? "รองรับเฉพาะ YouTube หรือ Vimeo (https://)" : "รองรับ YouTube และ Vimeo"} onChange={v => set({ url: v })} />
          <TextInput label="ชื่อวิดีโอ" value={block.title} max={160} onChange={v => set({ title: v })} span />
        </div>
      );
    case "lead_form":
      return (
        <div style={grid2}>
          <TextInput label="รหัสฟอร์ม" required value={block.form_id} max={80} hint="คัดลอกจากเมนูการตลาด → ฟอร์มเก็บ lead" onChange={v => set({ form_id: v.replace(/[^A-Za-z0-9_-]/g, "") })} />
          <TextInput label="หัวข้อ" value={block.heading} max={160} onChange={v => set({ heading: v })} />
        </div>
      );
  }
};

const Field2: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="form-group" style={{ display: "flex", flexDirection: "column", gap: 6 }}><span className="form-label">{label}</span>{children}</label>
);
