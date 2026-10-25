// Page builder block model shared by the console editor and the public renderer.
// The server (backend/src/handlers/website.ts) is the source of truth for validation; these mirror its rules.

import type { DocBlock } from "../../site/BlockRenderer";

export interface PublicCourse {
  id: string; title: string; description: string | null; price: number; access_duration_days: number | null; lesson_count: number;
  cover_image_url?: string | null;
}

export type HeroBlock = { id: string; type: "hero"; heading: string; subheading?: string | null; image_url?: string | null; cta_label?: string | null; cta_href?: string | null; align?: "left" | "center"; tone?: "light" | "brand" | "dark" };
export type RichTextBlock = { id: string; type: "richtext"; doc: DocBlock[] };
export type ImageBlock = { id: string; type: "image"; url: string; alt?: string | null; caption?: string | null; link?: string | null; width?: "normal" | "wide" | "full" };
export type ImageTextBlock = { id: string; type: "image_text"; image_url: string; alt?: string | null; heading?: string | null; text?: string | null; image_side?: "left" | "right"; cta_label?: string | null; cta_href?: string | null };
export type FeaturesBlock = { id: string; type: "features"; heading?: string | null; intro?: string | null; columns?: number; items: Array<{ title: string; text?: string | null; image_url?: string | null; link?: string | null }> };
export type CoursesBlock = { id: string; type: "courses"; heading?: string | null; mode: "all" | "category" | "ids"; category_id?: string | null; course_ids?: string[]; limit?: number; courses?: PublicCourse[] };
export type TestimonialsBlock = { id: string; type: "testimonials"; heading?: string | null; items: Array<{ quote: string; name: string; role?: string | null; avatar_url?: string | null }> };
export type FaqBlock = { id: string; type: "faq"; heading?: string | null; items: Array<{ q: string; a: string }> };
export type CtaBlock = { id: string; type: "cta"; heading?: string | null; text?: string | null; label: string; href: string; style?: "primary" | "outline" | "dark" };
export type VideoBlock = { id: string; type: "video"; url: string; title?: string | null };
export type LeadFormBlock = { id: string; type: "lead_form"; form_id: string; heading?: string | null };

export type PageBlock = HeroBlock | RichTextBlock | ImageBlock | ImageTextBlock | FeaturesBlock | CoursesBlock | TestimonialsBlock | FaqBlock | CtaBlock | VideoBlock | LeadFormBlock;
export type BlockType = PageBlock["type"];

export const BLOCK_INFO: Record<BlockType, { label: string; description: string }> = {
  hero: { label: "ส่วนหัว (Hero)", description: "หัวข้อใหญ่ คำอธิบาย รูป และปุ่ม" },
  richtext: { label: "ข้อความ", description: "เขียนแบบ Notion: หัวข้อ รายการ ตาราง ลิงก์" },
  image: { label: "รูปภาพ", description: "รูปเดี่ยวพร้อมคำบรรยาย" },
  image_text: { label: "รูป + ข้อความ", description: "รูปด้านหนึ่ง ข้อความอีกด้าน" },
  features: { label: "คอลัมน์/จุดเด่น", description: "การ์ด 2–4 คอลัมน์" },
  courses: { label: "รายการคอร์ส", description: "แสดงคอร์สทั้งหมด ตามหมวด หรือเลือกเอง" },
  testimonials: { label: "รีวิวผู้เรียน", description: "คำรับรองจากผู้เรียนหรือองค์กร" },
  faq: { label: "คำถามที่พบบ่อย", description: "คำถาม–คำตอบแบบเปิดปิดได้" },
  cta: { label: "ปุ่มชวนคลิก (CTA)", description: "แถบเชิญชวนพร้อมปุ่ม" },
  video: { label: "วิดีโอ", description: "ฝังวิดีโอ YouTube หรือ Vimeo" },
  lead_form: { label: "ฟอร์มเก็บ lead", description: "ฝังฟอร์มจากเมนูการตลาด" }
};

export const BLOCK_ORDER: BlockType[] = ["hero", "richtext", "image", "image_text", "features", "courses", "testimonials", "faq", "cta", "video", "lead_form"];

const blockId = () => `blk_${Math.random().toString(36).slice(2, 12)}`;

export function newBlock(type: BlockType): PageBlock {
  const id = blockId();
  switch (type) {
    case "hero": return { id, type, heading: "หัวข้อหน้า", subheading: "คำอธิบายสั้น ๆ ว่าหน้านี้มีอะไร", cta_label: "ดูตารางอบรม", cta_href: "/schedule", align: "left", tone: "light" };
    case "richtext": return { id, type, doc: [] };
    case "image": return { id, type, url: "", alt: "", width: "wide" };
    case "image_text": return { id, type, image_url: "", heading: "หัวข้อ", text: "ข้อความ", image_side: "left" };
    case "features": return { id, type, heading: "จุดเด่น", columns: 3, items: [{ title: "จุดเด่นที่ 1", text: "รายละเอียด" }, { title: "จุดเด่นที่ 2", text: "รายละเอียด" }, { title: "จุดเด่นที่ 3", text: "รายละเอียด" }] };
    case "courses": return { id, type, heading: "คอร์สแนะนำ", mode: "all", limit: 6, course_ids: [] };
    case "testimonials": return { id, type, heading: "เสียงจากผู้เรียน", items: [{ quote: "เรียนแล้วเอาไปใช้งานได้จริง", name: "ชื่อผู้เรียน", role: "ตำแหน่ง/บริษัท" }] };
    case "faq": return { id, type, heading: "คำถามที่พบบ่อย", items: [{ q: "คำถาม", a: "คำตอบ" }] };
    case "cta": return { id, type, heading: "พร้อมเริ่มเรียนหรือยัง", text: "ลงทะเบียนรอบอบรมถัดไปได้เลย", label: "ลงทะเบียน", href: "/schedule", style: "primary" };
    case "video": return { id, type, url: "", title: "" };
    case "lead_form": return { id, type, form_id: "", heading: "" };
  }
}

/** Same allowlist as the server: YouTube and Vimeo over https. */
export function videoEmbed(value: string): { src: string; provider: "youtube" | "vimeo" } | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^www\.|^m\./, "");
  let id: string | null | undefined = null;
  if (host === "youtu.be") id = url.pathname.slice(1);
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id = url.pathname === "/watch" ? url.searchParams.get("v") : /^\/(embed|shorts|live)\/([^/]+)/.exec(url.pathname)?.[2];
  }
  if (id !== null && id !== undefined) {
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? { provider: "youtube", src: `https://www.youtube-nocookie.com/embed/${id}` } : null;
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const vimeo = /^\/(?:video\/)?(\d{5,12})(?:\/|$)/.exec(url.pathname)?.[1];
    return vimeo ? { provider: "vimeo", src: `https://player.vimeo.com/video/${vimeo}?dnt=1` } : null;
  }
  return null;
}

/** Same rules as the server's safeLink. */
export function isSafeLink(value: string | null | undefined): boolean {
  if (!value) return true;
  if (value.includes("\\") || /\s/.test(value)) return false;
  if (value.startsWith("#") || (value.startsWith("/") && !value.startsWith("//"))) return true;
  try { return ["http:", "https:", "mailto:"].includes(new URL(value).protocol); } catch { return false; }
}

export const slugify = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
