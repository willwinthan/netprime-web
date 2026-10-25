import { Context, Hono } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { permit } from "../utils/permissions";

/**
 * Website builder (website.design): custom pages (/p/:slug), header/footer menus, theme & branding,
 * and certificate templates with per-course overrides. Mounted at /api.
 *   Public:  /api/public/website/*   (theme, nav, published pages, resolved certificate template)
 *   Console: /api/website/*          (rbac + website.design)
 * Everything is stored as validated JSON; no HTML is accepted anywhere. The public site renders
 * text as text, links through safeHref and rich text through BlockRenderer.
 */
export const websiteRouter = new Hono<Env>();

// ==========================================
// Small validation toolkit
// ==========================================

class Invalid extends Error {}
const fail = (message: string): never => { throw new Invalid(message); };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Trimmed string or null; rejects non-strings and overlong values. */
function str(source: Obj, key: string, label: string, max: number, required = false): string | null {
  const raw = source[key];
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    if (required) fail(`กรุณากรอก${label}`);
    return null;
  }
  if (typeof raw !== "string") fail(`${label}ไม่ถูกต้อง`);
  const value = (raw as string).trim();
  if (value.length > max) fail(`${label}ยาวเกิน ${max} ตัวอักษร`);
  // Control characters (except tab/newline) never belong in site content.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${label}มีอักขระที่ไม่อนุญาต`);
  return value;
}

function oneOf<T extends string>(source: Obj, key: string, label: string, options: readonly T[], fallback: T): T {
  const raw = source[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (!options.includes(raw as T)) fail(`${label}ไม่ถูกต้อง`);
  return raw as T;
}

function int(source: Obj, key: string, label: string, min: number, max: number, fallback: number): number {
  const raw = source[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) fail(`${label}ต้องอยู่ระหว่าง ${min}–${max}`);
  return Math.round(n * 10) / 10;
}

function bool(source: Obj, key: string, fallback: boolean): boolean {
  const raw = source[key];
  if (raw === undefined || raw === null) return fallback;
  return raw === true || raw === 1 || raw === "1" || raw === "true";
}

/** Links: http(s), mailto, site paths (/x) or anchors (#x); never javascript:, data: or protocol-relative URLs. */
export function safeLink(value: string): boolean {
  if (value.includes("\\") || /\s/.test(value)) return false;
  if (value.startsWith("#") || (value.startsWith("/") && !value.startsWith("//"))) return true;
  try { return ["http:", "https:", "mailto:"].includes(new URL(value).protocol); } catch { return false; }
}

/** Images: https/http URLs or site paths only. */
export function safeImageUrl(value: string): boolean {
  if (value.includes("\\") || /\s/.test(value)) return false;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

function link(source: Obj, key: string, label: string, required = false): string | null {
  const value = str(source, key, label, 500, required);
  if (value && !safeLink(value)) fail(`${label}ต้องขึ้นต้นด้วย https:// หรือ /`);
  return value;
}

function image(source: Obj, key: string, label: string, required = false): string | null {
  const value = str(source, key, label, 500, required);
  if (value && !safeImageUrl(value)) fail(`${label}ต้องเป็นลิงก์รูปที่ขึ้นต้นด้วย https:// หรือ /`);
  return value;
}

function list(source: Obj, key: string, label: string, max: number): Obj[] {
  const raw = source[key];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(`${label}ไม่ถูกต้อง`);
  if ((raw as unknown[]).length > max) fail(`${label}ได้ไม่เกิน ${max} รายการ`);
  return (raw as unknown[]).map(item => isObj(item) ? item : fail(`${label}ไม่ถูกต้อง`));
}

const HEX = /^#[0-9a-fA-F]{6}$/;
function color(source: Obj, key: string, label: string, fallback: string): string {
  const raw = source[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string" || !HEX.test(raw)) fail(`${label}ต้องเป็นรหัสสีแบบ #RRGGBB`);
  return (raw as string).toLowerCase();
}

/** WCAG relative luminance contrast ratio between two #RRGGBB colors. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
const uniqueViolation = (error: unknown) => String((error as Error)?.message || "").includes("UNIQUE constraint failed");

async function readBody(c: Context<Env>): Promise<Obj> {
  const body = await c.req.json().catch(() => null);
  return isObj(body) ? body : {};
}

async function audit(c: Context<Env>, action: string, entity: string, entityId: string | null, detail?: unknown) {
  try {
    await c.env.DB.prepare("INSERT INTO admin_audit_log (id, user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(newId("log"), c.get("user")?.id ?? null, action, entity, entityId, detail === undefined ? null : JSON.stringify(detail).slice(0, 2000)).run();
  } catch (error) {
    console.error("Audit log write failed:", error);
  }
}

async function loadSetting<T>(db: D1Database, key: string): Promise<{ value: Partial<T> | null; updated_at: string | null }> {
  const row = await db.prepare("SELECT value, updated_at FROM site_settings WHERE key = ?").bind(key).first<{ value: string; updated_at: string }>();
  if (!row) return { value: null, updated_at: null };
  try { return { value: JSON.parse(row.value), updated_at: row.updated_at }; } catch {
    console.error(`site_settings.${key} is not valid JSON`);
    return { value: null, updated_at: null };
  }
}

async function saveSetting(c: Context<Env>, key: string, value: unknown) {
  await c.env.DB.prepare(`INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
    .bind(key, JSON.stringify(value), c.get("user").id).run();
}

/** Runs a validator; Invalid becomes a 400 with its Thai message, anything else propagates to the global handler. */
function validate<T>(fn: () => T): { value?: T; error?: string } {
  try { return { value: fn() }; } catch (error) {
    if (error instanceof Invalid) return { error: error.message };
    throw error;
  }
}

// ==========================================
// Theme & branding
// ==========================================

/** Thai-capable Google Fonts the site may load (Anuphan is the built-in default). */
export const FONTS = ["Anuphan", "IBM Plex Sans Thai", "Noto Sans Thai", "Sarabun", "Prompt", "Kanit"] as const;

export interface Theme {
  school_name: string; tagline: string | null; logo_url: string | null; favicon_url: string | null;
  primary_color: string; secondary_color: string; font: typeof FONTS[number]; radius: number;
}

export const DEFAULT_THEME: Theme = {
  school_name: "NetPrime", tagline: "ศูนย์ฝึกอบรมด้าน IT", logo_url: null, favicon_url: null,
  primary_color: "#c2541a", secondary_color: "#182443", font: "Anuphan", radius: 14
};

/** Buttons and links use the primary color with white text, headings use the secondary color on white: both need 4.5:1. */
export function parseTheme(body: Obj): Theme {
  const theme: Theme = {
    school_name: str(body, "school_name", "ชื่อโรงเรียน", 80, true)!,
    tagline: str(body, "tagline", "คำโปรย", 120),
    logo_url: image(body, "logo_url", "โลโก้"),
    favicon_url: image(body, "favicon_url", "ไอคอนเว็บ (favicon)"),
    primary_color: color(body, "primary_color", "สีหลัก", DEFAULT_THEME.primary_color),
    secondary_color: color(body, "secondary_color", "สีรอง", DEFAULT_THEME.secondary_color),
    font: oneOf(body, "font", "ฟอนต์", FONTS, DEFAULT_THEME.font),
    radius: Math.round(int(body, "radius", "ความมนของมุม", 0, 24, DEFAULT_THEME.radius))
  };
  const primary = contrastRatio(theme.primary_color, "#ffffff");
  if (primary < 4.5) fail(`สีหลักอ่อนเกินไป ตัวอักษรสีขาวบนปุ่มอ่านยาก (คอนทราสต์ ${primary.toFixed(2)}:1 ต้องอย่างน้อย 4.5:1) ลองเลือกสีที่เข้มขึ้น`);
  const secondary = contrastRatio(theme.secondary_color, "#ffffff");
  if (secondary < 4.5) fail(`สีรองอ่อนเกินไป ตัวอักษรบนพื้นขาวอ่านยาก (คอนทราสต์ ${secondary.toFixed(2)}:1 ต้องอย่างน้อย 4.5:1)`);
  return theme;
}

async function loadTheme(db: D1Database): Promise<{ theme: Theme; updated_at: string | null }> {
  const { value, updated_at } = await loadSetting<Theme>(db, "theme");
  if (!value) return { theme: DEFAULT_THEME, updated_at: null };
  // A stored document that no longer validates (rules tightened) falls back field by field.
  const result = validate(() => parseTheme({ ...DEFAULT_THEME, ...value }));
  return { theme: result.value ?? DEFAULT_THEME, updated_at };
}

// ==========================================
// Header/footer menus
// ==========================================

export interface NavItem { label: string; label_en: string | null; href: string; new_tab: boolean }
export interface Nav { header: NavItem[]; footer: NavItem[] }

export const DEFAULT_NAV: Nav = {
  header: [
    { label: "หลักสูตร", label_en: "Courses", href: "/courses", new_tab: false },
    { label: "ตารางอบรม", label_en: "Schedule", href: "/schedule", new_tab: false },
    { label: "บทความ", label_en: "Blog", href: "/blog", new_tab: false },
    { label: "เกี่ยวกับเรา", label_en: "About", href: "/about", new_tab: false }
  ],
  footer: []
};

function parseNavItems(source: Obj, key: "header" | "footer", label: string): NavItem[] {
  return list(source, key, label, key === "header" ? 8 : 16).map((item, i) => ({
    label: str(item, "label", `ชื่อเมนูรายการที่ ${i + 1}`, 40, true)!,
    label_en: str(item, "label_en", `ชื่อเมนูภาษาอังกฤษรายการที่ ${i + 1}`, 40),
    href: link(item, "href", `ลิงก์เมนูรายการที่ ${i + 1}`, true)!,
    new_tab: bool(item, "new_tab", false)
  }));
}

export function parseNav(body: Obj): Nav {
  return { header: parseNavItems(body, "header", "เมนูส่วนหัว"), footer: parseNavItems(body, "footer", "เมนูส่วนท้าย") };
}

async function loadNav(db: D1Database): Promise<{ nav: Nav; updated_at: string | null }> {
  const { value, updated_at } = await loadSetting<Nav>(db, "nav");
  if (!value) return { nav: DEFAULT_NAV, updated_at: null };
  const result = validate(() => parseNav(value as Obj));
  return { nav: result.value ?? DEFAULT_NAV, updated_at };
}

// ==========================================
// Page blocks
// ==========================================

export const BLOCK_TYPES = ["hero", "richtext", "image", "image_text", "features", "courses", "testimonials", "faq", "cta", "video", "lead_form"] as const;
type BlockType = typeof BLOCK_TYPES[number];
export type PageBlock = { id: string; type: BlockType } & Obj;

const MAX_BLOCKS = 60;
const MAX_BLOCKS_BYTES = 400_000;

/** YouTube / Vimeo only; returns the provider and video id the renderer builds the embed from. */
export function parseVideoUrl(value: string): { provider: "youtube" | "vimeo"; id: string } | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^www\.|^m\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.slice(1);
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? { provider: "youtube", id } : null;
  }
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const id = url.pathname === "/watch" ? url.searchParams.get("v") : /^\/(embed|shorts|live)\/([^/]+)/.exec(url.pathname)?.[2];
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? { provider: "youtube", id } : null;
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = /^\/(?:video\/)?(\d{5,12})(?:\/|$)/.exec(url.pathname)?.[1];
    return id ? { provider: "vimeo", id } : null;
  }
  return null;
}

