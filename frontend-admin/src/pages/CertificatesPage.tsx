import React, { Suspense, lazy, useState } from "react";
import { Award, LayoutTemplate } from "lucide-react";
import { can, useApi } from "../hooks/useApi";
import { Empty } from "../components/site-admin/ui";
import { CERTIFICATE_TABS } from "./tabPermissions";
import { CertificatesAdminPanel } from "../components/site-admin/CertificatesAdminPanel";

const CertificatesTemplatePanel = lazy(() => import("../components/builder/CertificatesPanel"));

type Tab = "issued" | "templates";
const TAB_PERMISSION: Record<Tab, string> = CERTIFICATE_TABS;

/** Certificates in one place: search/revoke/reissue issued certificates and design their templates. */
export const CertificatesPage: React.FC = () => {
  const api = useApi();
  const allowed = (Object.keys(TAB_PERMISSION) as Tab[]).filter(t => can(api.user, TAB_PERMISSION[t]));
  const [tab, setTab] = useState<Tab>(allowed[0] ?? "issued");
  if (allowed.length === 0) {
    return <div className="glass-card" style={{ padding: 40, textAlign: "center" }}><h2>บัญชีของคุณไม่มีสิทธิ์จัดการใบประกาศ</h2></div>;
  }
  const tabs = ([
    ["issued", "ใบประกาศที่ออกแล้ว", <Award size={16} />],
    ["templates", "แม่แบบใบประกาศ", <LayoutTemplate size={16} />]
  ] as Array<[Tab, string, React.ReactNode]>).filter(([key]) => allowed.includes(key));
  return (
    <div>
      {tabs.length > 1 && (
        <nav role="tablist" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 20 }}>
          {tabs.map(([key, label, icon]) => (
            <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
              className={tab === key ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "8px 14px", fontSize: 13 }}>
              {icon}{label}
            </button>
          ))}
        </nav>
      )}
      {tab === "issued" && <CertificatesAdminPanel />}
      {tab === "templates" && (
        <Suspense fallback={<Empty text="กำลังโหลด…" />}><CertificatesTemplatePanel /></Suspense>
      )}
    </div>
  );
};

export default CertificatesPage;
