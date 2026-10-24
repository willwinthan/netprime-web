/**
 * Notion → article import.
 * Reads a page shared with the NetPrime integration (official Notion API) and converts its blocks
 * into BlockNote editor blocks. Notion-hosted files are signed S3 URLs that expire after about an hour,
 * so images are copied into our own storage through the `rehost` callback.
 * The conversion functions are pure (no Workers globals) so tests can run them in Node.
 */

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const MAX_BLOCKS = 1500;
const MAX_DEPTH = 4;

export class NotionError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// ---------- Notion API shapes (only the fields we read) ----------

interface RichText {
  plain_text: string;
  href: string | null;
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; underline?: boolean; code?: boolean };
}
interface FileRef { type: "external" | "file"; external?: { url: string }; file?: { url: string } }
export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  children?: NotionBlock[];
  [key: string]: any;
}

// ---------- BlockNote shapes we emit ----------

type Styles = { bold?: true; italic?: true; underline?: true; strike?: true; code?: true };
type TextNode = { type: "text"; text: string; styles: Styles };
type LinkNode = { type: "link"; href: string; content: TextNode[] };
export type Inline = TextNode | LinkNode;
export interface EditorBlock {
  type: string;
  props?: Record<string, unknown>;
  content?: Inline[] | { type: "tableContent"; headerRows?: number; rows: { cells: Inline[][] }[] };
  children?: EditorBlock[];
}

/** Accepts notion.so / notion.site links or a bare ID; returns the dashed page UUID. */
export function notionPageId(input: string): string | null {
  const text = input.trim();
  let path = text;
  try {
    const url = new URL(text);
    if (!/(^|\.)notion\.(so|site)$/.test(url.hostname)) return null;
    path = url.pathname;
  } catch { /* not a URL: may be a raw ID */ }
  // Notion puts the ID at the end of the last path segment: /Page-Title-<32 hex> or a dashed UUID.
  const dashed = path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
  const compact = path.split("/").filter(Boolean).pop()?.match(/(?:^|-)([0-9a-f]{32})$/i);
  const hex = (dashed ? dashed[1].replace(/-/g, "") : compact?.[1])?.toLowerCase();
  if (!hex) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const safeHref = (href: string | null): string | null => {
  if (!href) return null;
  if (href.startsWith("/")) return `https://www.notion.so${href}`; // links to other Notion pages
  try { return ["http:", "https:", "mailto:"].includes(new URL(href).protocol) ? href : null; } catch { return null; }
};

export function convertRichText(items: RichText[] = []): Inline[] {
  const out: Inline[] = [];
  for (const item of items) {
    if (!item.plain_text) continue;
    const a = item.annotations || {};
    const styles: Styles = {};
    if (a.bold) styles.bold = true;
    if (a.italic) styles.italic = true;
    if (a.underline) styles.underline = true;
    if (a.strikethrough) styles.strike = true;
    if (a.code) styles.code = true;
    const text: TextNode = { type: "text", text: item.plain_text, styles };
    const href = safeHref(item.href);
    out.push(href ? { type: "link", href, content: [text] } : text);
  }
  return out;
}

const plain = (items: RichText[] = []) => items.map(i => i.plain_text).join("");
const fileUrl = (f?: FileRef) => f?.type === "external" ? f.external?.url : f?.file?.url;

/** Published Notion pages can be embedded with https://<workspace>.notion.site/ebd/<id>. */
export function notionEmbedUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".notion.site")) return null;
    const id = notionPageId(input);
    return id ? `https://${url.hostname}/ebd/${id.replace(/-/g, "")}` : null;
  } catch {
    return null;
  }
}

export interface ConvertContext {
  warnings: string[];
  /** Notion-hosted file URL → durable URL (or null to drop the image). */
  images: Map<string, string | null>;
}