/** BlockNote JSON (same format as articles.content_json): an array of objects; rendered by BlockRenderer. */
function richDoc(source: Obj): unknown[] {
  const doc = source.doc;
  if (doc === undefined || doc === null) return [];
  if (!Array.isArray(doc) || doc.some(b => !isObj(b) || typeof (b as Obj).type !== "string")) fail("เนื้อหาข้อความไม่ถูกต้อง");
  if (JSON.stringify(doc).length > 200_000) fail("เนื้อหาข้อความยาวเกินไป");
  return doc as unknown[];
}

function parseBlock(raw: Obj, index: number): PageBlock {
  const n = index + 1;
  const type = raw.type as BlockType;
  if (!BLOCK_TYPES.includes(type)) fail(`บล็อกที่ ${n}: ชนิดบล็อกไม่รองรับ`);
  const rawId = typeof raw.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : newId("blk");
  const base = { id: rawId, type };
  const at = (label: string) => `บล็อกที่ ${n}: ${label}`;
  switch (type) {
    case "hero":
      return {
        ...base, heading: str(raw, "heading", at("หัวข้อ"), 160, true), subheading: str(raw, "subheading", at("คำอธิบาย"), 500),
        image_url: image(raw, "image_url", at("รูปภาพ")), cta_label: str(raw, "cta_label", at("ข้อความปุ่ม"), 40),
        cta_href: link(raw, "cta_href", at("ลิงก์ปุ่ม")), align: oneOf(raw, "align", at("การจัดวาง"), ["left", "center"] as const, "left"),
        tone: oneOf(raw, "tone", at("โทนสี"), ["light", "brand", "dark"] as const, "light")
      };
    case "richtext":
      return { ...base, doc: richDoc(raw) };
    case "image":
      return {
        ...base, url: image(raw, "url", at("รูปภาพ"), true), alt: str(raw, "alt", at("คำอธิบายรูป"), 200),
        caption: str(raw, "caption", at("คำบรรยายใต้รูป"), 300), link: link(raw, "link", at("ลิงก์เมื่อคลิกรูป")),
        width: oneOf(raw, "width", at("ความกว้าง"), ["normal", "wide", "full"] as const, "wide")
      };
    case "image_text":
      return {
        ...base, image_url: image(raw, "image_url", at("รูปภาพ"), true), alt: str(raw, "alt", at("คำอธิบายรูป"), 200),
        heading: str(raw, "heading", at("หัวข้อ"), 160), text: str(raw, "text", at("ข้อความ"), 5000),
        image_side: oneOf(raw, "image_side", at("ตำแหน่งรูป"), ["left", "right"] as const, "left"),
        cta_label: str(raw, "cta_label", at("ข้อความปุ่ม"), 40), cta_href: link(raw, "cta_href", at("ลิงก์ปุ่ม"))
      };
    case "features":
      return {
        ...base, heading: str(raw, "heading", at("หัวข้อ"), 160), intro: str(raw, "intro", at("คำอธิบาย"), 500),
        columns: Math.round(int(raw, "columns", at("จำนวนคอลัมน์"), 2, 4, 3)),
        items: list(raw, "items", at("รายการ"), 12).map((item, i) => ({
          title: str(item, "title", at(`หัวข้อรายการที่ ${i + 1}`), 120, true), text: str(item, "text", at(`ข้อความรายการที่ ${i + 1}`), 1000),
          image_url: image(item, "image_url", at(`รูปรายการที่ ${i + 1}`)), link: link(item, "link", at(`ลิงก์รายการที่ ${i + 1}`))
        }))
      };
    case "courses": {
      const mode = oneOf(raw, "mode", at("วิธีเลือกคอร์ส"), ["all", "category", "ids"] as const, "all");
      const ids = list({ ids: Array.isArray(raw.course_ids) ? (raw.course_ids as unknown[]).map(id => ({ id })) : raw.course_ids }, "ids", at("คอร์สที่เลือก"), 24)
        .map(item => str(item, "id", at("รหัสคอร์ส"), 80, true)!);
      const category = str(raw, "category_id", at("หมวดหมู่"), 80);
      if (mode === "category" && !category) fail(at("กรุณาเลือกหมวดหมู่"));
      if (mode === "ids" && !ids.length) fail(at("กรุณาเลือกคอร์สอย่างน้อย 1 คอร์ส"));
      return {
        ...base, heading: str(raw, "heading", at("หัวข้อ"), 160), mode, category_id: mode === "category" ? category : null,
        course_ids: mode === "ids" ? ids : [], limit: Math.round(int(raw, "limit", at("จำนวนคอร์ส"), 1, 24, 6))
      };
    }
    case "testimonials":
      return {
        ...base, heading: str(raw, "heading", at("หัวข้อ"), 160),
        items: list(raw, "items", at("รีวิว"), 12).map((item, i) => ({
          quote: str(item, "quote", at(`ข้อความรีวิวที่ ${i + 1}`), 1000, true), name: str(item, "name", at(`ชื่อผู้รีวิวที่ ${i + 1}`), 80, true),
          role: str(item, "role", at(`ตำแหน่งผู้รีวิวที่ ${i + 1}`), 120), avatar_url: image(item, "avatar_url", at(`รูปผู้รีวิวที่ ${i + 1}`))
        }))
      };
    case "faq":
      return {
        ...base, heading: str(raw, "heading", at("หัวข้อ"), 160),
        items: list(raw, "items", at("คำถาม"), 30).map((item, i) => ({
          q: str(item, "q", at(`คำถามที่ ${i + 1}`), 300, true), a: str(item, "a", at(`คำตอบที่ ${i + 1}`), 3000, true)
        }))
      };
    case "cta":
      return {
        ...base, heading: str(raw, "heading", at("หัวข้อ"), 160), text: str(raw, "text", at("ข้อความ"), 500),
        label: str(raw, "label", at("ข้อความปุ่ม"), 40, true), href: link(raw, "href", at("ลิงก์ปุ่ม"), true),
        style: oneOf(raw, "style", at("รูปแบบปุ่ม"), ["primary", "outline", "dark"] as const, "primary")
      };
    case "video": {
      const url = str(raw, "url", at("ลิงก์วิดีโอ"), 500, true)!;
      if (!parseVideoUrl(url)) fail(at("รองรับเฉพาะลิงก์ YouTube หรือ Vimeo (https://)"));
      return { ...base, url, title: str(raw, "title", at("ชื่อวิดีโอ"), 160) };
    }
    case "lead_form": {
      const formId = str(raw, "form_id", at("รหัสฟอร์ม"), 80, true)!;
      if (!/^[A-Za-z0-9_-]+$/.test(formId)) fail(at("รหัสฟอร์มไม่ถูกต้อง"));
      return { ...base, form_id: formId, heading: str(raw, "heading", at("หัวข้อ"), 160) };
    }
  }
  return fail(at("ชนิดบล็อกไม่รองรับ"));
}

