import React, { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, Eye, ExternalLink, FilePlus2, Globe, Pencil, Plus, Save, Trash2, Undo2 } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, Empty, ErrorBox, Field, Modal, formatDateTime, grid2, tableStyle, tdStyle, thStyle } from "../site-admin/ui";
import { BlockForm, CourseOptions } from "./BlockForm";
import { BLOCK_INFO, BLOCK_ORDER, BlockType, PageBlock, newBlock, slugify } from "./blocks";
import { IconBtn, ImageInput, Notice, TextInput } from "./adminKit";
import { PageBlocks } from "./PageBlocks";
import { refreshSiteNav } from "./siteChrome";
import "../../site/site.css";

type Api = ReturnType<typeof useApi>;

export interface AdminPage {
  id: string; slug: string; title: string; title_en: string | null; status: "draft" | "published";
  blocks: PageBlock[]; blocks_en: PageBlock[] | null; seo_title: string | null; seo_description: string | null; og_image_url: string | null;
  show_in_nav: boolean; show_in_footer: boolean; sort_order: number; published_at: string | null; updated_at: string;
  updated_by_name: string | null; has_unpublished_changes: boolean; block_count?: number; has_english?: boolean;
}

const STATUS = {
  draft: { label: "ฉบับร่าง", color: "#3a4660", bg: "#eceff4" },
  published: { label: "เผยแพร่แล้ว", color: "#1f6b45", bg: "#dff3e8" }
};

