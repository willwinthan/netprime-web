import React, { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Save, Trash2, RotateCcw, ExternalLink, AlertTriangle } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { ErrorBox, Empty, Field, grid2, formatDateTime } from "./ui";
import type { HomeContent } from "../../site/HomePage";
import { Markdown, parseMarkdown } from "../../site/Markdown";

type Api = ReturnType<typeof useApi>;
type Section = "home" | "privacy" | "terms" | "refund-policy";

const SECTIONS: Array<[Section, string]> = [
  ["home", "หน้าแรก"], ["privacy", "นโยบายความเป็นส่วนตัว"], ["terms", "ข้อกำหนดการใช้งาน"], ["refund-policy", "นโยบายการคืนเงิน"]
];

const ICON_LABEL: Record<string, string> = {
  video: "วิดีโอ", certificate: "ใบประกาศ", building: "องค์กร", briefcase: "งาน/ฝึกงาน",
  network: "เครือข่าย", cloud: "คลาวด์", shield: "ความปลอดภัย", users: "ทีม/ผู้เรียน"
};

/** Same rule as the server: https/http links, site paths (/schedule) or anchors (#contact). */
function safeLink(value: string): boolean {
  if (!value) return true;
  if (value.startsWith("#") || (value.startsWith("/") && !value.startsWith("//"))) return true;
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

/**
 * Tab "เนื้อหาหน้าแรก" (site.settings): homepage hero, brand cards, services and FAQ,
 * plus the legal pages shown at /privacy, /terms and /refund-policy.
 */
export const HomeContentPanel: React.FC = () => {
  const api = useApi();
  const [section, setSection] = useState<Section>("home");
  return (
    <div style={{ display: "grid", gap: "16px", maxWidth: "900px" }}>
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
        {SECTIONS.map(([key, label]) => (
          <button key={key} onClick={() => setSection(key)} className={section === key ? "tech-button-primary" : "tech-button-outline"}
            aria-pressed={section === key} style={{ padding: "4px 12px", fontSize: "12px" }}>{label}</button>
        ))}
      </div>
      {section === "home" ? <HomeEditor api={api} /> : <LegalEditor key={section} api={api} pageKey={section} />}
    </div>
  );
};

// ==========================================
// Homepage
// ==========================================

type ListKey = "brands" | "services" | "faq";
const LIMITS: Record<ListKey, number> = { brands: 12, services: 8, faq: 20 };
const BLANK: { [K in ListKey]: HomeContent[K][number] } = {
  brands: { name: "", text: "", link: "/schedule" },
  services: { title: "", text: "", icon: "network" },
  faq: { q: "", a: "" }
};

const HomeEditor: React.FC<{ api: Api }> = ({ api }) => {
  const [form, setForm] = useState<HomeContent | null>(null);
  const [defaults, setDefaults] = useState<HomeContent | null>(null);
  const [icons, setIcons] = useState<string[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ home: HomeContent; defaults: HomeContent; icons: string[]; updated_at: string | null }>("/admin/site/home")
      .then(d => { setForm(d.home); setDefaults(d.defaults); setIcons(d.icons); setUpdatedAt(d.updated_at); })
      .catch(err => setError(err.message));
  }, [api.token]);

  if (!form) return <><ErrorBox message={error} /><Empty text="กำลังโหลด…" /></>;

  const change = (next: HomeContent) => { setSaved(false); setForm(next); };
  const setHero = (key: keyof HomeContent["hero"], value: string) => change({ ...form, hero: { ...form.hero, [key]: value } });
  function setItem<K extends ListKey>(list: K, index: number, patch: Partial<HomeContent[K][number]>) {
    change({ ...form!, [list]: form![list].map((item, i) => i === index ? { ...item, ...patch } : item) });
  }
  const move = (list: ListKey, index: number, by: number) => {
    const items = [...form[list]] as any[];
    const target = index + by;
    if (target < 0 || target >= items.length) return;
    [items[index], items[target]] = [items[target], items[index]];
    change({ ...form, [list]: items });
  };
  const remove = (list: ListKey, index: number) => change({ ...form, [list]: (form[list] as any[]).filter((_, i) => i !== index) });
  const add = (list: ListKey) => change({ ...form, [list]: [...form[list], { ...BLANK[list] }] });

  const problem = (() => {
    if (!form.hero.title.trim() || !form.hero.lead.trim()) return "กรุณากรอกหัวข้อหลักและคำอธิบายของหน้าแรก";
    const badLink = form.brands.find(b => !safeLink((b.link || "").trim()));
    if (badLink) return `ลิงก์ของแบรนด์ "${badLink.name || "ไม่มีชื่อ"}" ต้องขึ้นต้นด้วย https:// หรือ / หรือ #`;
    if (form.brands.some(b => !b.name.trim())) return "กรุณากรอกชื่อแบรนด์ให้ครบ หรือลบรายการที่ว่าง";
    if (form.services.some(s => !s.title.trim() || !s.text.trim())) return "กรุณากรอกชื่อและคำอธิบายบริการให้ครบ หรือลบรายการที่ว่าง";
    if (form.faq.some(f => !f.q.trim() || !f.a.trim())) return "กรุณากรอกคำถามและคำตอบให้ครบ หรือลบรายการที่ว่าง";
    return null;
  })();

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problem) { setError(problem); return; }
    try {
      setSaving(true);
      setError(null);
      const data = await api.request<{ home: HomeContent }>("/admin/site/home", { method: "PUT", body: JSON.stringify(form) });
      setForm(data.home);
      setUpdatedAt(new Date().toISOString());
      setSaved(true);
    } catch (err: any) { setError(err.message); } finally { setSaving(false); }
  };

  const restoreDefaults = () => {
    if (defaults && confirm("แทนที่เนื้อหาหน้าแรกทั้งหมดด้วยเนื้อหาเริ่มต้นของระบบ? (ยังไม่บันทึกจนกว่าจะกดบันทึก)")) change(defaults);
  };

  const ItemTools: React.FC<{ list: ListKey; index: number }> = ({ list, index }) => (
    <div style={{ display: "flex", gap: "4px", alignSelf: "start" }}>
      <button type="button" className="tech-button-outline" style={iconBtn} aria-label="เลื่อนขึ้น" title="เลื่อนขึ้น" disabled={index === 0} onClick={() => move(list, index, -1)}><ArrowUp size={14} /></button>
      <button type="button" className="tech-button-outline" style={iconBtn} aria-label="เลื่อนลง" title="เลื่อนลง" disabled={index === form[list].length - 1} onClick={() => move(list, index, 1)}><ArrowDown size={14} /></button>
      <button type="button" className="tech-button-outline" style={{ ...iconBtn, color: "var(--danger)" }} aria-label="ลบรายการ" title="ลบรายการ" onClick={() => remove(list, index)}><Trash2 size={14} /></button>
    </div>
  );
  const AddButton: React.FC<{ list: ListKey; label: string }> = ({ list, label }) => (
    <button type="button" className="tech-button-outline" style={{ padding: "6px 12px", fontSize: "13px" }} disabled={form[list].length >= LIMITS[list]} onClick={() => add(list)}>
      <Plus size={14} />{label} ({form[list].length}/{LIMITS[list]})
    </button>
  );

  return (
    <form onSubmit={save} className="site-form" style={{ display: "grid", gap: "20px" }}>
      <ErrorBox message={error} />
      <div className="glass-card" style={{ padding: "24px" }}>
        <h3 style={{ fontSize: "16px", marginBottom: "14px" }}>ส่วนหัวของหน้าแรก</h3>
        <div style={grid2}>
          <Field label="ข้อความเล็กเหนือหัวข้อ" hint="ไม่บังคับ"><input className="form-input" maxLength={60} value={form.hero.eyebrow} onChange={e => setHero("eyebrow", e.target.value)} /></Field>
          <Field label="หัวข้อหลัก" span><input className="form-input" required maxLength={120} value={form.hero.title} onChange={e => setHero("title", e.target.value)} /></Field>
          <Field label="คำอธิบายใต้หัวข้อ" hint={`${form.hero.lead.length} / 300`} span><textarea className="form-input" required rows={2} maxLength={300} value={form.hero.lead} onChange={e => setHero("lead", e.target.value)} /></Field>
        </div>
      </div>

      <div className="glass-card" style={{ padding: "24px" }}>
        <h3 style={{ fontSize: "16px", marginBottom: "4px" }}>การ์ดแบรนด์</h3>
        <p style={hint}>แสดงในหัวข้อ "แบรนด์ที่เราสอน" · ไม่มีรายการ = ซ่อนหัวข้อนี้</p>
        {form.brands.map((b, i) => (
          <div key={i} style={row}>
            <div style={grid2}>
              <Field label="ชื่อแบรนด์"><input className="form-input" maxLength={40} value={b.name} onChange={e => setItem("brands", i, { name: e.target.value })} /></Field>
              <Field label="ลิงก์เมื่อกด" hint="เช่น /schedule, /courses หรือ https://…">
                <input className="form-input" maxLength={500} value={b.link || ""} onChange={e => setItem("brands", i, { link: e.target.value })}
                  aria-invalid={!safeLink((b.link || "").trim())} style={!safeLink((b.link || "").trim()) ? { borderColor: "var(--danger)" } : undefined} />
              </Field>
              <Field label="คำอธิบายสั้น" span><input className="form-input" maxLength={160} value={b.text} onChange={e => setItem("brands", i, { text: e.target.value })} /></Field>
            </div>
            <ItemTools list="brands" index={i} />
          </div>
        ))}
        <AddButton list="brands" label="เพิ่มแบรนด์" />
      </div>

      <div className="glass-card" style={{ padding: "24px" }}>
        <h3 style={{ fontSize: "16px", marginBottom: "4px" }}>บริการ / จุดเด่น</h3>
        <p style={hint}>แสดงในหัวข้อ "เรียนกับ NetPrime" ของหน้าแรกและหน้าเกี่ยวกับเรา</p>
        {form.services.map((s, i) => (
          <div key={i} style={row}>
            <div style={grid2}>
              <Field label="ชื่อบริการ"><input className="form-input" maxLength={80} value={s.title} onChange={e => setItem("services", i, { title: e.target.value })} /></Field>
              <Field label="ไอคอน">
                <select className="form-input" value={s.icon} onChange={e => setItem("services", i, { icon: e.target.value })}>
                  {icons.map(icon => <option key={icon} value={icon}>{ICON_LABEL[icon] || icon}</option>)}
                </select>
              </Field>
              <Field label="คำอธิบาย" hint={`${s.text.length} / 300`} span><textarea className="form-input" rows={2} maxLength={300} value={s.text} onChange={e => setItem("services", i, { text: e.target.value })} /></Field>
            </div>
            <ItemTools list="services" index={i} />
          </div>
        ))}
        <AddButton list="services" label="เพิ่มบริการ" />
      </div>

      <div className="glass-card" style={{ padding: "24px" }}>
        <h3 style={{ fontSize: "16px", marginBottom: "4px" }}>คำถามที่พบบ่อย</h3>
        <p style={hint}>ข้อแรกจะเปิดค้างไว้ · ไม่มีรายการ = ซ่อนหัวข้อนี้</p>
        {form.faq.map((f, i) => (
          <div key={i} style={row}>
            <div style={{ display: "grid", gap: "10px" }}>
              <Field label={`คำถามที่ ${i + 1}`}><input className="form-input" maxLength={200} value={f.q} onChange={e => setItem("faq", i, { q: e.target.value })} /></Field>
              <Field label="คำตอบ" hint={`${f.a.length} / 1000`}><textarea className="form-input" rows={2} maxLength={1000} value={f.a} onChange={e => setItem("faq", i, { a: e.target.value })} /></Field>
            </div>
            <ItemTools list="faq" index={i} />
          </div>
        ))}
        <AddButton list="faq" label="เพิ่มคำถาม" />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>
          {updatedAt ? `บันทึกล่าสุด ${formatDateTime(updatedAt)}` : "ยังใช้เนื้อหาเริ่มต้นของระบบ"}
        </span>
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
          {saved && <span style={{ color: "var(--accent)", fontSize: "14px" }}>บันทึกแล้ว · หน้าเว็บจะอัปเดตภายใน 1 นาที</span>}
          <button type="button" className="tech-button-outline" onClick={restoreDefaults}><RotateCcw size={16} />ใช้เนื้อหาเริ่มต้น</button>
          <a href="/" target="_blank" rel="noreferrer" className="tech-button-outline"><ExternalLink size={16} />ดูหน้าแรก</a>
          <button type="submit" className="tech-button-primary" disabled={saving}><Save size={16} />{saving ? "กำลังบันทึก…" : "บันทึกหน้าแรก"}</button>
        </div>
      </div>
    </form>
  );
};