export function parseBlocks(raw: unknown, label = "บล็อก"): PageBlock[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(`${label}ไม่ถูกต้อง`);
  const items = raw as unknown[];
  if (items.length > MAX_BLOCKS) fail(`หน้าหนึ่งมีได้ไม่เกิน ${MAX_BLOCKS} บล็อก`);
  if (JSON.stringify(items).length > MAX_BLOCKS_BYTES) fail("เนื้อหาหน้านี้ใหญ่เกินไป");
  const blocks = items.map((b, i) => isObj(b) ? parseBlock(b, i) : fail(`บล็อกที่ ${i + 1} ไม่ถูกต้อง`));
  const seen = new Set<string>();
  for (const b of blocks) { if (seen.has(b.id)) b.id = newId("blk"); seen.add(b.id); }
  return blocks;
}

// ==========================================
// Pages
// ==========================================

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Paths the SPA already owns; a custom page lives under /p/ but similar names would confuse menus. */
const RESERVED_SLUGS = new Set(["admin", "api", "dashboard", "preview", "new"]);

interface PageRow {
  id: string; slug: string; title: string; title_en: string | null; status: "draft" | "published";
  blocks_json: string; blocks_en_json: string | null; seo_title: string | null; seo_description: string | null; og_image_url: string | null;
  published_title: string | null; published_title_en: string | null; published_blocks_json: string | null; published_blocks_en_json: string | null;
  published_seo_json: string | null; show_in_nav: number; show_in_footer: number; sort_order: number; published_at: string | null;
  created_at: string; updated_at: string; updated_by_name?: string | null;
}

const parseJson = <T,>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
};

