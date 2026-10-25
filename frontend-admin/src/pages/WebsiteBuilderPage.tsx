import React, { Suspense, lazy, useState } from "react";
import { Award, ExternalLink, FileText, Menu, Palette } from "lucide-react";
import { can, useApi } from "../hooks/useApi";
import { Empty } from "../components/site-admin/ui";
import { InstallAppButton } from "../pwa/pwa";

// Panels are split so the BlockNote editor and certificate designer load only when opened.
const PagesPanel = lazy(() => import("../components/builder/PagesPanel"));
const NavPanel = lazy(() => import("../components/builder/NavPanel"));
const ThemePanel = lazy(() => import("../components/builder/ThemePanel"));
const CertificatesPanel = lazy(() => import("../components/builder/CertificatesPanel"));

type Tab = "pages" | "nav" | "theme" | "certificates";

/** Permission that opens this console page (coordinators by default; editable per role). */
export const WEBSITE_BUILDER_PERMISSION = "website.design";

/**
 * "ออกแบบเว็บไซต์" (website.design): custom pages with blocks, header/footer menus,
 * theme & branding, and certificate templates. Content is applied on the public site at /p/:slug.
 */
export const WebsiteBuilderPage: React.FC = () => {
  const api = useApi();
  const [tab, setTab] = useState<Tab>("pages");
  if (!can(api.user, WEBSITE_BUILDER_PERMISSION)) {
    return <div className="glass-card" style={{ padding: 40, textAlign: "center" }}><h2>บัญชีของคุณไม่มีสิทธิ์ออกแบบเว็บไซต์</h2></div>;
  }
  const tabs: Array<[Tab, string, React.ReactNode]> = [
    ["pages", "หน้าเว็บ", <FileText size={16} />],
    ["nav", "เมนู", <Menu size={16} />],
    ["theme", "ธีมและแบรนด์", <Palette size={16} />],
    ["certificates", "แม่แบบใบประกาศ", <Award size={16} />]
  ];
  return (
    <div>
      <div className="header-row">
        <div>
          <h1 className="header-title">ออกแบบเว็บไซต์</h1>
          <p className="header-desc">สร้างหน้าเว็บด้วยบล็อก แก้เมนู สี โลโก้ ฟอนต์ และออกแบบใบประกาศนียบัตร โดยไม่ต้องเขียนโค้ด</p>
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
        {tab === "pages" && <PagesPanel />}
        {tab === "nav" && <NavPanel />}
        {tab === "theme" && <ThemePanel />}
        {tab === "certificates" && <CertificatesPanel />}
      </Suspense>
    </div>
  );
};

export default WebsiteBuilderPage;
