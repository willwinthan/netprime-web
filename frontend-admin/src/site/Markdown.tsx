import React from "react";

/**
 * Small Markdown subset for article bodies written in the content console:
 * ## / ### headings, paragraphs, - and 1. lists, > quotes, ``` code blocks, ![alt](url) images,
 * and inline **bold**, *italic*, `code`, [text](url). Output is React elements only (no HTML injection);
 * plain-text articles written before Markdown support render as paragraphs, as before.
 */

export type Block =
  | { type: "h2" | "h3"; text: string; id: string }
  | { type: "p" | "quote"; text: string }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "code"; text: string }
  | { type: "img"; alt: string; src: string };

const HEADING = /^(#{1,3})\s+(.+)$/;
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
const BULLET = /^\s*[-*]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

function startsBlock(line: string) {
  const t = line.trim();
  return t.startsWith("```") || HEADING.test(t) || IMAGE.test(t) || BULLET.test(line) || NUMBERED.test(line) || t.startsWith(">");
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let headings = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }
    if (trimmed.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      i++; // closing fence (or end of text)
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const heading = HEADING.exec(trimmed);
    if (heading) {
      blocks.push({ type: heading[1].length === 3 ? "h3" : "h2", text: heading[2].trim(), id: `section-${++headings}` });
      i++;
      continue;
    }
    const image = IMAGE.exec(trimmed);
    if (image) {
      blocks.push({ type: "img", alt: image[1], src: image[2] });
      i++;
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length && pattern.test(lines[i])) items.push(lines[i++].replace(pattern, ""));
      blocks.push({ type: ordered ? "ol" : "ul", items });
      continue;
    }
    if (trimmed.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) quote.push(lines[i++].trim().replace(/^>\s?/, ""));
      blocks.push({ type: "quote", text: quote.join("\n") });
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) paragraph.push(lines[i++]);
    blocks.push({ type: "p", text: paragraph.join("\n") });
  }
  return blocks;
}

/** Links may point to http(s), mailto, the site itself or an in-page anchor; never javascript: or data:. */
export function safeHref(url: string): string | null {
  if (url.includes("\\")) return null; // "/\evil.com" is read by browsers as "//evil.com"
  if (url.startsWith("#") || (url.startsWith("/") && !url.startsWith("//"))) return url;
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}

export function safeImage(url: string): string | null {
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  try {
    return ["http:", "https:"].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*)/g;

export function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    const token = match[0];
    if (match[1]) nodes.push(<code key={key++}>{token.slice(1, -1)}</code>);
    else if (match[2]) nodes.push(<strong key={key++}>{renderInline(token.slice(2, -2))}</strong>);
    else if (match[3]) {
      const [, label, url] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!;
      const href = safeHref(url);
      const external = href ? /^https?:/.test(href) && new URL(href).origin !== window.location.origin : false;
      nodes.push(href
        ? <a key={key++} href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{renderInline(label)}</a>
        : label);
    } else if (match[4]) nodes.push(<em key={key++}>{renderInline(token.slice(1, -1))}</em>);
    last = index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export const Markdown: React.FC<{ blocks: Block[] }> = ({ blocks }) => (
  <div className="ps-prose">
    {blocks.map((block, i) => {
      switch (block.type) {
        case "h2": return <h2 key={i} id={block.id}>{renderInline(block.text)}</h2>;
        case "h3": return <h3 key={i} id={block.id}>{renderInline(block.text)}</h3>;
        case "p": return <p key={i}>{renderInline(block.text)}</p>;
        case "quote": return <blockquote key={i}><p>{renderInline(block.text)}</p></blockquote>;
        case "ul": return <ul key={i}>{block.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}</ul>;
        case "ol": return <ol key={i}>{block.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}</ol>;
        case "code": return <pre key={i}><code>{block.text}</code></pre>;
        case "img": {
          const src = safeImage(block.src);
          return src ? <img key={i} src={src} alt={block.alt} loading="lazy" /> : null;
        }
      }
    })}
  </div>
);