// ==========================================
// Legal pages
// ==========================================

interface LegalContent { title: string; content: string; updated_at: string | null; is_default: boolean }

const LegalEditor: React.FC<{ api: Api; pageKey: Exclude<Section, "home"> }> = ({ api, pageKey }) => {
  const [page, setPage] = useState<LegalContent | null>(null);
  const [form, setForm] = useState({ title: "", content: "" });
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const apply = (p: LegalContent) => { setPage(p); setForm({ title: p.title, content: p.content }); };
  useEffect(() => {
    api.get<{ pages: Record<string, LegalContent> }>("/admin/site/legal").then(d => apply(d.pages[pageKey])).catch(err => setError(err.message));
  }, [api.token, pageKey]);
  const blocks = useMemo(() => preview ? parseMarkdown(form.content) : [], [preview, form.content]);

  if (!page) return <><ErrorBox message={error} /><Empty text="กำลังโหลด…" /></>;

  const put = async (body: Record<string, unknown>) => {
    try {
      setSaving(true);
      setError(null);
      const data = await api.request<{ page: LegalContent }>(`/admin/site/legal/${pageKey}`, { method: "PUT", body: JSON.stringify(body) });
      apply(data.page);
      setSaved(true);
    } catch (err: any) { setError(err.message); } finally { setSaving(false); }
  };
  const isDraftTemplate = page.is_default || form.content.includes("ร่างเอกสาร (แม่แบบ)");

  return (
    <form onSubmit={e => { e.preventDefault(); put(form); }} className="site-form" style={{ display: "grid", gap: "16px" }}>
      <ErrorBox message={error} />
      {isDraftTemplate && (
        <div role="note" style={{ display: "flex", gap: "10px", borderLeft: "4px solid var(--warning)", background: "rgba(245,158,11,0.1)", padding: "12px 16px", borderRadius: "8px", fontSize: "14px" }}>
          <AlertTriangle size={18} style={{ color: "var(--warning)", flexShrink: 0 }} />
          <span><strong>เป็นร่างแม่แบบ ยังไม่ผ่านการตรวจทางกฎหมาย</strong> — ให้ที่ปรึกษากฎหมายตรวจและแก้ข้อความในวงเล็บ [ ] ให้ตรงกับธุรกิจจริง แล้วลบบรรทัด "ร่างเอกสาร" ด้านบนของเนื้อหาออกก่อนเปิดใช้งานจริง</span>
        </div>
      )}
      <div className="glass-card" style={{ padding: "24px", display: "grid", gap: "14px" }}>
        <Field label="ชื่อหน้า"><input className="form-input" required maxLength={120} value={form.title} onChange={e => { setSaved(false); setForm(f => ({ ...f, title: e.target.value })); }} /></Field>
        <div style={{ display: "flex", gap: "6px" }}>
          <button type="button" className={!preview ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "4px 12px", fontSize: "12px" }} onClick={() => setPreview(false)}>แก้ไข</button>
          <button type="button" className={preview ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "4px 12px", fontSize: "12px" }} onClick={() => setPreview(true)}>ดูตัวอย่าง</button>
        </div>
        {preview
          ? <div style={{ border: "1px solid rgba(0,0,0,0.08)", borderRadius: "8px", padding: "16px 20px", background: "#fff" }}><Markdown blocks={blocks} /></div>
          : <Field label="เนื้อหา (Markdown)" hint={`${form.content.length.toLocaleString("th-TH")} / 50,000 · ## หัวข้อ, - รายการ, **ตัวหนา**, [ข้อความ](ลิงก์)`}>
              <textarea className="form-input" required rows={22} maxLength={50_000} value={form.content} style={{ fontFamily: "ui-monospace, monospace", fontSize: "13px" }}
                onChange={e => { setSaved(false); setForm(f => ({ ...f, content: e.target.value })); }} />
            </Field>}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>{page.updated_at ? `บันทึกล่าสุด ${formatDateTime(page.updated_at)}` : "ยังใช้แม่แบบเริ่มต้นของระบบ"}</span>
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
          {saved && <span style={{ color: "var(--accent)", fontSize: "14px" }}>บันทึกแล้ว</span>}
          {!page.is_default && <button type="button" className="tech-button-outline" disabled={saving}
            onClick={() => { if (confirm("กลับไปใช้แม่แบบเริ่มต้น? เนื้อหาที่แก้ไว้จะหายไป")) put({ reset: true }); }}><RotateCcw size={16} />ใช้แม่แบบเริ่มต้น</button>}
          <a href={`/${pageKey}`} target="_blank" rel="noreferrer" className="tech-button-outline"><ExternalLink size={16} />ดูบนเว็บ</a>
          <button type="submit" className="tech-button-primary" disabled={saving}><Save size={16} />{saving ? "กำลังบันทึก…" : "บันทึก"}</button>
        </div>
      </div>
    </form>
  );
};

const iconBtn: React.CSSProperties = { padding: "4px 8px", borderWidth: "1px" };
const hint: React.CSSProperties = { fontSize: "13px", color: "var(--text-secondary)", marginBottom: "14px" };
const row: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr auto", gap: "12px", padding: "14px 0", borderBottom: "1px solid rgba(0,0,0,0.05)", marginBottom: "8px" };