/** Converts fetched Notion blocks (children already attached) into editor blocks. */
export function convertBlocks(blocks: NotionBlock[], ctx: ConvertContext): EditorBlock[] {
  const out: EditorBlock[] = [];
  for (const block of blocks) {
    const data = block[block.type] || {};
    // Table rows are read by the table case itself, not converted as standalone blocks.
    const children = block.type !== "table" && block.children?.length ? convertBlocks(block.children, ctx) : undefined;
    const rich = convertRichText(data.rich_text);
    const withChildren = (b: EditorBlock): EditorBlock => (children ? { ...b, children } : b);
    switch (block.type) {
      case "paragraph": out.push(withChildren({ type: "paragraph", content: rich })); break;
      case "heading_1": case "heading_2": case "heading_3": {
        const level = Number(block.type.slice(-1));
        if (data.is_toggleable) out.push(withChildren({ type: "heading", props: { level, isToggleable: true }, content: rich }));
        else { out.push({ type: "heading", props: { level }, content: rich }); if (children) out.push(...children); }
        break;
      }
      case "bulleted_list_item": out.push(withChildren({ type: "bulletListItem", content: rich })); break;
      case "numbered_list_item": out.push(withChildren({ type: "numberedListItem", content: rich })); break;
      case "to_do": out.push(withChildren({ type: "checkListItem", props: { checked: !!data.checked }, content: rich })); break;
      case "toggle": out.push(withChildren({ type: "toggleListItem", content: rich })); break;
      case "quote": out.push(withChildren({ type: "quote", content: rich })); break;
      case "callout": {
        const icon = data.icon?.type === "emoji" ? `${data.icon.emoji} ` : "";
        out.push(withChildren({ type: "quote", content: icon ? [{ type: "text", text: icon, styles: {} }, ...rich] : rich }));
        break;
      }
      case "code":
        out.push({ type: "codeBlock", props: { language: String(data.language || "text").toLowerCase() }, content: [{ type: "text", text: plain(data.rich_text), styles: {} }] });
        break;
      case "divider": out.push({ type: "divider" }); break;
      case "image": {
        const source = fileUrl(data);
        const url = source ? (ctx.images.has(source) ? ctx.images.get(source) : source) : null;
        if (url) out.push({ type: "image", props: { url, caption: plain(data.caption) } });
        else ctx.warnings.push("ข้ามรูปภาพที่คัดลอกไม่ได้ (เกิน 5 MB หรือไม่ใช่ PNG/JPG/WEBP/GIF)");
        break;
      }
      case "video": {
        const url = fileUrl(data);
        if (url && data.type === "external") out.push({ type: "paragraph", content: [{ type: "link", href: url, content: [{ type: "text", text: "ดูวิดีโอ", styles: {} }] }] });
        else ctx.warnings.push("ข้ามวิดีโอที่อัปโหลดไว้ใน Notion (ให้ใช้ลิงก์ YouTube แทน)");
        break;
      }
      case "bookmark": case "embed": case "link_preview": {
        const url = safeHref(data.url ?? null);
        const embed = url ? notionEmbedUrl(url) : null;
        if (embed) out.push({ type: "notionEmbed", props: { url } });
        else if (url) out.push({ type: "paragraph", content: [{ type: "link", href: url, content: [{ type: "text", text: plain(data.caption) || url, styles: {} }] }] });
        break;
      }
      case "table": {
        const rows = (block.children || []).filter(r => r.type === "table_row")
          .map(r => ({ cells: (r.table_row?.cells || []).map((cell: RichText[]) => convertRichText(cell)) }));
        if (rows.length) out.push({ type: "table", content: { type: "tableContent", headerRows: data.has_column_header ? 1 : undefined, rows } });
        break;
      }
      case "column_list": case "column": case "synced_block":
        if (children) out.push(...children); // flatten layout containers
        break;
      case "child_page":
        out.push({ type: "paragraph", content: [{ type: "text", text: `หน้าย่อย: ${data.title || ""}`, styles: { italic: true } }] });
        ctx.warnings.push(`หน้าย่อย "${data.title || ""}" ไม่ได้นำเข้า (นำเข้าแยกทีละหน้า)`);
        break;
      default:
        ctx.warnings.push(`ข้ามบล็อกชนิด ${block.type} ที่ยังไม่รองรับ`);
    }
  }
  return out;
}

