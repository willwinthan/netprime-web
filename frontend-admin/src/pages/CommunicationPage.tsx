import React, { useEffect, useState } from "react";
import { Megaphone, Mail, Flag, Settings, MessageSquare, Users } from "lucide-react";
import { useApi } from "../hooks/useApi";
import { ErrorBox } from "../components/site-admin/ui";
import { BroadcastsPanel, CommMeta } from "../components/communication/BroadcastsPanel";
import { TemplatesPanel } from "../components/communication/TemplatesPanel";
import { ReportsPanel } from "../components/communication/ReportsPanel";
import { Inbox } from "../components/communication/Inbox";
import { CommunityPage } from "./CommunityPage";

type Tab = "broadcasts" | "templates" | "community" | "reports" | "inbox" | "settings";

/**
 * Staff console for communication: broadcasts, email templates, community moderation, inbox and settings.
 * Coordinators/admins (communication.manage) see everything; instructors see broadcasts to their course
 * learners, moderation of their course spaces and the inbox.
 */
export const CommunicationPage: React.FC<{ initialTab?: Tab; startThreadWithUserId?: string }> = ({ initialTab, startThreadWithUserId }) => {
  const api = useApi();
  const [meta, setMeta] = useState<CommMeta | null>(null);
  const [tab, setTab] = useState<Tab>(startThreadWithUserId ? "inbox" : initialTab ?? "broadcasts");
  const [error, setError] = useState<string | null>(null);
  const [dmSetting, setDmSetting] = useState<boolean | null>(null);
  const [openPostId, setOpenPostId] = useState<string | undefined>(undefined);

  useEffect(() => {
    api.get<CommMeta>("/communication/meta").then(setMeta).catch(err => setError(err.message));
  }, [api.token]);
  useEffect(() => {
    if (tab === "settings" && meta?.can_manage) {
      api.get<{ settings: { dm_learner_to_learner: boolean } }>("/communication/settings").then(d => setDmSetting(d.settings.dm_learner_to_learner)).catch(err => setError(err.message));
    }
  }, [tab, meta?.can_manage]);

  const saveDm = async (value: boolean) => {
    try {
      await api.request("/communication/settings", { method: "PUT", body: JSON.stringify({ dm_learner_to_learner: value }) });
      setDmSetting(value);
    } catch (err: any) { setError(err.message); }
  };

  if (!meta) return <div className="glass-card" style={{ padding: "24px" }}><ErrorBox message={error} />{!error && "กำลังโหลด…"}</div>;

  const tabs: Array<{ key: Tab; label: string; icon: React.ReactNode; show: boolean }> = [
    { key: "broadcasts", label: "ประกาศ/บรอดแคสต์", icon: <Megaphone size={15} />, show: !!meta.access },
    { key: "templates", label: "แม่แบบอีเมล", icon: <Mail size={15} />, show: meta.can_manage },
    { key: "community", label: "ชุมชน", icon: <Users size={15} />, show: true },
    { key: "reports", label: "รายงานเนื้อหา", icon: <Flag size={15} />, show: meta.can_moderate },
    { key: "inbox", label: "กล่องข้อความ", icon: <MessageSquare size={15} />, show: true },
    { key: "settings", label: "ตั้งค่า", icon: <Settings size={15} />, show: meta.can_manage }
  ];

  return (
    <div>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "18px", borderBottom: "1px solid var(--border-subtle, rgba(0,0,0,0.08))", paddingBottom: "12px" }} role="tablist">
        {tabs.filter(t => t.show).map(t => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={tab === t.key ? "tech-button-primary" : "tech-button-outline"}
            style={{ borderRadius: "1rem", padding: "6px 14px", display: "inline-flex", gap: "6px", alignItems: "center" }}>{t.icon}{t.label}</button>
        ))}
      </div>
      <ErrorBox message={error} />
      {tab === "broadcasts" && meta.access && <div className="glass-card" style={{ padding: "20px" }}><BroadcastsPanel meta={meta} /></div>}
      {tab === "templates" && meta.can_manage && <div className="glass-card" style={{ padding: "20px" }}><TemplatesPanel /></div>}
      {tab === "community" && <CommunityPage key={openPostId ?? "community"} initialPostId={openPostId} />}
      {tab === "reports" && meta.can_moderate && (
        <div className="glass-card" style={{ padding: "20px" }}><ReportsPanel onOpenPost={id => { setOpenPostId(id); setTab("community"); }} /></div>
      )}
      {tab === "inbox" && <Inbox startWithUserId={startThreadWithUserId} />}
      {tab === "settings" && meta.can_manage && (
        <div className="glass-card" style={{ padding: "20px", display: "grid", gap: "16px" }}>
          <section>
            <h3 style={{ fontSize: "15px", marginBottom: "6px" }}>ข้อความส่วนตัว</h3>
            <label style={{ display: "flex", gap: "10px", alignItems: "flex-start", fontSize: "14px" }}>
              <input type="checkbox" checked={!!dmSetting} disabled={dmSetting === null} onChange={e => saveDm(e.target.checked)} style={{ marginTop: "3px" }} />
              <span>อนุญาตให้ผู้เรียนส่งข้อความหากันโดยตรง
                <span style={{ display: "block", fontSize: "12px", color: "var(--text-muted)" }}>ค่าเริ่มต้นปิด: ผู้เรียนส่งข้อความได้เฉพาะผู้สอนของคอร์สที่เรียนและเจ้าหน้าที่</span></span>
            </label>
          </section>
          <section>
            <h3 style={{ fontSize: "15px", marginBottom: "6px" }}>ช่องทางที่พร้อมใช้งาน</h3>
            <ul style={{ fontSize: "14px", margin: 0, paddingLeft: "20px" }}>
              <li>อีเมล: พร้อม (ผ่าน Resend)</li>
              <li>Web Push: {meta.channels.push ? "พร้อม" : "ยังไม่ได้ตั้งค่า VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY"}</li>
              <li>LINE: {meta.channels.line ? "พร้อม" : "ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET"}</li>
            </ul>
          </section>
        </div>
      )}
    </div>
  );
};

export default CommunicationPage;
