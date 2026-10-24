import React from "react";
import { safeHref, safeImage } from "./Markdown";
import { notionEmbedUrl } from "./notionEmbed";

/**
 * Renders BlockNote document JSON (articles.content_json) on the public site without
 * loading the editor. Only known block types and safe URLs are rendered; nothing is
 * injected as HTML.
 */

interface Styles { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; code?: boolean; textColor?: string; backgroundColor?: string }
type Inline = { type: "text"; text: string; styles?: Styles } | { type: "link"; href: string; content: Inline[] | string };
export interface DocBlock {
  id?: string;
  type: string;
  props?: Record<string, any>;
  content?: Inline[] | string | { type: "tableContent"; rows: { cells: any[] }[] };
  children?: DocBlock[];
}

export function parseDocument(json: string | null | undefined): DocBlock[] | null {
  if (!json) return null;
  try {
    const doc = JSON.parse(json);
    return Array.isArray(doc) && doc.length ? doc : null;
  } catch {
    return null;
  }
}

const headingId = (block: DocBlock, index: number) => `section-${block.id ?? index}`;

const plainText = (content: DocBlock["content"]): string => Array.isArray(content)
  ? content.map(i => i.type === "text" ? i.text : plainText(i.content as Inline[])).join("")
  : typeof content === "string" ? content : "";

/** Level 1–2 headings for the table of contents (rendered as h2/h3). */
export function documentOutline(blocks: DocBlock[]): { id: string; text: string }[] {
  return blocks.flatMap((b, i) => b.type === "heading" && (b.props?.level ?? 1) <= 2 && plainText(b.content).trim()
    ? [{ id: headingId(b, i), text: plainText(b.content).trim() }] : []);
}

/** Word count source for reading time. */
export function documentText(blocks: DocBlock[]): string {
  return blocks.map(b => `${plainText(b.content)} ${b.children ? documentText(b.children) : ""}`).join("\n");
}

const COLORS: Record<string, string> = {
  gray: "#787774", brown: "#9f6b53", red: "#d44c47", orange: "#d9730d", yellow: "#cb912f",
  green: "#448361", blue: "#337ea9", purple: "#9065b0", pink: "#c14c8a"
};
const BACKGROUNDS: Record<string, string> = {
  gray: "#f1f1ef", brown: "#f4eeee", red: "#fdebec", orange: "#fbecdd", yellow: "#fbf3db",
  green: "#edf3ec", blue: "#e7f3f8", purple: "#f6f3f9", pink: "#faf1f5"
};

function renderInline(content: DocBlock["content"]): React.ReactNode {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content.map((item, i) => {
    if (item.type === "link") {
      const href = safeHref(item.href);
      const inner = renderInline(item.content as Inline[]);
      if (!href) return <React.Fragment key={i}>{inner}</React.Fragment>;
      const external = /^https?:/.test(href) && new URL(href).origin !== window.location.origin;
      return <a key={i} href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{inner}</a>;
    }
    if (item.type !== "text") return null;
    const s = item.styles || {};
    let node: React.ReactNode = item.text;
    if (s.code) node = <code>{node}</code>;
    if (s.bold) node = <strong>{node}</strong>;
    if (s.italic) node = <em>{node}</em>;
    if (s.underline) node = <u>{node}</u>;
    if (s.strike) node = <s>{node}</s>;
    const style: React.CSSProperties = {};
    if (s.textColor && COLORS[s.textColor]) style.color = COLORS[s.textColor];
    if (s.backgroundColor && BACKGROUNDS[s.backgroundColor]) style.background = BACKGROUNDS[s.backgroundColor];
    return Object.keys(style).length ? <span key={i} style={style}>{node}</span> : <React.Fragment key={i}>{node}</React.Fragment>;
  });
}

function blockStyle(block: DocBlock): React.CSSProperties | undefined {
  const p = block.props || {};
  const style: React.CSSProperties = {};
  if (["center", "right", "justify"].includes(p.textAlignment)) style.textAlign = p.textAlignment;
  if (p.textColor && COLORS[p.textColor]) style.color = COLORS[p.textColor];
  if (p.backgroundColor && BACKGROUNDS[p.backgroundColor]) { style.background = BACKGROUNDS[p.backgroundColor]; style.borderRadius = 6; style.padding = "2px 6px"; }
  return Object.keys(style).length ? style : undefined;
}

const Children: React.FC<{ blocks?: DocBlock[] }> = ({ blocks }) =>
  blocks?.length ? <div className="ps-doc-children"><BlockList blocks={blocks} /></div> : null;