/** Notion-hosted (expiring) image URLs in the tree, to copy before conversion. */
export function hostedImageUrls(blocks: NotionBlock[]): string[] {
  const urls: string[] = [];
  const walk = (list: NotionBlock[]) => list.forEach(b => {
    if (b.type === "image" && b.image?.type === "file" && b.image.file?.url) urls.push(b.image.file.url);
    if (b.children) walk(b.children);
  });
  walk(blocks);
  return urls;
}

export function pageTitle(page: any): string {
  const props = page?.properties || {};
  for (const key of Object.keys(props)) {
    if (props[key]?.type === "title") return plain(props[key].title).trim();
  }
  return "";
}

// ---------- Network ----------

async function notionFetch(path: string, token: string): Promise<any> {
  const res = await fetch(`${NOTION_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, accept: "application/json" }
  });
  if (res.ok) return res.json();
  if (res.status === 404 || res.status === 403) {
    throw new NotionError("ไม่พบหน้านี้ หรือยังไม่ได้แชร์หน้าให้ integration ของ NetPrime (ใน Notion: ⋯ → Connections → เพิ่ม NetPrime)", 404);
  }
  if (res.status === 401) throw new NotionError("NOTION_TOKEN ไม่ถูกต้องหรือหมดอายุ", 502);
  if (res.status === 429) throw new NotionError("Notion จำกัดจำนวนคำขอชั่วคราว กรุณาลองใหม่อีกครั้ง", 502);
  throw new NotionError(`Notion ตอบกลับผิดพลาด (${res.status})`, 502);
}

async function fetchChildren(id: string, token: string, depth: number, budget: { left: number }): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    const page = await notionFetch(`/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`, token);
    for (const block of page.results as NotionBlock[]) {
      if (budget.left-- <= 0) throw new NotionError(`หน้านี้ยาวเกิน ${MAX_BLOCKS} บล็อก กรุณาแบ่งเป็นหลายบทความ`, 400);
      if (block.has_children && depth < MAX_DEPTH && block.type !== "child_page" && block.type !== "child_database") {
        block.children = await fetchChildren(block.id, token, depth + 1, budget);
      }
      blocks.push(block);
    }
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

export interface ImportedPage {
  title: string;
  cover_url: string | null;
  notion_page_id: string;
  blocks: EditorBlock[];
  warnings: string[];
}

export async function importNotionPage(
  pageId: string,
  token: string,
  rehost: (bytes: ArrayBuffer, contentType: string) => Promise<string | null>
): Promise<ImportedPage> {
  const page = await notionFetch(`/pages/${pageId}`, token);
  const blocks = await fetchChildren(pageId, token, 0, { left: MAX_BLOCKS });
  const ctx: ConvertContext = { warnings: [], images: new Map() };

  const copy = async (source: string): Promise<string | null> => {
    try {
      const res = await fetch(source);
      if (!res.ok) return null;
      const type = (res.headers.get("content-type") || "").split(";")[0].trim();
      return await rehost(await res.arrayBuffer(), type);
    } catch {
      return null;
    }
  };
  for (const source of hostedImageUrls(blocks)) ctx.images.set(source, await copy(source));

  const coverSource = fileUrl(page.cover);
  const cover = !coverSource ? null : page.cover?.type === "file" ? await copy(coverSource) : coverSource;
  return {
    title: pageTitle(page) || "บทความจาก Notion",
    cover_url: cover,
    notion_page_id: pageId,
    blocks: convertBlocks(blocks, ctx),
    warnings: Array.from(new Set(ctx.warnings))
  };
}
