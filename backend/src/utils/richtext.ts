/**
 * Safe rich text for broadcasts, announcements, community posts and email templates.
 * - renderMarkdown(): a small Markdown subset rendered escape-first, so the output never contains
 *   markup the author typed (only the tags generated here).
 * - sanitizeHtml(): allowlist sanitizer for staff-authored HTML (email template bodies).
 */

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value: string) => value.replace(/[&<>"']/g, ch => ESCAPES[ch]);

/** True for http(s), mailto, site-relative and fragment links (checked on the unescaped text). */
export function isSafeUrl(url: string): boolean {
  const cleaned = url.replace(/[\u0000-\u0020\u007f-\u009f]/g, "").toLowerCase();
  return /^(https?:\/\/|mailto:|\/(?!\/)|#)/.test(cleaned);
}

function inline(text: string): string {
  // Code spans first, replaced by placeholders so their content is not formatted further.
  const codes: string[] = [];
  let out = text.replace(/[\u0000\u0001]/g, "").replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(`<code>${esc(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  const parts: string[] = [];
  // Images and links: [label](url) — the URL is checked before escaping.
  out = out.replace(/(!?)\[([^\]\n]{0,300})\]\(([^)\s]{1,2000})\)/g, (_m, bang: string, label: string, url: string) => {
    if (!isSafeUrl(url) || (bang && !/^https?:\/\//i.test(url) && !url.startsWith("/"))) return `\u0001${parts.push(esc(label)) - 1}\u0001`;
    const html = bang
      ? `<img src="${esc(url)}" alt="${esc(label)}" style="max-width:100%;height:auto;border-radius:8px">`
      : `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${formatEmphasis(esc(label))}</a>`;
    return `\u0001${parts.push(html) - 1}\u0001`;
  });
  out = formatEmphasis(esc(out));
  out = out.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => parts[Number(i)]);
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

function formatEmphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
}

/** Markdown subset: headings, paragraphs, line breaks, bold/italic/strike, code, links, images, lists, quotes, rules. */
export function renderMarkdown(markdown: string): string {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;
  let quote: string[] = [];
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) html.push(`<${list.type}>${list.items.map(i => `<li>${inline(i)}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) html.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
    quote = [];
  };
  const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };

  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) { html.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`); code = null; }
      else code.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) { flushAll(); code = []; continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) { flushAll(); const level = Math.min(heading[1].length + 1, 5); html.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushAll(); html.push("<hr>"); continue; }
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d{1,3}[.)]\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph(); flushQuote();
      const type = bullet ? "ul" : "ol";
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push((bullet || numbered)![1]);
      continue;
    }
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) { flushParagraph(); flushList(); quote.push(quoted[1]); continue; }
    if (!line.trim()) { flushAll(); continue; }
    flushList(); flushQuote();
    paragraph.push(line.trim());
  }
  if (code) html.push(`<pre><code>${esc((code as string[]).join("\n"))}</code></pre>`);
  flushAll();
  return html.join("\n");
}

/** Plain-text version (push, LINE, notification previews). */
export function markdownToText(markdown: string, max = 500): string {
  const text = String(markdown ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

// ---------- HTML sanitizer ----------

const ALLOWED_TAGS = new Set(["a", "b", "strong", "i", "em", "u", "s", "del", "p", "br", "hr", "div", "span", "h1", "h2", "h3", "h4", "h5",
  "ul", "ol", "li", "blockquote", "code", "pre", "img", "table", "thead", "tbody", "tr", "td", "th", "small", "sup", "sub", "center"]);
const VOID_TAGS = new Set(["br", "hr", "img"]);
const COMMON_ATTRS = new Set(["style", "align", "title"]);
const TAG_ATTRS: Record<string, string[]> = {
  a: ["href", "target"],
  img: ["src", "alt", "width", "height"],
  td: ["colspan", "rowspan", "width", "valign", "bgcolor"],
  th: ["colspan", "rowspan", "width", "valign", "bgcolor"],
  table: ["width", "cellpadding", "cellspacing", "border", "bgcolor", "role"]
};
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|noscript|template|svg|math|textarea|select|form|frameset|frame|head|title|xmp|plaintext)\b[\s\S]*?(<\/\1\s*>|$)/gi;

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_m, dec: string) => String.fromCodePoint(Math.min(parseInt(dec, 10), 0x10ffff)))
    .replace(/&(colon|tab|newline|lt|gt|quot|apos|amp);/gi, (_m, name: string) =>
      ({ colon: ":", tab: "\t", newline: "\n", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" } as Record<string, string>)[name.toLowerCase()]);
}

function cleanAttribute(tag: string, name: string, raw: string): string | null {
  const value = decodeEntities(raw);
  if (name === "href" || name === "src") {
    // Template placeholders such as {{link}} are allowed; their values are escaped at render time.
    if (/^\s*\{\{\s*[a-z_]+\s*\}\}\s*$/i.test(value)) return value.trim();
    if (!isSafeUrl(value)) return null;
    if (name === "src" && !/^\s*(https?:\/\/|\/(?!\/))/i.test(value)) return null;
    return value.trim();
  }
  if (name === "style") return /expression|javascript|vbscript|url\s*\(|@import|behavior|-moz-binding|[<>]/i.test(value) ? null : value;
  if (name === "target") return value === "_blank" ? "_blank" : null;
  void tag;
  return value.length > 500 ? value.slice(0, 500) : value;
}

/** Keeps only allowlisted tags/attributes; everything else becomes text or is dropped. */
export function sanitizeHtml(input: string): string {
  const source = String(input ?? "").replace(/<!--[\s\S]*?(-->|$)/g, "").replace(DROP_WITH_CONTENT, "");
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let out = "";
  let last = 0;
  for (let match = tagPattern.exec(source); match; match = tagPattern.exec(source)) {
    out += source.slice(last, match.index).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    last = tagPattern.lastIndex;
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) continue;
    if (closing) { if (!VOID_TAGS.has(tag)) out += `</${tag}>`; continue; }
    const allowed = new Set([...COMMON_ATTRS, ...(TAG_ATTRS[tag] || [])]);
    const attrs: string[] = [];
    const attrPattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (let a = attrPattern.exec(match[3]); a; a = attrPattern.exec(match[3])) {
      const name = a[1].toLowerCase();
      if (!allowed.has(name)) continue;
      const cleaned = cleanAttribute(tag, name, a[2] ?? a[3] ?? a[4] ?? "");
      if (cleaned === null) continue;
      attrs.push(`${name}="${esc(cleaned)}"`);
    }
    if (tag === "a") attrs.push('rel="noopener noreferrer"');
    out += `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>`;
  }
  out += source.slice(last).replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return out;
}