function renderTable(block: DocBlock, key: React.Key) {
  const content = block.content as { rows?: { cells: any[] }[]; headerRows?: number } | undefined;
  const rows = content?.rows ?? [];
  if (!rows.length) return null;
  const headerRows = content?.headerRows ?? 0;
  // Cells are inline arrays in older documents and { type: "tableCell", content } objects in newer ones.
  const cell = (c: any) => renderInline(Array.isArray(c) ? c : c?.content ?? []);
  return (
    <div key={key} className="ps-doc-table">
      <table>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>{row.cells.map((c, j) => r < headerRows ? <th key={j}>{cell(c)}</th> : <td key={j}>{cell(c)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderBlock(block: DocBlock, index: number): React.ReactNode {
  const key = block.id ?? index;
  const style = blockStyle(block);
  const p = block.props || {};
  switch (block.type) {
    case "paragraph":
      return <React.Fragment key={key}><p style={style}>{renderInline(block.content)}</p><Children blocks={block.children} /></React.Fragment>;
    case "heading": {
      const level = Math.min(Math.max(Number(p.level) || 1, 1), 3);
      const Tag = (["h2", "h3", "h4"] as const)[level - 1];
      const heading = <Tag id={headingId(block, index)} style={style}>{renderInline(block.content)}</Tag>;
      if (p.isToggleable) return <details key={key} className="ps-doc-toggle"><summary>{heading}</summary><Children blocks={block.children} /></details>;
      return <React.Fragment key={key}>{heading}<Children blocks={block.children} /></React.Fragment>;
    }
    case "quote":
      return <blockquote key={key} style={style}><p>{renderInline(block.content)}</p><Children blocks={block.children} /></blockquote>;
    case "codeBlock":
      return <pre key={key} data-language={p.language || undefined}><code>{plainText(block.content)}</code></pre>;
    case "checkListItem":
      return (
        <div key={key} className="ps-doc-check" style={style}>
          <input type="checkbox" checked={!!p.checked} readOnly disabled aria-label={p.checked ? "ทำแล้ว" : "ยังไม่ทำ"} />
          <span className={p.checked ? "done" : undefined}>{renderInline(block.content)}</span>
          <Children blocks={block.children} />
        </div>
      );
    case "toggleListItem":
      return <details key={key} className="ps-doc-toggle"><summary style={style}>{renderInline(block.content)}</summary><Children blocks={block.children} /></details>;
    case "image": {
      const src = typeof p.url === "string" ? safeImage(p.url) : null;
      if (!src) return null;
      return (
        <figure key={key} className="ps-doc-figure" style={{ textAlign: p.textAlignment === "left" ? "left" : "center" }}>
          <img src={src} alt={p.caption || p.name || ""} loading="lazy" style={p.previewWidth ? { width: Math.min(Number(p.previewWidth), 720) } : undefined} />
          {p.caption && <figcaption>{p.caption}</figcaption>}
        </figure>
      );
    }
    case "table":
      return renderTable(block, key);
    case "divider":
      return <hr key={key} />;
    case "notionEmbed": {
      const embed = notionEmbedUrl(p.url || "");
      const href = safeHref(p.url || "");
      if (!embed) return href ? <p key={key}><a href={href} target="_blank" rel="noopener noreferrer">เปิดหน้า Notion</a></p> : null;
      return (
        <div key={key} className="np-embed ps-doc-embed">
          <iframe src={embed} title="เนื้อหาจาก Notion" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" />
          <div className="np-embed-bar"><a href={href!} target="_blank" rel="noopener noreferrer">เปิดใน Notion ↗</a></div>
        </div>
      );
    }
    default:
      // Unknown block types (future editor features) degrade to their text.
      return plainText(block.content) ? <p key={key}>{renderInline(block.content)}</p> : null;
  }
}

/** Groups consecutive list items into <ul>/<ol> like the editor shows them. */
const BlockList: React.FC<{ blocks: DocBlock[] }> = ({ blocks }) => {
  const out: React.ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const type = blocks[i].type;
    if (type === "bulletListItem" || type === "numberedListItem") {
      const items: DocBlock[] = [];
      while (i < blocks.length && blocks[i].type === type) items.push(blocks[i++]);
      i--;
      const List = type === "bulletListItem" ? "ul" : "ol";
      const start = type === "numberedListItem" ? Number(items[0].props?.start) || undefined : undefined;
      out.push(
        <List key={items[0].id ?? i} start={start}>
          {items.map((item, j) => <li key={item.id ?? j} style={blockStyle(item)}>{renderInline(item.content)}<Children blocks={item.children} /></li>)}
        </List>
      );
    } else {
      out.push(renderBlock(blocks[i], i));
    }
  }
  return <>{out}</>;
};

export const BlockRenderer: React.FC<{ blocks: DocBlock[] }> = ({ blocks }) => (
  <div className="ps-prose ps-doc"><BlockList blocks={blocks} /></div>
);