function adminPage(row: PageRow) {
  const draftKey = JSON.stringify([row.title, row.title_en, row.blocks_json, row.blocks_en_json, row.seo_title, row.seo_description, row.og_image_url]);
  const publishedKey = row.published_blocks_json === null ? null : JSON.stringify([row.published_title, row.published_title_en,
    row.published_blocks_json, row.published_blocks_en_json, ...seoTuple(row.published_seo_json)]);
  return {
    id: row.id, slug: row.slug, title: row.title, title_en: row.title_en, status: row.status,
    blocks: parseJson<PageBlock[]>(row.blocks_json, []), blocks_en: row.blocks_en_json ? parseJson<PageBlock[]>(row.blocks_en_json, []) : null,
    seo_title: row.seo_title, seo_description: row.seo_description, og_image_url: row.og_image_url,
    show_in_nav: !!row.show_in_nav, show_in_footer: !!row.show_in_footer, sort_order: row.sort_order,
    published_at: row.published_at, created_at: row.created_at, updated_at: row.updated_at, updated_by_name: row.updated_by_name ?? null,
    has_unpublished_changes: row.status === "published" && draftKey !== publishedKey
  };
}

function seoTuple(json: string | null): [string | null, string | null, string | null] {
  const seo = parseJson<{ seo_title?: string | null; seo_description?: string | null; og_image_url?: string | null }>(json, {});
  return [seo.seo_title ?? null, seo.seo_description ?? null, seo.og_image_url ?? null];
}

function parsePageFields(body: Obj, partial: boolean) {
  const values: Record<string, unknown> = {};
  const has = (k: string) => !partial || body[k] !== undefined;
  if (has("title")) values.title = str(body, "title", "ชื่อหน้า", 160, true);
  if (has("title_en")) values.title_en = str(body, "title_en", "ชื่อหน้าภาษาอังกฤษ", 160);
  if (has("slug")) {
    const slug = str(body, "slug", "ลิงก์หน้า (slug)", 80, true)!.toLowerCase();
    if (!SLUG_RE.test(slug)) fail("ลิงก์หน้า (slug) ใช้ได้เฉพาะ a-z 0-9 และขีดกลาง เช่น corporate-training");
    if (RESERVED_SLUGS.has(slug)) fail("ลิงก์หน้านี้สงวนไว้สำหรับระบบ กรุณาใช้ชื่ออื่น");
    values.slug = slug;
  }
  if (has("blocks")) values.blocks_json = JSON.stringify(parseBlocks(body.blocks));
  if (has("blocks_en")) values.blocks_en_json = body.blocks_en === null || body.blocks_en === undefined ? null : JSON.stringify(parseBlocks(body.blocks_en, "บล็อกภาษาอังกฤษ"));
  if (has("seo_title")) values.seo_title = str(body, "seo_title", "ชื่อสำหรับ SEO", 70);
  if (has("seo_description")) values.seo_description = str(body, "seo_description", "คำอธิบายสำหรับ SEO", 300);
  if (has("og_image_url")) values.og_image_url = image(body, "og_image_url", "รูปสำหรับแชร์ (OG image)");
  if (has("show_in_nav")) values.show_in_nav = bool(body, "show_in_nav", false) ? 1 : 0;
  if (has("show_in_footer")) values.show_in_footer = bool(body, "show_in_footer", false) ? 1 : 0;
  if (has("sort_order")) values.sort_order = int(body, "sort_order", "ลำดับ", 0, 10_000, 0);
  return values;
}

const PAGE_SELECT = `SELECT p.*, u.name AS updated_by_name FROM site_pages p LEFT JOIN users u ON u.id = p.updated_by`;

