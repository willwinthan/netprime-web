/**
 * Course cover: pure helpers shared by the cover picker (no DOM, so `tests/cover.test.mjs` can run them
 * in Node). The drawing itself lives in coverTemplates.ts.
 */

/** Cover size in px (16:9). Everything is laid out in these logical units and scaled for previews. */
export const COVER_W = 1280;
export const COVER_H = 720;

export type CoverMode = "crop" | "contain";

export interface CoverSpec {
  /** Main title, usually the course name. */
  title: string;
  /** Second line, e.g. "สอนโดย อ.สมชาย" or the level. */
  subtitle: string;
  /** Small label above the title, e.g. "คอร์สใหม่". Empty hides it. */
  badge: string;
  /** Show the "netprime" wordmark in the corner. */
  showBrand: boolean;
}

export const COVER_LIMITS = { title: 90, subtitle: 70, badge: 24 } as const;

export interface CoverPalette {
  id: string;
  name: string;
  /** Darkest background colour. */
  dark: string;
  /** Lighter background colour for gradients. */
  mid: string;
  accent: string;
  accent2: string;
}

export const COVER_PALETTES: CoverPalette[] = [
  { id: "netprime", name: "ส้ม Netprime", dark: "#0f1115", mid: "#1d222b", accent: "#ff6a1a", accent2: "#ffb066" },
  { id: "ocean", name: "น้ำเงินทะเลลึก", dark: "#06182e", mid: "#0d3563", accent: "#2d9cff", accent2: "#8bd6ff" },
  { id: "emerald", name: "เขียวมรกต", dark: "#04221a", mid: "#0b4a37", accent: "#22c58b", accent2: "#9af2c9" },
  { id: "violet", name: "ม่วงไวโอเลต", dark: "#160e30", mid: "#2f1c63", accent: "#9b6dff", accent2: "#d2bcff" },
  { id: "rose", name: "ชมพูกุหลาบ", dark: "#26091a", mid: "#52143a", accent: "#ff5d8f", accent2: "#ffb4cd" },
  { id: "slate", name: "เทาเข้ม", dark: "#0e131b", mid: "#232d3b", accent: "#e5e7eb", accent2: "#9ca3af" }
];

export interface CoverTemplateInfo {
  id: string;
  name: string;
  hint: string;
  /** Light background, so text is drawn dark. */
  light?: boolean;
}

export const COVER_TEMPLATES: CoverTemplateInfo[] = [
  { id: "circuit", name: "วงจร", hint: "ลายวงจรอิเล็กทรอนิกส์ เหมาะกับคอร์สเครือข่าย" },
  { id: "nodes", name: "โหนดเครือข่าย", hint: "จุดและเส้นเชื่อมต่อกัน" },
  { id: "terminal", name: "เทอร์มินัล", hint: "หน้าต่างคำสั่ง เหมาะกับคอร์สสาย CLI / Automation" },
  { id: "wave", name: "คลื่น", hint: "คลื่นไล่ระดับสีนุ่มๆ" },
  { id: "block", name: "บล็อกเรขาคณิต", hint: "รูปทรงเรขาคณิตตัวหนา อ่านง่าย" },
  { id: "split", name: "แบ่งครึ่ง", hint: "แบ่งซ้ายขวาเฉียง ซ้ายตัวอักษร ขวาลวดลาย" },
  { id: "spotlight", name: "สปอตไลต์", hint: "แสงเรืองตรงกลาง ข้อความกึ่งกลาง" },
  { id: "minimal", name: "มินิมอล", hint: "พื้นขาวสะอาด แถบสีด้านบน", light: true }
];

export const DEFAULT_TEMPLATE_ID = COVER_TEMPLATES[0].id;
export const DEFAULT_PALETTE_ID = COVER_PALETTES[0].id;

export const findPalette = (id: string): CoverPalette => COVER_PALETTES.find(p => p.id === id) ?? COVER_PALETTES[0];
export const findTemplate = (id: string): CoverTemplateInfo => COVER_TEMPLATES.find(t => t.id === id) ?? COVER_TEMPLATES[0];

type SegmenterCtor = new (locale: string, options: { granularity: "word" | "grapheme" }) => { segment(text: string): Iterable<{ segment: string }> };
const segmenterCtor = (): SegmenterCtor | null => (typeof Intl !== "undefined" && (Intl as any).Segmenter ? ((Intl as any).Segmenter as SegmenterCtor) : null);

/** Split into the units a line may break between. Thai has no spaces, so use the word segmenter when there is one. */
export function tokenize(text: string): string[] {
  const Seg = segmenterCtor();
  if (Seg) return Array.from(new Seg("th", { granularity: "word" }).segment(text), s => s.segment);
  return text.split(/(\s+)/).filter(Boolean);
}

/** Cut to `max` characters without splitting a Thai vowel/tone mark from its consonant. */
export function clipText(text: string, max: number): string {
  const Seg = segmenterCtor();
  const units = Seg ? Array.from(new Seg("th", { granularity: "grapheme" }).segment(text), s => s.segment) : Array.from(text);
  return units.length <= max ? text : units.slice(0, max).join("");
}

const tidy = (value: unknown, max: number) => clipText(String(value ?? "").replace(/\s+/g, " ").trim(), max);

