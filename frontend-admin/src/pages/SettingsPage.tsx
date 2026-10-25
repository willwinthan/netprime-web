import React, { useEffect, useState } from "react";
import { Building, Webhook, KeyRound, BookOpen, ShieldCheck, Video, CheckCircle2, XCircle } from "lucide-react";
import { can, useApi } from "../hooks/useApi";
import { SchoolSettingsPanel } from "../components/settings/SchoolSettingsPanel";
import { WebhooksPanel } from "../components/settings/WebhooksPanel";
import { ApiDocsPanel, ApiKeysPanel } from "../components/settings/ApiKeysPanel";
import { SsoPanel } from "../components/settings/SsoPanel";
import { Card } from "../components/settings/shared";
import { ProviderStatus } from "../components/settings/SessionMeetingCard";
import { ErrorBox, Empty } from "../components/site-admin/ui";

type Tab = "school" | "webhooks" | "keys" | "docs" | "sso" | "live";

/** Permission that opens this page (coordinator: show the menu item when can(user, SETTINGS_PERMISSION)). */
export const SETTINGS_PERMISSION = "integrations.manage";

/**
 * ตั้งค่าระบบ: school settings, webhooks, API keys + docs, enterprise SSO and meeting providers.
 * Brand/theme lives in the website designer; pass `onOpenBranding` to link to it.
 */
export const SettingsPage: React.FC<{ onOpenBranding?: () => void }> = ({ onOpenBranding }) => {
  const api = useApi();
  const [tab, setTab] = useState<Tab>("school");

  if (!can(api.user, SETTINGS_PERMISSION)) {
    return <div className="glass-card" style={{ padding: "40px", textAlign: "center" }}><h2>บัญชีของคุณไม่มีสิทธิ์ตั้งค่าระบบ</h2></div>;
  }
  const tabs: Array<[Tab, string, React.ReactNode]> = [
    ["school", "ข้อมูลโรงเรียน", <Building size={16} />],
    ["sso", "SSO องค์กร", <ShieldCheck size={16} />],
    ["webhooks", "Webhooks", <Webhook size={16} />],
    ["keys", "API keys", <KeyRound size={16} />],
    ["docs", "เอกสาร API", <BookOpen size={16} />],
    ["live", "การประชุมออนไลน์", <Video size={16} />]
  ];

  return (
    <div>
      <div className="header-row">
        <div>
          <h1 className="header-title">ตั้งค่าระบบ</h1>
          <p className="header-desc">ข้อมูลโรงเรียน เงื่อนไขการสมัคร การเชื่อมต่อระบบภายนอก และการเข้าสู่ระบบด้วยบัญชีองค์กร</p>
        </div>
      </div>
      <nav role="tablist" style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "24px", borderBottom: "1px solid rgba(0,0,0,0.06)", paddingBottom: "12px" }}>
        {tabs.map(([key, label, icon]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={tab === key ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "8px 14px", fontSize: "13px" }}>
            {icon}{label}
          </button>
        ))}
      </nav>
      {tab === "school" && <SchoolSettingsPanel onOpenBranding={onOpenBranding} />}
      {tab === "webhooks" && <WebhooksPanel />}
      {tab === "keys" && <ApiKeysPanel />}
      {tab === "docs" && <ApiDocsPanel />}
      {tab === "sso" && <SsoPanel />}
      {tab === "live" && <MeetingProvidersPanel />}
    </div>
  );
};

const SECRETS: Record<string, string> = {
  zoom: "ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET",
  teams: "MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TEAMS_ORGANIZER_ID",
  meet: "ไม่ต้องตั้งค่า — วางลิงก์ Google Meet เอง",
  manual: "ไม่ต้องตั้งค่า — วางลิงก์ห้องประชุมใดก็ได้ (https)"
};

const MeetingProvidersPanel: React.FC = () => {
  const api = useApi();
  const [providers, setProviders] = useState<ProviderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<{ providers: ProviderStatus }>("/live/providers").then(d => setProviders(d.providers)).catch(err => setError(err.message)); }, [api.token]);
  return (
    <div style={{ maxWidth: "820px" }}>
      <ErrorBox message={error} />
      <Card title="ผู้ให้บริการประชุมออนไลน์" description="ใช้กับรอบอบรมแบบออนไลน์/Hybrid (เมนูจัดการเว็บไซต์ → รอบอบรม) และคลาสเรียนสดในคอร์ส ค่าลับตั้งเป็น Worker secrets โดยผู้ดูแลระบบ">
        {!providers ? <Empty text="กำลังโหลด…" /> : (
          <div style={{ display: "grid", gap: "10px" }}>
            {(Object.keys(providers) as Array<keyof ProviderStatus>).map(key => (
              <div key={key} style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                {providers[key].configured ? <CheckCircle2 size={18} color="var(--accent)" /> : <XCircle size={18} color="var(--text-muted)" />}
                <div>
                  <strong>{providers[key].label}</strong> <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>{providers[key].configured ? "พร้อมใช้งาน" : "ยังไม่ได้ตั้งค่า"}</span>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{SECRETS[key]}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};
