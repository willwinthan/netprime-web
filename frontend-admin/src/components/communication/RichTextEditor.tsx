import React, { useRef, useState } from "react";
import { Bold, Italic, Link2, List, ListOrdered, Heading, Image as ImageIcon, Eye, Pencil, Code } from "lucide-react";
import { renderMarkdown } from "./markdown";

/** HTML produced by the server (escape-first Markdown or the allowlist sanitizer). */
export const SafeHtml: React.FC<{ html: string; style?: React.CSSProperties }> = ({ html, style }) => (
  <div className="np-rich-text" style={{ lineHeight: 1.65, wordBreak: "break-word", ...style }} dangerouslySetInnerHTML={{ __html: html }} />
);

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  /** Uploads an image and resolves to its URL; the toolbar shows an image button when given. */
  onUploadImage?: (file: File) => Promise<string>;
  label?: string;
}

/** Simple Markdown editor (toolbar + preview) used for broadcasts, announcements, posts and comments. */
export const RichTextEditor: React.FC<Props> = ({ value, onChange, placeholder, rows = 6, onUploadImage, label = "เนื้อหา" }) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wrap = (before: string, after = before, fallback = "ข้อความ") => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end) || fallback;
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };

  const prefixLines = (prefix: (i: number) => string) => {
    const el = ref.current;
    if (!el) return;
    const start = value.lastIndexOf("\n", el.selectionStart - 1) + 1;
    const end = el.selectionEnd;
    const block = value.slice(start, end) || "รายการ";
    const next = value.slice(0, start) + block.split("\n").map((line, i) => prefix(i) + line).join("\n") + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => el.focus());
  };

  const insertLink = () => {
    const url = window.prompt("ลิงก์ (https://...)", "https://");
    if (url && /^(https?:\/\/|\/|mailto:)/i.test(url.trim())) wrap("[", `](${url.trim()})`, "ข้อความลิงก์");
  };

  const upload = async (file: File | undefined) => {
    if (!file || !onUploadImage) return;
    try {
      setUploading(true);
      setError(null);
      const url = await onUploadImage(file);
      const el = ref.current;
      const at = el ? el.selectionStart : value.length;
      onChange(value.slice(0, at) + `\n![${file.name.replace(/[[\]]/g, "")}](${url})\n` + value.slice(at));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const tool = (title: string, icon: React.ReactNode, action: () => void) => (
    <button type="button" title={title} aria-label={title} onClick={action} disabled={preview}
      style={{ background: "none", border: "none", padding: "6px", borderRadius: "6px", cursor: preview ? "default" : "pointer", color: "var(--text-secondary)", opacity: preview ? 0.4 : 1 }}>
      {icon}
    </button>
  );

  return (
    <div style={{ border: "1px solid var(--border-subtle, rgba(0,0,0,0.12))", borderRadius: "10px", background: "#fff" }}>
      <div role="toolbar" aria-label="จัดรูปแบบข้อความ" style={{ display: "flex", gap: "2px", alignItems: "center", padding: "4px 6px", borderBottom: "1px solid rgba(0,0,0,0.06)", flexWrap: "wrap" }}>
        {tool("ตัวหนา", <Bold size={15} />, () => wrap("**"))}
        {tool("ตัวเอียง", <Italic size={15} />, () => wrap("*"))}
        {tool("หัวข้อ", <Heading size={15} />, () => prefixLines(() => "## "))}
        {tool("รายการ", <List size={15} />, () => prefixLines(() => "- "))}
        {tool("รายการตัวเลข", <ListOrdered size={15} />, () => prefixLines(i => `${i + 1}. `))}
        {tool("โค้ด", <Code size={15} />, () => wrap("`"))}
        {tool("ลิงก์", <Link2 size={15} />, insertLink)}
        {onUploadImage && tool(uploading ? "กำลังอัปโหลด…" : "แทรกรูป (ไม่เกิน 5 MB)", <ImageIcon size={15} />, () => fileRef.current?.click())}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => setPreview(p => !p)} className="tech-button-outline"
          style={{ padding: "3px 10px", fontSize: "12px", borderRadius: "99px", display: "inline-flex", gap: "4px", alignItems: "center" }}>
          {preview ? <><Pencil size={12} />แก้ไข</> : <><Eye size={12} />ดูตัวอย่าง</>}
        </button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={e => upload(e.target.files?.[0])} />
      </div>
      {preview ? (
        <div style={{ padding: "12px 14px", minHeight: `${rows * 22}px` }}>
          {value.trim() ? <SafeHtml html={renderMarkdown(value)} /> : <span style={{ color: "var(--text-muted)" }}>ยังไม่มีเนื้อหา</span>}
        </div>
      ) : (
        <textarea ref={ref} aria-label={label} value={value} rows={rows} placeholder={placeholder} onChange={e => onChange(e.target.value)}
          style={{ width: "100%", border: "none", outline: "none", resize: "vertical", padding: "12px 14px", fontFamily: "inherit", fontSize: "14px", borderRadius: "0 0 10px 10px", boxSizing: "border-box" }} />
      )}
      {error && <div role="alert" style={{ color: "var(--danger)", fontSize: "12px", padding: "0 14px 8px" }}>{error}</div>}
    </div>
  );
};