/** Course cards for a "courses" block, resolved server-side so visitors only ever see published courses. */
async function resolveCourses(db: D1Database, block: PageBlock) {
  const limit = Number(block.limit) || 6;
  const columns = `c.id, c.title, c.description, c.price, c.cover_image_url, c.access_duration_days,
    (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS lesson_count`;
  if (block.mode === "ids") {
    const ids = (block.course_ids as string[]).slice(0, 24);
    if (!ids.length) return [];
    const rows = await db.prepare(`SELECT ${columns} FROM courses c WHERE c.status = 'published' AND c.id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids).all<{ id: string }>();
    // Keep the order the editor chose.
    return ids.map(id => rows.results.find(r => r.id === id)).filter(Boolean).slice(0, limit);
  }
  if (block.mode === "category") {
    return (await db.prepare(`SELECT ${columns} FROM courses c WHERE c.status = 'published' AND c.category_id = ? ORDER BY c.title LIMIT ?`)
      .bind(block.category_id, limit).all()).results;
  }
  return (await db.prepare(`SELECT ${columns} FROM courses c WHERE c.status = 'published' ORDER BY c.title LIMIT ?`).bind(limit).all()).results;
}

async function withCourses(db: D1Database, blocks: PageBlock[]): Promise<PageBlock[]> {
  return Promise.all(blocks.map(async b => b.type === "courses" ? { ...b, courses: await resolveCourses(db, b) } : b));
}

// ==========================================
// Certificate templates
// ==========================================

type Align = "left" | "center" | "right";
interface TextSlot { x: number; y: number; size: number; align: Align; visible: boolean }
export interface CertificateConfig {
  orientation: "landscape" | "portrait";
  background_url: string | null; logo_url: string | null; font: typeof FONTS[number]; show_border: boolean;
  colors: { primary: string; text: string; muted: string; border: string };
  texts: { title: string; subtitle: string; intro: string; body: string; issuer: string };
  slots: Record<typeof SLOT_KEYS[number], TextSlot>;
  qr: { x: number; y: number; size: number; visible: boolean };
  signatures: Array<{ image_url: string | null; name: string; title: string | null }>;
  signatures_y: number;
}

export const SLOT_KEYS = ["logo", "title", "subtitle", "intro", "name", "body", "course", "date", "code", "verify_url"] as const;

const slot = (x: number, y: number, size: number, align: Align = "center", visible = true): TextSlot => ({ x, y, size, align, visible });

export const DEFAULT_CERTIFICATE: CertificateConfig = {
  orientation: "landscape", background_url: null, logo_url: null, font: "Anuphan", show_border: true,
  colors: { primary: "#e56b25", text: "#0f172a", muted: "#475569", border: "#e56b25" },
  texts: {
    title: "ใบประกาศนียบัตร", subtitle: "Certificate of Completion", intro: "ขอมอบใบประกาศนียบัตรฉบับนี้เพื่อแสดงว่า",
    body: "ได้เรียนจบและผ่านการประเมินของหลักสูตร", issuer: "NetPrime"
  },
  slots: {
    logo: slot(50, 12, 18), title: slot(50, 24, 30), subtitle: slot(50, 31, 11), intro: slot(50, 39, 14), name: slot(50, 47, 32),
    body: slot(50, 58, 14), course: slot(50, 64, 22), date: slot(12, 82, 11, "left"), code: slot(12, 86, 11, "left"), verify_url: slot(12, 90, 9, "left")
  },
  qr: { x: 88, y: 84, size: 24, visible: true },
  signatures: [{ image_url: null, name: "คณะกรรมการ NetPrime", title: null }],
  signatures_y: 84
};

export function parseCertificateConfig(raw: unknown): CertificateConfig {
  const body = isObj(raw) ? raw : {};
  const colors = isObj(body.colors) ? body.colors : {};
  const texts = isObj(body.texts) ? body.texts : {};
  const slots = isObj(body.slots) ? body.slots : {};
  const qr = isObj(body.qr) ? body.qr : {};
  const d = DEFAULT_CERTIFICATE;
  const parsedSlots = {} as CertificateConfig["slots"];
  for (const key of SLOT_KEYS) {
    const s = isObj(slots[key]) ? slots[key] as Obj : {};
    const def = d.slots[key];
    parsedSlots[key] = {
      x: int(s, "x", `ตำแหน่งแนวนอน (${key})`, 0, 100, def.x), y: int(s, "y", `ตำแหน่งแนวตั้ง (${key})`, 0, 100, def.y),
      size: int(s, "size", `ขนาด (${key})`, 6, 96, def.size), align: oneOf(s, "align", `การจัดวาง (${key})`, ["left", "center", "right"] as const, def.align),
      visible: bool(s, "visible", def.visible)
    };
  }
  return {
    orientation: oneOf(body, "orientation", "แนวกระดาษ", ["landscape", "portrait"] as const, d.orientation),
    background_url: image(body, "background_url", "ภาพพื้นหลัง"),
    logo_url: image(body, "logo_url", "โลโก้"),
    font: oneOf(body, "font", "ฟอนต์", FONTS, d.font),
    show_border: bool(body, "show_border", d.show_border),
    colors: {
      primary: color(colors, "primary", "สีหลัก", d.colors.primary), text: color(colors, "text", "สีตัวอักษร", d.colors.text),
      muted: color(colors, "muted", "สีตัวอักษรรอง", d.colors.muted), border: color(colors, "border", "สีกรอบ", d.colors.border)
    },
    texts: {
      title: str(texts, "title", "หัวเรื่อง", 120) ?? d.texts.title, subtitle: str(texts, "subtitle", "หัวเรื่องรอง", 120) ?? "",
      intro: str(texts, "intro", "ข้อความนำ", 300) ?? "", body: str(texts, "body", "ข้อความก่อนชื่อคอร์ส", 300) ?? "",
      issuer: str(texts, "issuer", "ชื่อผู้ออกใบประกาศ", 120) ?? d.texts.issuer
    },
    slots: parsedSlots,
    qr: {
      x: int(qr, "x", "ตำแหน่ง QR แนวนอน", 0, 100, d.qr.x), y: int(qr, "y", "ตำแหน่ง QR แนวตั้ง", 0, 100, d.qr.y),
      size: int(qr, "size", "ขนาด QR (มม.)", 12, 60, d.qr.size), visible: bool(qr, "visible", d.qr.visible)
    },
    signatures: list(body, "signatures", "ผู้ลงนาม", 3).map((s, i) => ({
      image_url: image(s, "image_url", `ลายเซ็นที่ ${i + 1}`), name: str(s, "name", `ชื่อผู้ลงนามที่ ${i + 1}`, 120, true)!,
      title: str(s, "title", `ตำแหน่งผู้ลงนามที่ ${i + 1}`, 120)
    })),
    signatures_y: int(body, "signatures_y", "ตำแหน่งแนวตั้งของลายเซ็น", 0, 100, d.signatures_y)
  };
}

interface TemplateRow { id: string; name: string; is_default: number; config_json: string; created_at: string; updated_at: string; course_count?: number }

function templateOut(row: TemplateRow) {
  const config = validate(() => parseCertificateConfig(parseJson(row.config_json, {}))).value ?? DEFAULT_CERTIFICATE;
  return { id: row.id, name: row.name, is_default: !!row.is_default, config, created_at: row.created_at, updated_at: row.updated_at, course_count: row.course_count ?? 0 };
}

/** Course override → default template → built-in design. */
async function resolveTemplate(db: D1Database, courseId: string | null) {
  const row = (courseId ? await db.prepare(`SELECT t.* FROM course_certificate_templates ct JOIN certificate_templates t ON t.id = ct.template_id
      WHERE ct.course_id = ?`).bind(courseId).first<TemplateRow>() : null)
    ?? await db.prepare("SELECT * FROM certificate_templates WHERE is_default = 1").first<TemplateRow>();
  return row ? { id: row.id, name: row.name, config: templateOut(row).config, source: courseId && !row.is_default ? "course" : "default" }
    : { id: null, name: "แบบมาตรฐาน", config: DEFAULT_CERTIFICATE, source: "builtin" };
}

// ==========================================
// PUBLIC ROUTES  (/api/public/website/*)
// ==========================================

const publicCache = (c: Context<Env>, seconds: number) => c.header("Cache-Control", `public, max-age=${seconds}`);

/** Branding for the public site and console chrome. Cached briefly at the edge and in browsers. */
websiteRouter.get("/public/website/theme", async (c) => {
  const { theme, updated_at } = await loadTheme(c.env.DB);
  publicCache(c, 300);
  return c.json({ theme, fonts: FONTS, updated_at });
});

/** Header/footer menus plus published custom pages flagged for the nav or footer. */
websiteRouter.get("/public/website/nav", async (c) => {
  const { nav } = await loadNav(c.env.DB);
  const pages = await c.env.DB.prepare(`SELECT slug, COALESCE(published_title, title) AS title, published_title_en AS title_en, show_in_nav, show_in_footer
    FROM site_pages WHERE status = 'published' AND (show_in_nav = 1 OR show_in_footer = 1) ORDER BY sort_order, created_at LIMIT 40`)
    .all<{ slug: string; title: string; title_en: string | null; show_in_nav: number; show_in_footer: number }>();
  publicCache(c, 120);
  return c.json({
    nav,
    pages: pages.results.map(p => ({ slug: p.slug, path: `/p/${p.slug}`, title: p.title, title_en: p.title_en, show_in_nav: !!p.show_in_nav, show_in_footer: !!p.show_in_footer }))
  });
});

/** Published custom pages (sitemap). */
websiteRouter.get("/public/website/pages", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT slug, COALESCE(published_title, title) AS title, published_at, updated_at FROM site_pages
    WHERE status = 'published' ORDER BY sort_order, created_at LIMIT 500`).all();
  publicCache(c, 300);
  return c.json({ pages: rows.results });
});