/** Trim, collapse whitespace and clamp the text fields; always returns a usable spec. */
export function normalizeCoverSpec(spec: Partial<CoverSpec>, fallbackTitle = "ชื่อคอร์ส"): CoverSpec {
  return {
    title: tidy(spec.title, COVER_LIMITS.title) || tidy(fallbackTitle, COVER_LIMITS.title) || "ชื่อคอร์ส",
    subtitle: tidy(spec.subtitle, COVER_LIMITS.subtitle),
    badge: tidy(spec.badge, COVER_LIMITS.badge),
    showBrand: spec.showBrand !== false
  };
}

/**
 * Greedy line wrap. A word wider than a whole line is cut by characters; text that needs more than
 * `maxLines` lines is cut and ends with "…".
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number, maxLines: number): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let line = "";
  const push = () => { if (line.trim()) lines.push(line.trim()); line = ""; };
  for (const token of tokenize(text)) {
    if (!line && !token.trim()) continue;
    if (measure((line + token).trimEnd()) <= maxWidth) { line += token; continue; }
    push();
    let rest = token.trimStart();
    // One word wider than the line: break it by characters.
    while (rest && measure(rest) > maxWidth) {
      const chars = Array.from(rest);
      let n = chars.length - 1;
      while (n > 1 && measure(chars.slice(0, n).join("")) > maxWidth) n--;
      lines.push(chars.slice(0, n).join(""));
      rest = chars.slice(n).join("");
    }
    line = rest;
  }
  push();
  if (lines.length <= maxLines) return { lines, truncated: false };
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && measure(`${last}…`) > maxWidth) last = Array.from(last).slice(0, -1).join("");
  kept[maxLines - 1] = `${last}…`;
  return { lines: kept, truncated: true };
}

/**
 * Largest title size (from `maxSize` down to `minSize`) at which the wrapped title fits `maxLines` lines
 * and `maxHeight`. `measureAt(size)` gives the measuring function for that font size.
 */
export function fitTitle(
  text: string, maxWidth: number, maxHeight: number, measureAt: (size: number) => (s: string) => number,
  opts: { maxSize?: number; minSize?: number; step?: number; maxLines?: number; lineHeight?: number } = {}
): { size: number; lines: string[]; lineHeight: number; truncated: boolean } {
  const { maxSize = 84, minSize = 44, step = 4, maxLines = 3, lineHeight = 1.22 } = opts;
  for (let size = maxSize; size >= minSize; size -= step) {
    const { lines, truncated } = wrapText(text, maxWidth, measureAt(size), maxLines);
    if (!truncated && lines.length * size * lineHeight <= maxHeight) return { size, lines, lineHeight, truncated: false };
  }
  const { lines, truncated } = wrapText(text, maxWidth, measureAt(minSize), maxLines);
  return { size: minSize, lines, lineHeight, truncated };
}

export interface DrawRect { dx: number; dy: number; dw: number; dh: number }

/**
 * Where to draw a picture on the cover. "crop" fills the whole cover (cutting the overflow, `focusX`/`focusY`
 * 0..1 choose which part stays); "contain" shows the whole picture centred.
 */
export function fitImage(srcW: number, srcH: number, mode: CoverMode, focusX = 0.5, focusY = 0.5, dstW = COVER_W, dstH = COVER_H): DrawRect {
  if (!(srcW > 0) || !(srcH > 0)) return { dx: 0, dy: 0, dw: dstW, dh: dstH };
  const scale = mode === "crop" ? Math.max(dstW / srcW, dstH / srcH) : Math.min(dstW / srcW, dstH / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  const clamp = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0.5));
  return mode === "crop"
    ? { dx: (dstW - dw) * clamp(focusX), dy: (dstH - dh) * clamp(focusY), dw, dh }
    : { dx: (dstW - dw) / 2, dy: (dstH - dh) / 2, dw, dh };
}

/** Small deterministic PRNG (mulberry32) so a template looks the same every time for the same seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export interface StockCover { id: string; label: string; keywords: string[]; url: string }

const unsplash = (photo: string) => `https://images.unsplash.com/${photo}?w=1280&auto=format&fit=crop&q=70`;

/** Ready-made pictures, the same ones the instructor dashboard already shows as the card fallback. */
export const STOCK_COVERS: StockCover[] = [
  { id: "network", label: "เครือข่ายทั่วไป", keywords: [], url: unsplash("photo-1550751827-4bd374c3f58b") },
  { id: "cisco", label: "Cisco / สวิตช์และเราเตอร์", keywords: ["cisco", "ccna", "ccnp"], url: unsplash("photo-1558494949-ef010cbdcc31") },
  { id: "cloud", label: "คลาวด์", keywords: ["aws", "cloud", "azure"], url: unsplash("photo-1451187580459-43490279c0fa") },
  { id: "datacenter", label: "Juniper / Aruba / Arista", keywords: ["juniper", "arista", "aruba"], url: unsplash("photo-1544197150-b99a580bb7a8") },
  { id: "security", label: "ความปลอดภัยไซเบอร์", keywords: ["security", "cyber", "fortinet", "zscaler"], url: unsplash("photo-1563986768609-322da13575f3") },
  { id: "serverless", label: "Serverless / Automation", keywords: ["cloudflare", "serverless", "automation", "python"], url: unsplash("photo-1618401471353-b98aedd07871") }
];

/** The stock picture that fits a course title best (first keyword hit), else the generic network one. */
export function suggestStockCover(title: string): StockCover {
  const lower = title.toLowerCase();
  return STOCK_COVERS.find(s => s.keywords.some(k => lower.includes(k))) ?? STOCK_COVERS[0];
}
