import React, { useEffect, useState } from "react";
import { RotateCcw, Save } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Empty, ErrorBox } from "../site-admin/ui";
import { ListEditor, Notice, TextInput } from "./adminKit";
import { isSafeLink } from "./blocks";
import { NavItem, refreshSiteNav } from "./siteChrome";

interface Nav { header: NavItem[]; footer: NavItem[] }

const blank = (): NavItem => ({ label: "", label_en: null, href: "/", new_tab: false });

/**
 * Tab "เมนู": header and footer menus of the public site. Custom pages can also add themselves
 * with "แสดงในเมนู" in the page editor; they appear after these items.
 */
export const NavPanel: React.FC = () => {
  const api = useApi();
  const [nav, setNav] = useState<Nav | null>(null);
  const [defaults, setDefaults] = useState<Nav | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ nav: Nav; defaults: Nav }>("/website/nav").then(d => { setNav(d.nav); setDefaults(d.defaults); }).catch(err => setError(err.message));
  }, [api.token]);

  const save = async () => {
    if (!nav) return;
    const bad = [...nav.header, ...nav.footer].find(i => !isSafeLink(i.href) || !i.href);
    if (bad) { setError(`ลิงก์ของเมนู "${bad.label || "ไม่มีชื่อ"}" ต้องขึ้นต้นด้วย / หรือ https://`); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const d = await api.request<{ nav: Nav }>("/website/nav", { method: "PUT", body: JSON.stringify(nav) });
      setNav(d.nav);
      refreshSiteNav();
      setNotice("บันทึกเมนูแล้ว หน้าเว็บอัปเดตภายใน 2 นาที");
    } catch (err: any) { setError(err.message); } finally { setSaving(false); }
  };

  if (!nav) return error ? <ErrorBox message={error} /> : <Empty text="กำลังโหลด…" />;

  const editor = (key: keyof Nav, title: string, max: number) => (
    <div className="glass-card" style={{ padding: 20 }}>
      <h3 style={{ fontSize: 15, margin: "0 0 4px" }}>{title}</h3>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-muted)" }}>ลิงก์ภายในเว็บ เช่น /courses, /p/corporate-training หรือ #contact · ลิงก์ภายนอกขึ้นต้นด้วย https://</p>
      <ListEditor items={nav[key]} max={max} addLabel="เพิ่มเมนู" itemLabel={i => `เมนูที่ ${i + 1}`} blank={blank}
        onChange={items => setNav({ ...nav, [key]: items })} render={(item, update) => <>
          <TextInput label="ชื่อเมนู" required value={item.label} max={40} onChange={v => update({ label: v })} />
          <TextInput label="ชื่อภาษาอังกฤษ" value={item.label_en} max={40} onChange={v => update({ label_en: v || null })} />
          <TextInput label="ลิงก์" required value={item.href} max={500} hint={isSafeLink(item.href) ? undefined : "ลิงก์ต้องขึ้นต้นด้วย / หรือ https://"} onChange={v => update({ href: v })} />
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, alignSelf: "end", minHeight: 40 }}>
            <input type="checkbox" checked={item.new_tab} onChange={e => update({ new_tab: e.target.checked })} />เปิดในแท็บใหม่
          </label>
        </>} />
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 900 }}>
      <ErrorBox message={error} />
      {notice && <Notice>{notice}</Notice>}
      {editor("header", "เมนูส่วนหัว (สูงสุด 8)", 8)}
      {editor("footer", "ลิงก์เพิ่มเติมในส่วนท้าย (สูงสุด 16)", 16)}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="tech-button-primary" onClick={save} disabled={saving}><Save size={16} />{saving ? "กำลังบันทึก…" : "บันทึกเมนู"}</button>
        {defaults && <button type="button" className="tech-button-outline" onClick={() => setNav(defaults)}><RotateCcw size={16} />ใช้เมนูเริ่มต้น</button>}
      </div>
    </div>
  );
};

export default NavPanel;