websiteRouter.get("/public/website/pages/:slug", async (c) => {
  const slug = c.req.param("slug").toLowerCase();
  if (!SLUG_RE.test(slug)) return c.json({ error: "ไม่พบหน้านี้" }, 404);
  const row = await c.env.DB.prepare("SELECT * FROM site_pages WHERE slug = ? AND status = 'published'").bind(slug).first<PageRow>();
  if (!row || row.published_blocks_json === null) return c.json({ error: "ไม่พบหน้านี้" }, 404);
  const [seo_title, seo_description, og_image_url] = seoTuple(row.published_seo_json);
  const db = c.env.DB;
  const enBlocks = row.published_blocks_en_json ? parseJson<PageBlock[]>(row.published_blocks_en_json, []) : null;
  publicCache(c, 60);
  return c.json({
    page: {
      slug: row.slug, title: row.published_title ?? row.title, title_en: row.published_title_en,
      seo_title, seo_description, og_image_url, published_at: row.published_at,
      blocks: await withCourses(db, parseJson<PageBlock[]>(row.published_blocks_json, [])),
      blocks_en: enBlocks && enBlocks.length ? await withCourses(db, enBlocks) : null
    }
  });
});

/**
 * Certificate design for printing and the public verification page.
 * GET /api/public/website/certificate-template?course_id=…  or  ?code=NP-…
 */
websiteRouter.get("/public/website/certificate-template", async (c) => {
  const db = c.env.DB;
  let courseId = (c.req.query("course_id") || "").trim().slice(0, 80) || null;
  const code = (c.req.query("code") || "").trim().toUpperCase().slice(0, 80);
  if (!courseId && code) {
    const cert = await db.prepare("SELECT course_id FROM certificates WHERE certificate_code = ?").bind(code).first<{ course_id: string }>();
    courseId = cert?.course_id ?? null;
  }
  publicCache(c, 300);
  return c.json({ template: await resolveTemplate(db, courseId) });
});

// ==========================================
// CONSOLE ROUTES  (/api/website/*, website.design)
// ==========================================

