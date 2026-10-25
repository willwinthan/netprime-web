import React, { Suspense, lazy, useState } from "react";
import { ExternalLink, FileText, Home, Megaphone, Menu, Palette, Settings2 } from "lucide-react";
import { can, useApi } from "../hooks/useApi";
import { Empty } from "../components/site-admin/ui";
import { PromotionsPanel, SettingsPanel } from "../components/site-admin/ContentPanels";
import { HomeContentPanel } from "../components/site-admin/HomeContentPanel";
import { InstallAppButton } from "../pwa/pwa";

// Builder panels are split so the BlockNote editor loads only when opened.
const PagesPanel = lazy(() => import("../components/builder/PagesPanel"));
const NavPanel = lazy(() => import("../components/builder/NavPanel"));
const ThemePanel = lazy(() => import("../components/builder/ThemePanel"));

type Tab = "home" | "pages" | "nav" | "theme" | "promotions" | "settings";

const TAB_PERMISSION: Record<Tab, string> = {
  home: "site.settings", pages: "website.design", nav: "website.design", theme: "website.design",
  promotions: "site.promotions", settings: "site.settings"
};

/** Permission that designs pages, menus and theme (coordinators by default; editable per role). */
export const WEBSITE_BUILDER_PERMISSION = "website.design";
/** Any of these opens the "เว็บไซต์" console page. */
export const WEBSITE_PERMISSIONS = Array.from(new Set(Object.values(TAB_PERMISSION)));

/**
 * "เว็บไซต์": everything visitors see on the public site in one place — homepage and policy pages,
 * custom pages built from blocks, header/footer menus, theme & branding, promotions, and the
 * announcement bar/contact details. Training rounds and registrants are managed on their own page.
 */
export const WebsiteBuilderPage: React.FC = () => {
  const api = useApi();
  const allowed = (Object.keys(TAB_PERMISSION) as Tab[]).filter(t => can(api.user, TAB_PERMISSION[t]));
  const [tab, setTab] = useState<Tab>(allowed[0] ?? "home");
  if (allowed.length === 0) {
    return <div className="glass-card" style={{ padding: 40, textAlign: "center" }}><h2>บัญชีของคุณไม่มีสิทธิ์จัดการเว็บไซต์</h2></div>;
  }
  const tabs = ([
    ["home", "หน้าแรกและหน้านโยบาย", <Home size={16} />],
    ["pages", "หน้าเว็บอื่น ๆ", <FileText size={16} />],
    ["nav", "เมนู", <Menu size={16} />],
    ["theme", "ธีมและแบรนด์", <Palette size={16} />],
    ["promotions", "โปรโมชั่น", <Megaphone size={16} />],
    ["settings", "ประกาศและข้อมูลติดต่อ", <Settings2 size={16} />]
  ] as Array<[Tab, string, React.ReactNode]>).filter(([key]) => allowed.includes(key));
  return (
    <div>
      <div className="header-row">
        <div>
          <h1 className="header-title">เว็บไซต์</h1>
          <p className="header-desc">แก้ทุกอย่างที่ผู้เข้าชมเห็นบนหน้าเว็บ: เนื้อหาหน้าแรก หน้าเว็บที่สร้างเอง เมนู สีและโลโก้ โปรโมชั่น แถบประกาศ และข้อมูลติดต่อ</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <InstallAppButton />
          <a href="/" target="_blank" rel="noreferrer" className="tech-button-outline"><ExternalLink size={16} />เปิดหน้าเว็บ</a>
        </div>
      </div>
      <nav role="tablist" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 24, borderBottom: "1px solid rgba(0,0,0,0.06)", paddingBottom: 12 }}>
        {tabs.map(([key, label, icon]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={tab === key ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "8px 14px", fontSize: 13 }}>
            {icon}{label}
          </button>
        ))}
      </nav>
      <Suspense fallback={<Empty text="กำลังโหลด…" />}>
        {tab === "home" && <HomeContentPanel />}
        {tab === "pages" && <PagesPanel />}
        {tab === "nav" && <NavPanel />}
        {tab === "theme" && <ThemePanel />}
        {tab === "promotions" && <PromotionsPanel />}
        {tab === "settings" && <SettingsPanel />}
      </Suspense>
    </div>
  );
};

export default WebsiteBuilderPage;
