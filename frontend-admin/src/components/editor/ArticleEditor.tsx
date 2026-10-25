import React, { useEffect, useMemo, useRef, useState } from "react";
import "@blocknote/ariakit/style.css";
import "./editor.css";
import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from "@blocknote/core/extensions";
import { createReactBlockSpec, getDefaultReactSlashMenuItems, SuggestionMenuController, useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/ariakit";
import { ArrowLeft, ImagePlus, Download, Settings2, Trash2, X, ExternalLink, History, RotateCcw, AlertTriangle } from "lucide-react";
import { API_BASE_URL, can, useApi } from "../../hooks/useApi";
import { ErrorBox, Modal, Field, uploadImage, formatDateTime } from "../site-admin/ui";
import { notionEmbedUrl } from "../../site/notionEmbed";
import { thaiDictionary } from "./thaiDictionary";
import { useDangerousDelete } from "../security/DangerConfirmDialog";

// ==========================================
// Editor schema: default blocks (minus uploads we cannot store) + Notion embed
// ==========================================

const NotionEmbedView: React.FC<{ url: string; editable: boolean; onChange: (url: string) => void }> = ({ url, editable, onChange }) => {
  const [value, setValue] = useState(url);
  const embed = notionEmbedUrl(url);
  if (!embed) {
    return (
      <div className="np-embed-empty" contentEditable={false}>
        <strong>ฝังหน้า Notion</strong>
        <span>ใน Notion เลือก Share → Publish แล้วคัดลอกลิงก์ที่ลงท้ายด้วย .notion.site มาวาง</span>
        {editable && (
          <form onSubmit={e => { e.preventDefault(); onChange(value.trim()); }} style={{ display: "flex", gap: 8, width: "100%" }}>
            <input value={value} onChange={e => setValue(e.target.value)} placeholder="https://ชื่อทีม.notion.site/..." aria-label="ลิงก์หน้า Notion ที่เผยแพร่" />
            <button type="submit">ฝัง</button>
          </form>
        )}
        {url && <span className="np-embed-error">ลิงก์นี้ฝังไม่ได้ ต้องเป็นหน้า Notion ที่เผยแพร่แล้ว (*.notion.site)</span>}
      </div>
    );
  }
  return (
    <div className="np-embed" contentEditable={false}>
      <iframe src={embed} title="หน้า Notion" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" />
      <div className="np-embed-bar">
        <a href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> เปิดใน Notion</a>
        {editable && <button type="button" onClick={() => onChange("")}>เปลี่ยนลิงก์</button>}
      </div>
    </div>
  );
};

const NotionEmbedBlock = createReactBlockSpec(
  { type: "notionEmbed", propSchema: { url: { default: "" } }, content: "none" },
  {
    render: ({ block, editor }) => (
      <NotionEmbedView url={block.props.url} editable={editor.isEditable} onChange={url => editor.updateBlock(block, { props: { url } })} />
    ),
    // Markdown/HTML export (search, share descriptions) keeps a plain link.
    toExternalHTML: ({ block }) => <p><a href={block.props.url}>เปิดหน้า Notion</a></p>
  }
);

const { video, audio, file, ...blockSpecs } = defaultBlockSpecs;
const schema = BlockNoteSchema.create({ blockSpecs: { ...blockSpecs, notionEmbed: NotionEmbedBlock() } });
type Editor = typeof schema.BlockNoteEditor;

// ==========================================
// Article editor page
// ==========================================

interface Article {
  id: string; slug: string; title: string; category: string | null; excerpt: string | null; body: string;
  content_json: string | null; cover_url: string | null; status: "draft" | "review" | "published";
  published_at: string | null; author_id: string | null; author_name?: string | null; review_note: string | null;
  notion_page_id: string | null; updated_at: string; updated_by_name?: string | null;
}

interface Revision { id: string; title: string; saved_at: string; saved_by_name: string | null; excerpt: string; length: number }

/** Thrown when the article changed on the server since this editor loaded it (HTTP 409). */
class ConflictError extends Error {
  constructor(public latest: Article) { super("มีคนแก้บทความนี้ระหว่างที่คุณเขียน"); }
}

/** PATCH/POST that keeps the 409 body (useApi only keeps the message). */
async function sendArticle(api: Api, path: string, method: string, body: unknown): Promise<{ article: Article }> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method, body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(api.token ? { Authorization: `Bearer ${api.token}` } : {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 409 && data.conflict && data.article) throw new ConflictError(data.article);
  if (!response.ok) throw new Error(data.error || `คำขอไม่สำเร็จ (${response.status})`);
  return data;
}

const STATUS: Record<Article["status"], { label: string; color: string; bg: string }> = {
  draft: { label: "ฉบับร่าง", color: "#3a4660", bg: "#eceff4" },
  review: { label: "รอตรวจ", color: "#7a4b00", bg: "#fff1d6" },
  published: { label: "เผยแพร่แล้ว", color: "#1f6b45", bg: "#dff3e8" }
};

type Api = ReturnType<typeof useApi>;

/** Loads the article first so the editor is created with its content. */
const ArticleEditor: React.FC<{ articleId: string | null; onClose: () => void }> = ({ articleId, onClose }) => {
  const api = useApi();
  const [article, setArticle] = useState<Article | null | undefined>(articleId ? undefined : null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!articleId) return;
    api.get<{ article: Article }>(`/admin/site/articles/${articleId}`).then(d => setArticle(d.article)).catch(err => setError(err.message));
  }, [articleId]);
  if (error) return <div style={{ padding: 32 }}><ErrorBox message={error} /><button className="tech-button-outline" onClick={onClose}>กลับ</button></div>;
  if (article === undefined) return <div style={{ padding: 48, textAlign: "center", color: "var(--text-secondary)" }}>กำลังเปิดบทความ…</div>;
  return <EditorPage key={article?.id ?? "new"} api={api} initial={article} onClose={onClose} />;
};
export default ArticleEditor;