websiteRouter.use("/website/*", rbac(), permit("website.design"));
websiteRouter.use("/website/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

// ---------- Theme ----------

websiteRouter.get("/website/theme", async (c) => {
  const { theme, updated_at } = await loadTheme(c.env.DB);
  return c.json({ theme, defaults: DEFAULT_THEME, fonts: FONTS, updated_at });
});

websiteRouter.put("/website/theme", async (c) => {
  const body = sanitizeKeys(Object.keys(DEFAULT_THEME), await readBody(c));
  const { value: theme, error } = validate(() => parseTheme(body));
  if (error || !theme) return c.json({ error: error || "ข้อมูลไม่ถูกต้อง" }, 400);
  await saveSetting(c, "theme", theme);
  await audit(c, "update", "settings", "theme");
  return c.json({ theme });
});

// ---------- Navigation ----------

websiteRouter.get("/website/nav", async (c) => {
  const { nav, updated_at } = await loadNav(c.env.DB);
  return c.json({ nav, defaults: DEFAULT_NAV, updated_at });
});

websiteRouter.put("/website/nav", async (c) => {
  const body = await readBody(c);
  const { value: nav, error } = validate(() => parseNav(body));
  if (error || !nav) return c.json({ error: error || "ข้อมูลไม่ถูกต้อง" }, 400);
  await saveSetting(c, "nav", nav);
  await audit(c, "update", "settings", "nav");
  return c.json({ nav });
});

// ---------- Pages ----------

websiteRouter.get("/website/pages", async (c) => {
  const rows = await c.env.DB.prepare(`${PAGE_SELECT} ORDER BY p.sort_order, p.created_at`).all<PageRow>();
  return c.json({ pages: rows.results.map(r => { const { blocks, blocks_en, ...rest } = adminPage(r); return { ...rest, block_count: blocks.length, has_english: !!blocks_en?.length }; }) });
});

websiteRouter.get("/website/pages/:id", async (c) => {
  const row = await c.env.DB.prepare(`${PAGE_SELECT} WHERE p.id = ?`).bind(c.req.param("id")).first<PageRow>();
  if (!row) return c.json({ error: "ไม่พบหน้านี้" }, 404);
  return c.json({ page: adminPage(row) });
});

/** Draft preview with course lists resolved, exactly as visitors would see it after publishing. */
websiteRouter.post("/website/pages/preview", async (c) => {
  const body = await readBody(c);
  const { value: blocks, error } = validate(() => parseBlocks(body.blocks));
  if (error || !blocks) return c.json({ error: error || "ข้อมูลไม่ถูกต้อง" }, 400);
  return c.json({ blocks: await withCourses(c.env.DB, blocks) });
});

websiteRouter.post("/website/pages", async (c) => {
  const body = await readBody(c);
  const { value, error } = validate(() => parsePageFields(body, false));
  if (error || !value) return c.json({ error: error || "ข้อมูลไม่ถูกต้อง" }, 400);
  const id = newId("page");
  const userId = c.get("user").id;
  const max = await c.env.DB.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM site_pages").first<{ next: number }>();
  try {
    await c.env.DB.prepare(`INSERT INTO site_pages (id, slug, title, title_en, blocks_json, blocks_en_json, seo_title, seo_description, og_image_url,
      show_in_nav, show_in_footer, sort_order, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, value.slug, value.title, value.title_en, value.blocks_json, value.blocks_en_json, value.seo_title, value.seo_description,
        value.og_image_url, value.show_in_nav, value.show_in_footer, body.sort_order === undefined ? max?.next ?? 0 : value.sort_order, userId, userId).run();
  } catch (e) {
    if (uniqueViolation(e)) return c.json({ error: "ลิงก์หน้านี้ (slug) ถูกใช้แล้ว กรุณาใช้ชื่ออื่น" }, 409);
    throw e;
  }
  await audit(c, "create", "page", id, { slug: value.slug });
  const row = await c.env.DB.prepare(`${PAGE_SELECT} WHERE p.id = ?`).bind(id).first<PageRow>();
  return c.json({ page: adminPage(row!) }, 201);
});

websiteRouter.patch("/website/pages/:id", async (c) => {
  const id = c.req.param("id");
  const body = await readBody(c);
  const { value, error } = validate(() => parsePageFields(body, true));
  if (error || !value) return c.json({ error: error || "ข้อมูลไม่ถูกต้อง" }, 400);
  const existing = await c.env.DB.prepare("SELECT id, updated_at FROM site_pages WHERE id = ?").bind(id).first<{ id: string; updated_at: string }>();
  if (!existing) return c.json({ error: "ไม่พบหน้านี้" }, 404);
  // Optional optimistic check: the editor sends the updated_at it loaded.
  if (typeof body.expected_updated_at === "string" && body.expected_updated_at !== existing.updated_at) {
    return c.json({ error: "มีคนแก้หน้านี้ระหว่างที่คุณแก้ไข กรุณาโหลดใหม่ก่อนบันทึก", conflict: true }, 409);
  }
  const keys = Object.keys(value);
  if (keys.length) {
    try {
      // Bumps updated_at with a millisecond timestamp so two saves within one second still differ.
      await c.env.DB.prepare(`UPDATE site_pages SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_by = ?,
        updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?`).bind(...keys.map(k => value[k]), c.get("user").id, id).run();
    } catch (e) {
      if (uniqueViolation(e)) return c.json({ error: "ลิงก์หน้านี้ (slug) ถูกใช้แล้ว กรุณาใช้ชื่ออื่น" }, 409);
      throw e;
    }
    await audit(c, "update", "page", id, { fields: keys });
  }
  const row = await c.env.DB.prepare(`${PAGE_SELECT} WHERE p.id = ?`).bind(id).first<PageRow>();
  return c.json({ page: adminPage(row!) });
});

websiteRouter.post("/website/pages/:id/publish", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM site_pages WHERE id = ?").bind(id).first<PageRow>();
  if (!row) return c.json({ error: "ไม่พบหน้านี้" }, 404);
  // Re-validate stored drafts so content saved under older rules cannot go live unchecked.
  const { error } = validate(() => { parseBlocks(parseJson(row.blocks_json, [])); if (row.blocks_en_json) parseBlocks(parseJson(row.blocks_en_json, [])); });
  if (error) return c.json({ error }, 400);
  if (parseJson<unknown[]>(row.blocks_json, []).length === 0) return c.json({ error: "เพิ่มเนื้อหาอย่างน้อย 1 บล็อกก่อนเผยแพร่" }, 400);
  await c.env.DB.prepare(`UPDATE site_pages SET status = 'published', published_title = title, published_title_en = title_en,
    published_blocks_json = blocks_json, published_blocks_en_json = blocks_en_json,
    published_seo_json = json_object('seo_title', seo_title, 'seo_description', seo_description, 'og_image_url', og_image_url),
    published_at = COALESCE(published_at, CURRENT_TIMESTAMP), updated_by = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?`)
    .bind(c.get("user").id, id).run();
  await audit(c, "publish", "page", id, { slug: row.slug });
  return c.json({ page: adminPage((await c.env.DB.prepare(`${PAGE_SELECT} WHERE p.id = ?`).bind(id).first<PageRow>())!) });
});

websiteRouter.post("/website/pages/:id/unpublish", async (c) => {
  const id = c.req.param("id");
  const result = await c.env.DB.prepare(`UPDATE site_pages SET status = 'draft', updated_by = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?`)
    .bind(c.get("user").id, id).run();
  if (!result.meta.changes) return c.json({ error: "ไม่พบหน้านี้" }, 404);
  await audit(c, "unpublish", "page", id);
  return c.json({ page: adminPage((await c.env.DB.prepare(`${PAGE_SELECT} WHERE p.id = ?`).bind(id).first<PageRow>())!) });
});

/** POST /api/website/pages/reorder { ids: [...] } — the given order becomes sort_order 0..n. */
websiteRouter.post("/website/pages/reorder", async (c) => {
  const body = await readBody(c);
  const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === "string").slice(0, 500) : [];
  if (!ids.length) return c.json({ error: "กรุณาระบุลำดับหน้า" }, 400);
  await c.env.DB.batch(ids.map((id, i) => c.env.DB.prepare("UPDATE site_pages SET sort_order = ? WHERE id = ?").bind(i, id)));
  await audit(c, "reorder", "page", null, { count: ids.length });
  return c.json({ message: "บันทึกลำดับแล้ว" });
});

websiteRouter.delete("/website/pages/:id", async (c) => {
  const result = await c.env.DB.prepare("DELETE FROM site_pages WHERE id = ?").bind(c.req.param("id")).run();
  if (!result.meta.changes) return c.json({ error: "ไม่พบหน้านี้" }, 404);
  await audit(c, "delete", "page", c.req.param("id"));
  return c.json({ message: "ลบหน้าแล้ว" });
});

/** Published courses and categories for the "รายการคอร์ส" block picker. */
websiteRouter.get("/website/course-options", async (c) => {
  const [courses, categories] = await Promise.all([
    c.env.DB.prepare("SELECT id, title, category_id FROM courses WHERE status = 'published' ORDER BY title LIMIT 500").all(),
    c.env.DB.prepare("SELECT id, name FROM course_categories ORDER BY sort_order, name LIMIT 200").all()
  ]);
  return c.json({ courses: courses.results, categories: categories.results });
});

// ---------- Images (logo, backgrounds, block images) ----------

const IMAGE_TYPES: Record<string, { ext: string; magic: number[] }> = {
  "image/png": { ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  "image/jpeg": { ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  "image/gif": { ext: "gif", magic: [0x47, 0x49, 0x46, 0x38] },
  "image/webp": { ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] }
};

/** Same storage as /api/admin/site/images (R2 site/, served by /api/public/images/:name); SVG is refused. */
websiteRouter.post("/website/images", async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!(file instanceof File)) return c.json({ error: "กรุณาเลือกไฟล์รูปภาพ" }, 400);
  const type = IMAGE_TYPES[file.type];
  if (!type) return c.json({ error: "รองรับเฉพาะไฟล์ PNG, JPG, WEBP หรือ GIF" }, 400);
  if (file.size > 5 * 1024 * 1024) return c.json({ error: "ไฟล์รูปต้องไม่เกิน 5 MB" }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!type.magic.every((byte, i) => bytes[i] === byte)) return c.json({ error: "ไฟล์ไม่ใช่รูปภาพตามชนิดที่ระบุ" }, 400);
  const name = `${crypto.randomUUID().replace(/-/g, "")}.${type.ext}`;
  await c.env.ASSETS.put(`site/${name}`, bytes, { httpMetadata: { contentType: file.type } });
  await audit(c, "upload", "image", name, { size: file.size });
  return c.json({ url: `${new URL(c.req.url).origin}/api/public/images/${name}` }, 201);
});

// ---------- Certificate templates ----------

const TEMPLATE_SELECT = `SELECT t.*, (SELECT COUNT(*) FROM course_certificate_templates ct WHERE ct.template_id = t.id) AS course_count FROM certificate_templates t`;

websiteRouter.get("/website/certificate-templates", async (c) => {
  const rows = await c.env.DB.prepare(`${TEMPLATE_SELECT} ORDER BY t.is_default DESC, t.created_at`).all<TemplateRow>();
  return c.json({ templates: rows.results.map(templateOut), builtin: DEFAULT_CERTIFICATE, fonts: FONTS });
});

/** Courses with their override (for the per-course picker). Declared before /:id. */
websiteRouter.get("/website/certificate-templates/courses", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT c.id, c.title, c.status, ct.template_id FROM courses c
    LEFT JOIN course_certificate_templates ct ON ct.course_id = c.id WHERE c.status != 'archived' OR ct.template_id IS NOT NULL ORDER BY c.title LIMIT 500`).all();
  return c.json({ courses: rows.results });
});

/** PUT /api/website/certificate-templates/courses/:courseId { template_id | null } */
websiteRouter.put("/website/certificate-templates/courses/:courseId", async (c) => {
  const courseId = c.req.param("courseId");
  const body = await readBody(c);
  const db = c.env.DB;
  const course = await db.prepare("SELECT id FROM courses WHERE id = ?").bind(courseId).first();
  if (!course) return c.json({ error: "ไม่พบคอร์ส" }, 404);
  const templateId = typeof body.template_id === "string" && body.template_id ? body.template_id : null;
  if (!templateId) {
    await db.prepare("DELETE FROM course_certificate_templates WHERE course_id = ?").bind(courseId).run();
  } else {
    const template = await db.prepare("SELECT id FROM certificate_templates WHERE id = ?").bind(templateId).first();
    if (!template) return c.json({ error: "ไม่พบแม่แบบใบประกาศ" }, 404);
    await db.prepare(`INSERT INTO course_certificate_templates (course_id, template_id) VALUES (?, ?)
      ON CONFLICT(course_id) DO UPDATE SET template_id = excluded.template_id, updated_at = CURRENT_TIMESTAMP`).bind(courseId, templateId).run();
  }
  await audit(c, "assign", "certificate_template", templateId, { course_id: courseId });
  return c.json({ template: await resolveTemplate(db, courseId) });
});

websiteRouter.get("/website/certificate-templates/:id", async (c) => {
  const row = await c.env.DB.prepare(`${TEMPLATE_SELECT} WHERE t.id = ?`).bind(c.req.param("id")).first<TemplateRow>();
  if (!row) return c.json({ error: "ไม่พบแม่แบบใบประกาศ" }, 404);
  return c.json({ template: templateOut(row) });
});

function parseTemplateBody(body: Obj, partial: boolean) {
  const values: { name?: string; config_json?: string; is_default?: number } = {};
  if (!partial || body.name !== undefined) values.name = str(body, "name", "ชื่อแม่แบบ", 120, true)!;
  if (!partial || body.config !== undefined) values.config_json = JSON.stringify(parseCertificateConfig(body.config));
  if (body.is_default !== undefined) values.is_default = bool(body, "is_default", false) ? 1 : 0;
  return values;
}

websiteRouter.post("/website/certificate-templates", async (c) => {
  const body = await readBody(c);
  const { value, error } = validate(() => parseTemplateBody(body, false));
  if (error || !value) return c.json({ error: error || "ข้อมูลไม่ถูกต้อง" }, 400);
  const db = c.env.DB;
  const id = newId("ctpl");
  const first = !(await db.prepare("SELECT id FROM certificate_templates LIMIT 1").first());
  const makeDefault = value.is_default === 1 || first;
  await db.batch([
    ...(makeDefault ? [db.prepare("UPDATE certificate_templates SET is_default = 0 WHERE is_default = 1")] : []),
    db.prepare("INSERT INTO certificate_templates (id, name, is_default, config_json, created_by) VALUES (?, ?, ?, ?, ?)")
      .bind(id, value.name, makeDefault ? 1 : 0, value.config_json, c.get("user").id)
  ]);
  await audit(c, "create", "certificate_template", id, { name: value.name });
  return c.json({ template: templateOut((await db.prepare(`${TEMPLATE_SELECT} WHERE t.id = ?`).bind(id).first<TemplateRow>())!) }, 201);
});

websiteRouter.patch("/website/certificate-templates/:id", async (c) => {
  const id = c.req.param("id");
  const body = await readBody(c);
  const { value, error } = validate(() => parseTemplateBody(body, true));
  if (error || !value) return c.json({ error: error || "ข้อมูลไม่ถูกต้อง" }, 400);
  const db = c.env.DB;
  const existing = await db.prepare("SELECT is_default FROM certificate_templates WHERE id = ?").bind(id).first<{ is_default: number }>();
  if (!existing) return c.json({ error: "ไม่พบแม่แบบใบประกาศ" }, 404);
  if (value.is_default === 0 && existing.is_default) return c.json({ error: "ต้องมีแม่แบบเริ่มต้น 1 แบบ เลือกแม่แบบอื่นเป็นค่าเริ่มต้นแทน" }, 400);
  const statements: D1PreparedStatement[] = [];
  if (value.is_default === 1 && !existing.is_default) statements.push(db.prepare("UPDATE certificate_templates SET is_default = 0 WHERE is_default = 1"));
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (value.name !== undefined) { sets.push("name = ?"); binds.push(value.name); }
  if (value.config_json !== undefined) { sets.push("config_json = ?"); binds.push(value.config_json); }
  if (value.is_default !== undefined) { sets.push("is_default = ?"); binds.push(value.is_default); }
  if (sets.length) statements.push(db.prepare(`UPDATE certificate_templates SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(...binds, id));
  if (statements.length) await db.batch(statements);
  await audit(c, "update", "certificate_template", id);
  return c.json({ template: templateOut((await db.prepare(`${TEMPLATE_SELECT} WHERE t.id = ?`).bind(id).first<TemplateRow>())!) });
});

websiteRouter.delete("/website/certificate-templates/:id", async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;
  const existing = await db.prepare("SELECT is_default FROM certificate_templates WHERE id = ?").bind(id).first<{ is_default: number }>();
  if (!existing) return c.json({ error: "ไม่พบแม่แบบใบประกาศ" }, 404);
  const others = await db.prepare("SELECT COUNT(*) AS n FROM certificate_templates WHERE id != ?").bind(id).first<{ n: number }>();
  if (existing.is_default && (others?.n ?? 0) > 0) return c.json({ error: "ลบแม่แบบเริ่มต้นไม่ได้ เลือกแม่แบบอื่นเป็นค่าเริ่มต้นก่อน" }, 400);
  // Course overrides go with it (ON DELETE CASCADE plus an explicit delete for databases without FK enforcement).
  await db.batch([
    db.prepare("DELETE FROM course_certificate_templates WHERE template_id = ?").bind(id),
    db.prepare("DELETE FROM certificate_templates WHERE id = ?").bind(id)
  ]);
  await audit(c, "delete", "certificate_template", id);
  return c.json({ message: "ลบแม่แบบแล้ว" });
});

// ==========================================
// Body helpers
// ==========================================

function sanitizeKeys(keys: string[], body: Obj): Obj {
  return Object.fromEntries(keys.filter(k => body[k] !== undefined).map(k => [k, body[k]]));
}
