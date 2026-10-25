import React, { useState } from "react";
import { BarChart3, Users, FileText, Inbox, Star, Ticket, Radar, ExternalLink } from "lucide-react";
import { can, useApi } from "../hooks/useApi";
import { LeadFormsPanel, LeadsPanel, TrackingPanel } from "../components/marketing/LeadPanels";
import { AffiliatesAdminPanel, CampaignsPanel, MarketingAnalyticsPanel, ReviewsModerationPanel } from "../components/marketing/GrowthPanels";

type Tab = "overview" | "affiliates" | "forms" | "leads" | "reviews" | "campaigns" | "tracking";

/** Permission that opens this console (wire the nav item with it). */
export const MARKETING_PERMISSION = "marketing.manage";

/**
 * Marketing console (marketing.manage): attribution report, affiliates and payouts, lead forms and popups,
 * leads, review moderation, bulk voucher campaigns, and tracking pixels.
 */
export const MarketingPage: React.FC = () => {
  const api = useApi();
  const [tab, setTab] = useState<Tab>("overview");
  const [leadForm, setLeadForm] = useState<string | null>(null);

  if (!can(api.user, MARKETING_PERMISSION)) {
    return <div className="glass-card" style={{ padding: 40, textAlign: "center" }}><h2>บัญชีของคุณไม่มีสิทธิ์จัดการการตลาด</h2></div>;
  }

  const tabs: Array<[Tab, string, React.ReactNode]> = [
    ["overview", "ภาพรวม & แหล่งที่มา", <BarChart3 size={16} />],
    ["affiliates", "Affiliate / แนะนำเพื่อน", <Users size={16} />],
    ["forms", "ฟอร์ม & Popup", <FileText size={16} />],
    ["leads", "Leads", <Inbox size={16} />],
    ["reviews", "รีวิวคอร์ส", <Star size={16} />],
    ["campaigns", "แคมเปญคูปอง", <Ticket size={16} />],
    ["tracking", "Tracking & Pixel", <Radar size={16} />]
  ];

  return (
    <div>
      <div className="header-row">
        <div>
          <h1 className="header-title">การตลาด</h1>
          <p className="header-desc">ติดตามแหล่งที่มาของผู้สมัคร จัดการโปรแกรมแนะนำเพื่อน ฟอร์มเก็บ lead รีวิว และโค้ดส่วนลด</p>
        </div>
        <a href="/courses" target="_blank" rel="noreferrer" className="tech-button-outline"><ExternalLink size={16} />ดูหน้าคอร์สบนเว็บ</a>
      </div>
      <nav role="tablist" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 24, borderBottom: "1px solid rgba(0,0,0,0.06)", paddingBottom: 12 }}>
        {tabs.map(([key, label, icon]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={tab === key ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "8px 14px", fontSize: 13 }}>
            {icon}{label}
          </button>
        ))}
      </nav>
      {tab === "overview" && <MarketingAnalyticsPanel />}
      {tab === "affiliates" && <AffiliatesAdminPanel />}
      {tab === "forms" && <LeadFormsPanel onShowLeads={id => { setLeadForm(id); setTab("leads"); }} />}
      {tab === "leads" && <LeadsPanel formId={leadForm} />}
      {tab === "reviews" && <ReviewsModerationPanel />}
      {tab === "campaigns" && <CampaignsPanel />}
      {tab === "tracking" && <TrackingPanel />}
    </div>
  );
};