/** Tab "หน้าเว็บ": list of custom pages; opens the page editor. */
export const PagesPanel: React.FC = () => {
  const api = useApi();
  const [pages, setPages] = useState<AdminPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => api.get<{ pages: AdminPage[] }>("/website/pages").then(d => setPages(d.pages)).catch(err => setError(err.message));
  useEffect(() => { load(); }, [api.token]);

  const move = async (index: number, delta: number) => {
    if (!pages) return;
    const next = [...pages];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    setPages(next);
    try {
      await api.post("/website/pages/reorder", { ids: next.map(p => p.id) });
      refreshSiteNav();
    } catch (err: any) { setError(err.message); load(); }
  };

  const remove = async (page: AdminPage) => {
    if (!window.confirm(`ลบหน้า "${page.title}" ถาวร? ลิงก์ /p/${page.slug} จะใช้ไม่ได้อีก`)) return;
    try {
      await api.request(`/website/pages/${page.id}`, { method: "DELETE" });
      refreshSiteNav();
      load();
    } catch (err: any) { setError(err.message); }
  };

  if (editing) return <PageEditor api={api} pageId={editing} onClose={() => { setEditing(null); load(); }} />;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 14 }}>สร้างหน้าใหม่ เช่น หน้าอบรมองค์กร หน้าโปรโมชั่น หรือหน้าแนะนำหลักสูตร หน้าที่เผยแพร่แล้วอยู่ที่ /p/ชื่อหน้า</p>
        <button type="button" className="tech-button-primary" onClick={() => setCreating(true)}><FilePlus2 size={16} />สร้างหน้าใหม่</button>
      </div>
      <ErrorBox message={error} />
      {!pages ? <Empty text="กำลังโหลด…" /> : pages.length === 0 ? <Empty text="ยังไม่มีหน้าที่สร้างเอง" /> : (
        <div className="glass-card" style={{ padding: 8, overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead><tr><th style={thStyle}>ลำดับ</th><th style={thStyle}>หน้า</th><th style={thStyle}>สถานะ</th><th style={thStyle}>แสดงในเมนู</th><th style={thStyle}>แก้ไขล่าสุด</th><th style={thStyle} /></tr></thead>
            <tbody>
              {pages.map((p, i) => (
                <tr key={p.id}>
                  <td style={tdStyle}>
                    <span style={{ display: "inline-flex", gap: 4 }}>
                      <IconBtn label="เลื่อนขึ้น" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></IconBtn>
                      <IconBtn label="เลื่อนลง" disabled={i === pages.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></IconBtn>
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <button type="button" onClick={() => setEditing(p.id)} style={{ background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left" }}>
                      <div style={{ fontWeight: 700, color: "var(--text-primary)" }}>{p.title}</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>/p/{p.slug} · {p.block_count ?? 0} บล็อก{p.has_english ? " · มีฉบับภาษาอังกฤษ" : ""}</div>
                    </button>
                  </td>
                  <td style={tdStyle}>
                    <Chip {...STATUS[p.status]} />
                    {p.has_unpublished_changes && <div style={{ fontSize: 12, color: "#92400e", marginTop: 4 }}>มีการแก้ไขที่ยังไม่เผยแพร่</div>}
                  </td>
                  <td style={{ ...tdStyle, fontSize: 13 }}>{[p.show_in_nav && "ส่วนหัว", p.show_in_footer && "ส่วนท้าย"].filter(Boolean).join(", ") || "—"}</td>
                  <td style={{ ...tdStyle, fontSize: 13, color: "var(--text-secondary)" }}>{formatDateTime(p.updated_at)}{p.updated_by_name ? ` · ${p.updated_by_name}` : ""}</td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    <span style={{ display: "inline-flex", gap: 4 }}>
                      <IconBtn label="แก้ไข" onClick={() => setEditing(p.id)}><Pencil size={14} /></IconBtn>
                      {p.status === "published" && <IconBtn label="เปิดหน้าเว็บ" onClick={() => window.open(`/p/${p.slug}`, "_blank", "noopener")}><ExternalLink size={14} /></IconBtn>}
                      <IconBtn label="ลบ" danger onClick={() => remove(p)}><Trash2 size={14} /></IconBtn>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CreatePageDialog api={api} onClose={() => setCreating(false)} onCreated={page => { setCreating(false); setEditing(page.id); }} />}
    </div>
  );
};

const CreatePageDialog: React.FC<{ api: Api; onClose: () => void; onCreated: (page: AdminPage) => void }> = ({ api, onClose, onCreated }) => {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { page } = await api.post<{ page: AdminPage }>("/website/pages", { title, slug, blocks: [newBlock("hero")] });
      onCreated(page);
    } catch (err: any) { setError(err.message); setSaving(false); }
  };
  return (
    <Modal title="สร้างหน้าใหม่" onClose={onClose} width={520}>
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        <ErrorBox message={error} />
        <TextInput label="ชื่อหน้า" required value={title} max={160} onChange={v => { setTitle(v); if (!slugTouched) setSlug(slugify(v)); }} />
        <Field label="ลิงก์หน้า (slug) *" hint={`หน้าเว็บจะอยู่ที่ /p/${slug || "ชื่อหน้า"} ใช้ได้เฉพาะ a-z 0-9 และขีดกลาง`}>
          <input className="form-input" required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={e => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); }} />
        </Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={saving}><Plus size={16} />{saving ? "กำลังสร้าง…" : "สร้างหน้า"}</button>
        </div>
      </form>
    </Modal>
  );
};

// ==========================================
// Page editor
// ==========================================

type Meta = Pick<AdminPage, "title" | "title_en" | "slug" | "seo_title" | "seo_description" | "og_image_url" | "show_in_nav" | "show_in_footer">;

const PageEditor: React.FC<{ api: Api; pageId: string; onClose: () => void }> = ({ api, pageId, onClose }) => {
  const [page, setPage] = useState<AdminPage | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [blocks, setBlocks] = useState<PageBlock[]>([]);
  const [blocksEn, setBlocksEn] = useState<PageBlock[] | null>(null);
  const [lang, setLang] = useState<"th" | "en">("th");
  const [open, setOpen] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<PageBlock[] | null>(null);
  const [options, setOptions] = useState<CourseOptions | null>(null);
  const [adding, setAdding] = useState(false);

  const accept = (p: AdminPage) => {
    setPage(p);
    setMeta({ title: p.title, title_en: p.title_en, slug: p.slug, seo_title: p.seo_title, seo_description: p.seo_description, og_image_url: p.og_image_url, show_in_nav: p.show_in_nav, show_in_footer: p.show_in_footer });
    setBlocks(p.blocks);
    setBlocksEn(p.blocks_en && p.blocks_en.length ? p.blocks_en : null);
    setDirty(false);
  };

  useEffect(() => {
    api.get<{ page: AdminPage }>(`/website/pages/${pageId}`).then(d => accept(d.page)).catch(err => setError(err.message));
    api.get<CourseOptions>("/website/course-options").then(setOptions).catch(() => setOptions({ courses: [], categories: [] }));
  }, [pageId]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const current = lang === "th" ? blocks : (blocksEn ?? []);
  const setCurrent = (next: PageBlock[]) => { (lang === "th" ? setBlocks : setBlocksEn)(next); setDirty(true); };
  const editMeta = (patch: Partial<Meta>) => { setMeta(m => ({ ...m!, ...patch })); setDirty(true); };

  const payload = () => ({ ...meta, blocks, blocks_en: blocksEn && blocksEn.length ? blocksEn : null, expected_updated_at: page?.updated_at });

  const save = async (): Promise<AdminPage | null> => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const { page: saved } = await api.patch<{ page: AdminPage }>(`/website/pages/${pageId}`, payload());
      accept(saved);
      refreshSiteNav();
      setNotice(saved.status === "published" ? "บันทึกฉบับร่างแล้ว — กด \"เผยแพร่\" เพื่อให้ผู้เข้าชมเห็นการแก้ไข" : "บันทึกฉบับร่างแล้ว");
      return saved;
    } catch (err: any) { setError(err.message); return null; } finally { setBusy(false); }
  };

  const publish = async () => {
    if (dirty && !(await save())) return;
    setBusy(true); setError(null);
    try {
      const { page: published } = await api.post<{ page: AdminPage }>(`/website/pages/${pageId}/publish`, {});
      accept(published);
      refreshSiteNav();
      setNotice(`เผยแพร่แล้วที่ /p/${published.slug}`);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const unpublish = async () => {
    if (!window.confirm("ซ่อนหน้านี้จากหน้าเว็บ? เนื้อหายังอยู่เป็นฉบับร่าง")) return;
    setBusy(true); setError(null);
    try {
      const { page: p } = await api.post<{ page: AdminPage }>(`/website/pages/${pageId}/unpublish`, {});
      setPage(p);
      refreshSiteNav();
      setNotice("ซ่อนหน้าแล้ว (กลับเป็นฉบับร่าง)");
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const showPreview = async () => {
    setError(null);
    try {
      const { blocks: resolved } = await api.post<{ blocks: PageBlock[] }>("/website/pages/preview", { blocks: current });
      setPreview(resolved);
    } catch (err: any) { setError(err.message); }
  };

  const addBlock = (type: BlockType) => {
    const block = newBlock(type);
    setCurrent([...current, block]);
    setOpen(block.id);
    setAdding(false);
  };
  const moveBlock = (i: number, d: number) => { const next = [...current]; [next[i], next[i + d]] = [next[i + d], next[i]]; setCurrent(next); };
  const duplicate = (i: number) => { const copy = { ...JSON.parse(JSON.stringify(current[i])), id: newBlock(current[i].type).id }; const next = [...current]; next.splice(i + 1, 0, copy); setCurrent(next); };

  const close = () => { if (!dirty || window.confirm("มีการแก้ไขที่ยังไม่บันทึก ออกจากหน้านี้?")) onClose(); };

  if (!page || !meta) return <div>{error ? <ErrorBox message={error} /> : <Empty text="กำลังเปิดหน้า…" />}<button className="tech-button-outline" onClick={onClose}>กลับ</button></div>;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", position: "sticky", top: 0, zIndex: 5, background: "var(--bg-primary, #fdfdfd)", padding: "8px 0", borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
        <button type="button" className="tech-button-outline" onClick={close} style={{ padding: "6px 12px" }}>← รายการหน้า</button>
        <strong style={{ fontSize: 16 }}>{meta.title || "หน้าไม่มีชื่อ"}</strong>
        <Chip {...STATUS[page.status]} />
        {dirty ? <span style={{ fontSize: 12, color: "#92400e" }}>ยังไม่บันทึก</span> : page.has_unpublished_changes && <span style={{ fontSize: 12, color: "#92400e" }}>ฉบับร่างต่างจากที่เผยแพร่</span>}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="tech-button-outline" onClick={showPreview} disabled={busy}><Eye size={16} />ดูตัวอย่าง</button>
          <button type="button" className="tech-button-outline" onClick={save} disabled={busy || !dirty}><Save size={16} />บันทึกร่าง</button>
          {page.status === "published" && <button type="button" className="tech-button-outline" onClick={unpublish} disabled={busy}><Undo2 size={16} />ซ่อนหน้า</button>}
          <button type="button" className="tech-button-primary" onClick={publish} disabled={busy}><Globe size={16} />{page.status === "published" ? "เผยแพร่การแก้ไข" : "เผยแพร่"}</button>
        </span>
      </div>
      <ErrorBox message={error} />
      {notice && <Notice>{notice}{page.status === "published" && <> · <a href={`/p/${page.slug}`} target="_blank" rel="noreferrer">เปิดหน้าเว็บ</a></>}</Notice>}

      <div className="glass-card" style={{ padding: 20 }}>
        <h3 style={{ fontSize: 15, margin: "0 0 12px" }}>ข้อมูลหน้าและ SEO</h3>
        <div style={grid2}>
          <TextInput label="ชื่อหน้า" required value={meta.title} max={160} onChange={v => editMeta({ title: v })} />
          <TextInput label="ชื่อหน้า (ภาษาอังกฤษ)" value={meta.title_en} max={160} onChange={v => editMeta({ title_en: v })} />
          <Field label="ลิงก์หน้า (slug)" hint={page.status === "published" ? "เปลี่ยน slug แล้วลิงก์เดิมที่แชร์ไปจะใช้ไม่ได้" : `/p/${meta.slug}`}>
            <input className="form-input" maxLength={80} value={meta.slug} onChange={e => editMeta({ slug: e.target.value.toLowerCase() })} />
          </Field>
          <TextInput label="ชื่อสำหรับ SEO / แชร์" value={meta.seo_title} max={70} hint="ไม่เกิน 70 ตัวอักษร (ว่าง = ใช้ชื่อหน้า)" onChange={v => editMeta({ seo_title: v })} />
          <TextInput label="คำอธิบายสำหรับ SEO / แชร์" value={meta.seo_description} max={300} multiline span hint="แสดงใน Google และตัวอย่างลิงก์ LINE/Facebook" onChange={v => editMeta({ seo_description: v })} />
          <ImageInput label="รูปสำหรับแชร์ (OG image)" value={meta.og_image_url} token={api.token} hint="แนะนำ 1200×630" onChange={v => editMeta({ og_image_url: v })} span />
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}><input type="checkbox" checked={meta.show_in_nav} onChange={e => editMeta({ show_in_nav: e.target.checked })} />แสดงในเมนูส่วนหัว</label>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}><input type="checkbox" checked={meta.show_in_footer} onChange={e => editMeta({ show_in_footer: e.target.checked })} />แสดงในส่วนท้ายเว็บ</label>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        {(["th", "en"] as const).map(l => (
          <button key={l} type="button" className={lang === l ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "4px 12px", fontSize: 12 }} aria-pressed={lang === l} onClick={() => setLang(l)}>
            {l === "th" ? "เนื้อหาภาษาไทย" : "ฉบับภาษาอังกฤษ"}
          </button>
        ))}
        {lang === "en" && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>ไม่บังคับ: ถ้าไม่มี ผู้ที่เลือกภาษาอังกฤษจะเห็นเนื้อหาภาษาไทย</span>}
      </div>

      {lang === "en" && !blocksEn ? (
        <div className="glass-card" style={{ padding: 24, textAlign: "center" }}>
          <p style={{ marginTop: 0, color: "var(--text-secondary)" }}>ยังไม่มีฉบับภาษาอังกฤษ</p>
          <button type="button" className="tech-button-primary" onClick={() => { setBlocksEn(JSON.parse(JSON.stringify(blocks))); setDirty(true); }}><Copy size={16} />คัดลอกบล็อกภาษาไทยมาแปล</button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {current.length === 0 && <Empty text="ยังไม่มีบล็อก เพิ่มบล็อกแรกด้านล่าง" />}
          {current.map((block, i) => {
            const expanded = open === block.id;
            return (
              <div key={block.id} className="glass-card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "rgba(0,0,0,0.02)" }}>
                  <button type="button" onClick={() => setOpen(expanded ? null : block.id)} aria-expanded={expanded}
                    style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: 0, cursor: "pointer", padding: 0, flex: 1, textAlign: "left", minWidth: 0 }}>
                    {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    <strong style={{ fontSize: 14 }}>{i + 1}. {BLOCK_INFO[block.type].label}</strong>
                    <span style={{ fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{blockSummary(block)}</span>
                  </button>
                  <IconBtn label="เลื่อนขึ้น" disabled={i === 0} onClick={() => moveBlock(i, -1)}><ArrowUp size={14} /></IconBtn>
                  <IconBtn label="เลื่อนลง" disabled={i === current.length - 1} onClick={() => moveBlock(i, 1)}><ArrowDown size={14} /></IconBtn>
                  <IconBtn label="ทำสำเนา" onClick={() => duplicate(i)}><Copy size={14} /></IconBtn>
                  <IconBtn label="ลบบล็อก" danger onClick={() => { if (window.confirm("ลบบล็อกนี้?")) setCurrent(current.filter(b => b.id !== block.id)); }}><Trash2 size={14} /></IconBtn>
                </div>
                {expanded && (
                  <div style={{ padding: 16 }}>
                    <BlockForm block={block} token={api.token} options={options} onChange={next => setCurrent(current.map(b => b.id === block.id ? next : b))} />
                  </div>
                )}
              </div>
            );
          })}
          {adding ? (
            <div className="glass-card" style={{ padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}><strong>เลือกชนิดบล็อก</strong><button type="button" className="tech-button-outline" style={{ padding: "4px 10px" }} onClick={() => setAdding(false)}>ยกเลิก</button></div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
                {BLOCK_ORDER.map(type => (
                  <button key={type} type="button" onClick={() => addBlock(type)}
                    style={{ textAlign: "left", padding: 12, borderRadius: 10, border: "1px solid rgba(0,0,0,0.08)", background: "#fff", cursor: "pointer" }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{BLOCK_INFO[type].label}</div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{BLOCK_INFO[type].description}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <button type="button" className="tech-button-outline" style={{ justifySelf: "start" }} onClick={() => setAdding(true)} disabled={current.length >= 60}><Plus size={16} />เพิ่มบล็อก</button>
          )}
        </div>
      )}

      {preview && (
        <Modal title={`ตัวอย่าง: ${lang === "en" ? meta.title_en || meta.title : meta.title}`} onClose={() => setPreview(null)} width={1200}>
          <p style={{ marginTop: -8, fontSize: 13, color: "var(--text-muted)" }}>ตัวอย่างฉบับร่าง (ยังไม่บันทึกก็ดูได้) ผู้เข้าชมจะเห็นเมื่อกดเผยแพร่</p>
          <div className="ps" style={{ minHeight: 0, border: "1px solid rgba(0,0,0,0.08)", borderRadius: 12, overflow: "hidden" }}>
            <PageBlocks blocks={preview} preview />
          </div>
        </Modal>
      )}
    </div>
  );
};

function blockSummary(block: PageBlock): string {
  switch (block.type) {
    case "hero": return block.heading;
    case "image": return block.caption || block.alt || "";
    case "image_text": case "features": case "testimonials": case "faq": case "courses": case "lead_form": return block.heading || "";
    case "cta": return block.label;
    case "video": return block.title || block.url;
    case "richtext": return `${block.doc?.length ?? 0} ย่อหน้า/บล็อก`;
  }
}

export default PagesPanel;