const EditorPage: React.FC<{ api: Api; initial: Article | null; onClose: () => void }> = ({ api, initial, onClose }) => {
  const { confirmDelete, dangerDialog } = useDangerousDelete();
  const canWrite = can(api.user, "articles.write");
  const canPublish = can(api.user, "articles.publish");
  const canManage = can(api.user, "articles.manage");
  const canImport = can(api.user, "articles.import_notion");

  const [article, setArticle] = useState<Article | null>(initial);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [meta, setMeta] = useState({
    category: initial?.category ?? "", excerpt: initial?.excerpt ?? "", slug: initial?.slug ?? "",
    cover_url: initial?.cover_url ?? "", published_at: initial?.published_at?.slice(0, 10) ?? ""
  });
  const [notionPageId, setNotionPageId] = useState(initial?.notion_page_id ?? null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(initial?.updated_at ?? null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [importing, setImporting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [conflict, setConflict] = useState<Article | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const savingRef = useRef(false);
  const applyingRef = useRef(false);

  const isAuthor = !article || article.author_id === api.user?.id;
  const status = article?.status ?? "draft";
  const canEditContent = canManage || (isAuthor && (canWrite || canPublish) && (status !== "published" || canPublish));
  const dictionary = useMemo(() => thaiDictionary(), []);

  const initialContent = useMemo(() => {
    if (!initial?.content_json) return undefined;
    try { return JSON.parse(initial.content_json); } catch { return undefined; }
  }, []);
  const editor = useCreateBlockNote({
    schema,
    dictionary,
    initialContent,
    uploadFile: async (file: File) => {
      if (!file.type.startsWith("image/")) throw new Error("อัปโหลดได้เฉพาะรูปภาพ");
      return uploadImage(file, api.token);
    }
  }) as Editor;

  // Articles written before the block editor only have Markdown.
  useEffect(() => {
    if (!initialContent && initial?.body) {
      const blocks = editor.tryParseMarkdownToBlocks(initial.body);
      if (blocks.length) editor.replaceBlocks(editor.document, blocks);
      setDirty(false);
    }
  }, []);
  useEffect(() => { editor.isEditable = canEditContent; }, [canEditContent]);

  const contentPayload = () => {
    const body = editor.blocksToMarkdownLossy(editor.document).trim();
    return {
      title: title.trim(),
      category: meta.category.trim() || null,
      excerpt: meta.excerpt.trim() || null,
      cover_url: meta.cover_url || null,
      body: body || title.trim(),
      content_json: JSON.stringify(editor.document),
      notion_page_id: notionPageId,
      ...(meta.slug.trim() ? { slug: meta.slug.trim() } : {}),
      ...(canPublish && meta.published_at ? { published_at: meta.published_at } : {})
    };
  };

  /** Replaces the editor with a server version (latest after a conflict, or a restored revision). */
  const applyArticle = (next: Article) => {
    applyingRef.current = true;
    setArticle(prev => ({ ...(prev ?? {} as Article), ...next, author_name: next.author_name ?? prev?.author_name }));
    setTitle(next.title);
    setMeta({ category: next.category ?? "", excerpt: next.excerpt ?? "", slug: next.slug, cover_url: next.cover_url ?? "", published_at: next.published_at?.slice(0, 10) ?? "" });
    setNotionPageId(next.notion_page_id ?? null);
    let blocks: any[] | undefined;
    try { blocks = next.content_json ? JSON.parse(next.content_json) : undefined; } catch { blocks = undefined; }
    if (!blocks?.length) blocks = editor.tryParseMarkdownToBlocks(next.body || "");
    editor.replaceBlocks(editor.document, blocks!.length ? blocks! : [{ type: "paragraph" }]);
    setSavedAt(next.updated_at);
    setDirty(false);
    window.setTimeout(() => { applyingRef.current = false; setDirty(false); }, 0);
  };

  /**
   * Saves content (and optionally a status change). Returns the saved article or null on error.
   * Sends the version this editor holds; overwrite=true replaces a newer server version on purpose.
   */
  const save = async (extra: Record<string, unknown> = {}, withContent = canEditContent, overwrite?: Article): Promise<Article | null> => {
    if (savingRef.current) return null;
    if (conflict && !overwrite) return null; // Never autosave over someone else's version.
    if (withContent && !title.trim()) { setError("กรุณาใส่หัวข้อบทความ"); return null; }
    savingRef.current = true;
    setSaving(true);
    try {
      setError(null);
      const body = { ...(withContent ? contentPayload() : {}), ...extra };
      const res = article
        ? await sendArticle(api, `/admin/site/articles/${article.id}`, "PATCH", { ...body, expected_updated_at: (overwrite ?? article).updated_at })
        : await api.post<{ article: Article }>("/admin/site/articles", { status: "draft", ...body });
      setConflict(null);
      setArticle(prev => ({ ...(prev ?? {} as Article), ...res.article, author_name: prev?.author_name ?? api.user?.name }));
      setMeta(m => ({ ...m, slug: res.article.slug }));
      setDirty(false);
      setSavedAt(res.article.updated_at);
      return res.article;
    } catch (err: any) {
      if (err instanceof ConflictError) setConflict(err.latest);
      else setError(err.message);
      return null;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const loadLatest = () => {
    if (!conflict) return;
    if (dirty && !confirm("การแก้ไขของคุณที่ยังไม่บันทึกจะหายไป โหลดฉบับล่าสุด?")) return;
    applyArticle(conflict);
    setConflict(null);
    setNotice("โหลดฉบับล่าสุดแล้ว");
  };
  const overwrite = async () => {
    if (!conflict || !confirm("บันทึกฉบับของคุณทับฉบับล่าสุด? ฉบับที่ถูกทับจะยังอยู่ในประวัติการแก้ไข")) return;
    if (await save({}, canEditContent, conflict)) setNotice("บันทึกทับแล้ว ฉบับก่อนหน้าอยู่ในประวัติการแก้ไข");
  };

  // Autosave like Notion: 2.5 s after the last change, once there is a title.
  useEffect(() => {
    if (!dirty || !canEditContent || !title.trim() || conflict) return;
    const timer = window.setTimeout(() => { save(); }, 2500);
    return () => window.clearTimeout(timer);
  }, [dirty, title, meta, notionPageId, conflict]);
  // Warn before leaving with unsaved changes.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const transition = async (next: Article["status"], note?: string) => {
    const saved = await save({ status: next, ...(note !== undefined ? { review_note: note } : {}) }, canEditContent);
    if (saved) {
      const messages: Record<string, string> = {
        review: "ส่งให้ตรวจแล้ว ผู้ตรวจจะได้รับการแจ้งเตือน",
        published: "เผยแพร่แล้ว",
        draft: note ? "ส่งกลับให้ผู้เขียนแก้ไขแล้ว" : "เปลี่ยนเป็นฉบับร่างแล้ว"
      };
      setNotice(messages[next]);
    }
  };

  const changeCover = async (fileList: FileList | null) => {
    const f = fileList?.[0];
    if (!f) return;
    try { const url = await uploadImage(f, api.token); setMeta(m => ({ ...m, cover_url: url })); setDirty(true); }
    catch (err: any) { setError(err.message); }
  };

  const remove = async () => {
    if (!article) return;
    try {
      // A published article needs an emailed code from its author or an admin.
      const done = await confirmDelete({ action: "article.delete", targetId: article.id, path: `/admin/site/articles/${article.id}`,
        confirmMessage: `ลบบทความ "${article.title}"? ลบแล้วกู้คืนไม่ได้` });
      if (done) onClose();
    }
    catch (err: any) { setError(err.message); }
  };

  const reviewingOthers = !isAuthor && status === "review" && canPublish;
  const canDelete = article && (canManage || (isAuthor && status !== "published"));

  return (
    <div className="np-editor-page">
      {dangerDialog}
      <header className="np-editor-bar">
        <button className="np-icon-button" onClick={() => { if (!dirty || confirm("มีการแก้ไขที่ยังไม่บันทึก ออกจากหน้านี้?")) onClose(); }}>
          <ArrowLeft size={18} /> บทความทั้งหมด
        </button>
        <span className="np-status" style={{ color: STATUS[status].color, background: STATUS[status].bg }}>{STATUS[status].label}</span>
        <span className="np-save-state" aria-live="polite">
          {conflict ? "หยุดบันทึกอัตโนมัติ: มีฉบับใหม่กว่า" : saving ? "กำลังบันทึก…" : dirty ? "มีการแก้ไขที่ยังไม่บันทึก" : savedAt ? `บันทึกแล้ว ${formatDateTime(savedAt)}` : "ยังไม่ได้บันทึก"}
        </span>
        <div className="np-bar-actions">
          {canImport && canEditContent && <button className="np-icon-button" onClick={() => setImporting(true)}><Download size={16} /> นำเข้าจาก Notion</button>}
          {article && <button className="np-icon-button" aria-expanded={showHistory} onClick={() => { setShowHistory(v => !v); setShowDetails(false); }}><History size={16} /> ประวัติการแก้ไข</button>}
          <button className="np-icon-button" aria-expanded={showDetails} onClick={() => { setShowDetails(v => !v); setShowHistory(false); }}><Settings2 size={16} /> รายละเอียด</button>
          {article?.status === "published" && <a className="np-icon-button" href={`/blog/${article.slug}`} target="_blank" rel="noreferrer"><ExternalLink size={16} /> ดูบนเว็บ</a>}
          {canEditContent && <button className="tech-button-outline" disabled={saving} onClick={() => save()}>บันทึก</button>}
          {reviewingOthers && <button className="tech-button-outline" onClick={() => setReviewing(true)}>ส่งกลับแก้ไข</button>}
          {status !== "published" && (canPublish
            ? <button className="tech-button-primary" disabled={saving} onClick={() => transition("published")}>{reviewingOthers ? "อนุมัติและเผยแพร่" : "เผยแพร่"}</button>
            : status === "draft"
              ? <button className="tech-button-primary" disabled={saving} onClick={() => transition("review")}>ส่งตรวจ</button>
              : <button className="tech-button-outline" disabled={saving} onClick={() => transition("draft")}>ดึงกลับมาแก้</button>)}
          {status === "published" && canPublish && <button className="tech-button-outline" disabled={saving} onClick={() => transition("draft")}>ยกเลิกเผยแพร่</button>}
          {canDelete && <button className="np-icon-button np-danger" aria-label="ลบบทความ" title="ลบบทความ" onClick={remove}><Trash2 size={16} /></button>}
        </div>
      </header>

      <div className="np-editor-layout">
        <main className="np-canvas">
          <ErrorBox message={error} />
          {conflict && (
            <div role="alert" className="np-review-note" style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap", borderColor: "#f5c26b", background: "#fff6e5" }}>
              <AlertTriangle size={18} style={{ color: "#b45309", flexShrink: 0, marginTop: 2 }} />
              <div style={{ flex: "1 1 260px" }}>
                <strong>มีคนแก้บทความนี้ระหว่างที่คุณเขียน</strong>
                <div style={{ fontSize: 13 }}>ฉบับล่าสุดบันทึกโดย {conflict.updated_by_name || "ผู้ใช้อื่น"} เมื่อ {formatDateTime(conflict.updated_at)} · ระบบหยุดบันทึกอัตโนมัติจนกว่าคุณจะเลือก</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="tech-button-outline" onClick={loadLatest}>โหลดฉบับล่าสุด</button>
                {canEditContent && <button className="tech-button-primary" disabled={saving} onClick={overwrite}>บันทึกทับ</button>}
              </div>
            </div>
          )}
          {notice && <div role="status" className="np-notice">{notice}<button aria-label="ปิด" onClick={() => setNotice(null)}><X size={14} /></button></div>}
          {article?.review_note && status === "draft" && (
            <div className="np-review-note"><strong>ความเห็นจากผู้ตรวจ:</strong> {article.review_note}</div>
          )}
          {!canEditContent && <div className="np-review-note">คุณดูบทความนี้ได้อย่างเดียว{reviewingOthers ? " · อนุมัติหรือส่งกลับได้จากปุ่มด้านบน" : ""}</div>}

          {meta.cover_url ? (
            <div className="np-cover">
              <img src={meta.cover_url} alt="" />
              {canEditContent && (
                <div className="np-cover-actions">
                  <label className="np-icon-button">เปลี่ยนรูปปก<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={e => changeCover(e.target.files)} /></label>
                  <button className="np-icon-button" onClick={() => { setMeta(m => ({ ...m, cover_url: "" })); setDirty(true); }}>ลบรูปปก</button>
                </div>
              )}
            </div>
          ) : canEditContent && (
            <label className="np-add-cover"><ImagePlus size={16} /> เพิ่มรูปปก<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={e => changeCover(e.target.files)} /></label>
          )}

          <textarea className="np-title" aria-label="หัวข้อบทความ" placeholder="ไม่มีชื่อ" rows={1} maxLength={200} readOnly={!canEditContent}
            value={title} onChange={e => { setTitle(e.target.value); setDirty(true); }}
            onInput={e => { const t = e.currentTarget; t.style.height = "auto"; t.style.height = `${t.scrollHeight}px`; }} />
          {article?.author_name && <p className="np-byline">โดย {article.author_name}</p>}

          <BlockNoteView editor={editor} theme="light" slashMenu={false} editable={canEditContent} onChange={() => { if (!applyingRef.current) setDirty(true); }} className="np-blocknote">
            <SuggestionMenuController
              triggerCharacter="/"
              getItems={async query => {
                const items = getDefaultReactSlashMenuItems(editor);
                const media = dictionary.slash_menu.image.group;
                // Menu groups render in order, so the embed goes right after the last media item.
                const at = items.map(i => i.group).lastIndexOf(media) + 1 || items.length;
                items.splice(at, 0, {
                  title: "ฝังหน้า Notion",
                  subtext: "แสดงหน้า Notion ที่เผยแพร่แล้วในบทความ",
                  aliases: ["notion", "embed", "ฝัง"],
                  group: media,
                  onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "notionEmbed" })
                });
                return filterSuggestionItems(items, query);
              }}
            />
          </BlockNoteView>
        </main>

        {showHistory && article && (
          <HistoryPanel api={api} article={article} canRestore={canEditContent} onClose={() => setShowHistory(false)}
            onRestored={restored => { applyArticle(restored); setConflict(null); setNotice("กู้คืนฉบับที่เลือกแล้ว ฉบับก่อนกู้คืนอยู่ในประวัติการแก้ไข"); }}
            onConflict={latest => setConflict(latest)} dirty={dirty} />
        )}

        {showDetails && (
          <aside className="np-details" aria-label="รายละเอียดบทความ">
            <h2>รายละเอียดบทความ</h2>
            <Field label="หมวดหมู่" hint="เช่น Cisco, Aruba, ข่าวรอบอบรม · ตรงกับแบรนด์จะลิงก์ไปรอบอบรมให้อัตโนมัติ">
              <input className="form-input" maxLength={40} value={meta.category} readOnly={!canEditContent} onChange={e => { setMeta(m => ({ ...m, category: e.target.value })); setDirty(true); }} />
            </Field>
            <Field label="คำโปรย" hint={`${meta.excerpt.length} / 300 · แสดงในการ์ดบทความและตอนแชร์ลิงก์`}>
              <textarea className="form-input" rows={3} maxLength={300} value={meta.excerpt} readOnly={!canEditContent} onChange={e => { setMeta(m => ({ ...m, excerpt: e.target.value })); setDirty(true); }} />
            </Field>
            <Field label="ลิงก์บทความ" hint="a-z, 0-9 และ - · เว้นว่างเพื่อสร้างอัตโนมัติ">
              <input className="form-input" maxLength={80} value={meta.slug} readOnly={!canEditContent} onChange={e => { setMeta(m => ({ ...m, slug: e.target.value })); setDirty(true); }} />
            </Field>
            {canPublish && (
              <Field label="วันที่เผยแพร่" hint="ใส่วันในอนาคตเพื่อตั้งเวลา">
                <input className="form-input" type="date" value={meta.published_at} onChange={e => { setMeta(m => ({ ...m, published_at: e.target.value })); setDirty(true); }} />
              </Field>
            )}
            <div className="np-seo">
              <span>ตัวอย่างบน Google</span>
              <span className="np-seo-url">{window.location.host} › blog › {meta.slug || "…"}</span>
              <span className="np-seo-title">{title || "หัวข้อบทความ"} | NetPrime</span>
              <span className="np-seo-desc">{meta.excerpt || "คำโปรยของบทความ"}</span>
            </div>
            {notionPageId && <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>นำเข้าจาก Notion (หน้า {notionPageId.slice(0, 8)}…)</p>}
          </aside>
        )}
      </div>

      {importing && <NotionImportDialog api={api} onClose={() => setImporting(false)} onImported={page => {
        const replace = editor.document.length <= 1 && !editor.blocksToMarkdownLossy(editor.document).trim();
        if (!replace && !confirm("แทนที่เนื้อหาปัจจุบันด้วยหน้าจาก Notion?")) return;
        editor.replaceBlocks(editor.document, page.blocks);
        if (!title.trim()) setTitle(page.title);
        if (!meta.cover_url && page.cover_url) setMeta(m => ({ ...m, cover_url: page.cover_url! }));
        setNotionPageId(page.notion_page_id);
        setDirty(true);
        setImporting(false);
        setNotice(page.warnings.length ? `นำเข้าแล้ว · ${page.warnings.join(" · ")}` : "นำเข้าจาก Notion แล้ว ตรวจทานแล้วกดบันทึก");
      }} />}

      {reviewing && <SendBackDialog onClose={() => setReviewing(false)} onSubmit={note => { setReviewing(false); transition("draft", note); }} />}
    </div>
  );
};

/** "ประวัติการแก้ไข": earlier versions (newest first, last 30) with preview and restore. */
const HistoryPanel: React.FC<{
  api: Api; article: Article; canRestore: boolean; dirty: boolean; onClose: () => void;
  onRestored: (article: Article) => void; onConflict: (latest: Article) => void;
}> = ({ api, article, canRestore, dirty, onClose, onRestored, onConflict }) => {
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [preview, setPreview] = useState<{ id: string; title: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ revisions: Revision[] }>(`/admin/site/articles/${article.id}/revisions`).then(d => setRevisions(d.revisions)).catch(err => setError(err.message));
  }, [article.id, article.updated_at]);

  const open = async (rev: Revision) => {
    try {
      setError(null);
      const d = await api.get<{ revision: { id: string; title: string; body: string } }>(`/admin/site/articles/${article.id}/revisions/${rev.id}`);
      setPreview(d.revision);
    } catch (err: any) { setError(err.message); }
  };
  const restore = async (rev: Revision) => {
    if (!confirm(`กู้คืนฉบับ ${formatDateTime(rev.saved_at)}?${dirty ? " การแก้ไขที่ยังไม่บันทึกจะหายไป" : ""} ฉบับปัจจุบันจะถูกเก็บในประวัติ`)) return;
    try {
      setBusy(true);
      setError(null);
      const res = await sendArticle(api, `/admin/site/articles/${article.id}/restore`, "POST", { revision_id: rev.id, expected_updated_at: article.updated_at });
      setPreview(null);
      onRestored(res.article);
    } catch (err: any) {
      if (err instanceof ConflictError) onConflict(err.latest);
      else setError(err.message);
    } finally { setBusy(false); }
  };

  return (
    <aside className="np-details" aria-label="ประวัติการแก้ไข">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>ประวัติการแก้ไข</h2>
        <button className="np-icon-button" aria-label="ปิด" onClick={onClose}><X size={16} /></button>
      </div>
      <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0 }}>เก็บ 30 ฉบับล่าสุด · การบันทึกอัตโนมัติต่อเนื่องของคนเดิมภายใน 5 นาทีนับเป็นฉบับเดียว</p>
      <ErrorBox message={error} />
      {!revisions ? <p style={{ fontSize: 13 }}>กำลังโหลด…</p> : revisions.length === 0 ? <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>ยังไม่มีฉบับก่อนหน้า</p> : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
          {revisions.map(rev => (
            <li key={rev.id} style={{ border: "1px solid rgba(0,0,0,0.08)", borderRadius: 8, padding: 10, background: preview?.id === rev.id ? "#f6f7fb" : undefined }}>
              <button onClick={() => open(rev)} style={{ background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer", width: "100%" }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{formatDateTime(rev.saved_at)}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{rev.saved_by_name || "ไม่ทราบผู้บันทึก"} · {rev.title}</div>
              </button>
              {preview?.id === rev.id && (
                <div style={{ marginTop: 8 }}>
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: 240, overflow: "auto", background: "#fff", border: "1px solid rgba(0,0,0,0.06)", borderRadius: 6, padding: 8, margin: 0 }}>{preview.body}</pre>
                  {canRestore && <button className="tech-button-outline" style={{ marginTop: 8, padding: "4px 10px", fontSize: 12 }} disabled={busy} onClick={() => restore(rev)}>
                    <RotateCcw size={14} /> กู้คืนฉบับนี้
                  </button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
};

interface ImportedPage { title: string; cover_url: string | null; notion_page_id: string; blocks: any[]; warnings: string[] }

const NotionImportDialog: React.FC<{ api: Api; onClose: () => void; onImported: (page: ImportedPage) => void }> = ({ api, onClose, onImported }) => {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try { setBusy(true); setError(null); onImported(await api.post<ImportedPage>("/admin/site/articles/import-notion", { url })); }
    catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="นำเข้าจาก Notion" onClose={onClose} width={560}>
      <ol style={{ margin: "0 0 16px", paddingLeft: 20, fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.7 }}>
        <li>ใน Notion เปิดหน้าที่ต้องการ → ⋯ → <strong>Connections</strong> → เพิ่ม integration ของ NetPrime</li>
        <li>กด <strong>Share → Copy link</strong> แล้ววางด้านล่าง</li>
        <li>ระบบจะคัดลอกข้อความ หัวข้อ รายการ ตาราง โค้ด และรูป (เก็บรูปไว้ที่ระบบของเราเอง) มาให้แก้ต่อ</li>
      </ol>
      <ErrorBox message={error} />
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <Field label="ลิงก์หน้า Notion"><input className="form-input" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.notion.so/..." /></Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={busy}>{busy ? "กำลังนำเข้า…" : "นำเข้า"}</button>
        </div>
      </form>
    </Modal>
  );
};

const SendBackDialog: React.FC<{ onClose: () => void; onSubmit: (note: string) => void }> = ({ onClose, onSubmit }) => {
  const [note, setNote] = useState("");
  return (
    <Modal title="ส่งกลับให้ผู้เขียนแก้ไข" onClose={onClose} width={520}>
      <form onSubmit={e => { e.preventDefault(); onSubmit(note.trim()); }} style={{ display: "grid", gap: 12 }}>
        <Field label="สิ่งที่ต้องแก้" hint="ผู้เขียนจะเห็นข้อความนี้ในบทความและได้รับการแจ้งเตือน">
          <textarea className="form-input" required rows={4} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} />
        </Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary">ส่งกลับ</button>
        </div>
      </form>
    </Modal>
  );
};
