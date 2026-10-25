import React, { useState } from "react";
import { can, hasRole, useApi, User } from "./hooks/useApi";
import { PublicSite, isPublicPath } from "./site/PublicSite";
import { navigate, useLocation } from "./site/router";
import { Dashboard } from "./pages/Dashboard";
import { HRConsole } from "./pages/HRConsole";
import { InstructorConsole } from "./pages/InstructorConsole";
import { AdminConsole } from "./pages/AdminConsole";
import { SiteManager, TRAINING_PERMISSIONS } from "./pages/SiteManager";
import { UsersPage } from "./pages/UsersPage";
import { ArticlesStudio } from "./pages/ArticlesStudio";
import { ProfilePage, VerifyEmailBanner } from "./pages/ProfilePage";
import { OrdersPage } from "./pages/OrdersPage";
import { CoursesAdminPage } from "./pages/CoursesAdminPage";
import { PrivacyPanel, PrivacyRequestsPage } from "./pages/PrivacyPages";
import { CertificatesPage, CERTIFICATE_PERMISSIONS } from "./pages/CertificatesPage";
import { AuditPage } from "./pages/AuditPage";
import { VerifyCertificate } from "./pages/VerifyCertificate";
import { AnalyticsDashboard } from "./pages/AnalyticsDashboard";
import { ReportsPage } from "./pages/ReportsPage";
import { GlobalSearch } from "./components/search/GlobalSearch";
import { usePresenceHeartbeat } from "./hooks/usePresence";
import { MarketingPage } from "./pages/MarketingPage";
import { AffiliateDashboard } from "./components/marketing/AffiliateDashboard";
import { sendSignupAttribution } from "./components/marketing/runtime";
import { AssessmentsConsole } from "./components/assessment/CourseAssessments";
import { CourseCategoriesPanel } from "./components/course/CourseCategoriesPanel";
import { WebsiteBuilderPage, WEBSITE_PERMISSIONS } from "./pages/WebsiteBuilderPage";
import { CommunicationPage } from "./pages/CommunicationPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SsoCompletePage } from "./components/settings/SsoLogin";
import { MaintenanceBanner } from "./components/settings/MaintenanceBanner";
import { AiSettingsPanel } from "./components/ai/AiSettingsPanel";
import { NotificationPreferences } from "./components/communication/NotificationPreferences";
import { InstallAppButton } from "./pwa/pwa";
import { CommercePage } from "./components/commerce/CommercePage";
import logo from "../logo/NetPrimeLogo.png";
import { motion, AnimatePresence } from "framer-motion";
import { 
  BookOpen, 
  Users, 
  LogOut, 
  Cpu, 
  Monitor,
  Hammer,
  ShieldCheck,
  Globe,
  Newspaper,
  UserCog,
  Receipt,
  GraduationCap,
  Award,
  ShieldAlert,
  CircleUser,
  BarChart3,
  FileBarChart,
  ClipboardCheck,
  FolderTree,
  Megaphone,
  LayoutTemplate,
  MessagesSquare,
  Settings,
  Sparkles,
  Gift,
  ShoppingBag,
  ChevronDown,
  CalendarDays,
  History
} from "lucide-react";

type ConsoleTab = "dashboard" | "hr" | "instructor" | "admin" | "site" | "articles" | "users"
  | "orders" | "courses" | "certificates" | "privacy" | "profile"
  | "analytics" | "reports" | "assessments" | "categories" | "marketing" | "website" | "communication"
  | "settings" | "ai" | "affiliate" | "commerce" | "audit";

type NavItem = { tab: ConsoleTab; label: string; icon: React.ReactNode; show: (user: User | null) => boolean };
type NavGroup = { id: string; title: string; hint: string; items: NavItem[] };

const perm = (...permissions: string[]) => (user: User | null) => can(user, ...permissions);
const role = (...roles: User["role"][]) => (user: User | null) => hasRole(user, ...roles);

/**
 * Sidebar menu grouped by who uses it: learners, instructors, organizations, coordinators (overview,
 * training, sales, outreach) and system admins. Items appear by role or permission; a user only sees
 * the groups that have at least one item for them. Items that share a tab (reports, communication,
 * articles) show in exactly one group, depending on whether the user has the school-wide permission.
 */
const NAV_GROUPS: NavGroup[] = [
  { id: "learn", title: "การเรียนของฉัน", hint: "คอร์ส บทเรียน ข้อสอบ ใบประกาศ ชุมชน และการชำระเงินของคุณ", items: [
    { tab: "dashboard", label: "ห้องเรียนของฉัน", icon: <BookOpen size={16} />, show: role("student", "admin") },
    { tab: "affiliate", label: "แนะนำเพื่อน", icon: <Gift size={16} />, show: role("student") }
  ] },
  { id: "teach", title: "การสอน", hint: "คอร์สที่คุณสอน ข้อสอบ งานที่ต้องตรวจ และผู้เรียนของคุณ", items: [
    { tab: "instructor", label: "คอร์สที่ฉันสอน", icon: <Hammer size={16} />, show: role("instructor", "admin") },
    { tab: "assessments", label: "การวัดผลและสอบ", icon: <ClipboardCheck size={16} />, show: role("instructor", "admin") },
    { tab: "reports", label: "รายงานคอร์สของฉัน", icon: <FileBarChart size={16} />, show: u => hasRole(u, "instructor") && !can(u, "reports.view") },
    { tab: "communication", label: "ประกาศและข้อความ", icon: <MessagesSquare size={16} />, show: u => hasRole(u, "instructor") && !can(u, "communication.manage") },
    { tab: "articles", label: "เขียนบทความ", icon: <Newspaper size={16} />, show: u => can(u, "articles.write") && !can(u, "articles.publish", "articles.manage") }
  ] },
  { id: "org", title: "องค์กรของฉัน", hint: "พนักงาน ที่นั่ง คอร์สที่องค์กรสนับสนุน และรายงานความคืบหน้า", items: [
    { tab: "hr", label: "พนักงานและที่นั่ง", icon: <Users size={16} />, show: role("hr", "partner") }
  ] },
  { id: "overview", title: "ภาพรวมและรายงาน", hint: "ตัวเลขสำคัญของโรงเรียน กิจกรรมผู้เรียน และรายงานส่งออก", items: [
    { tab: "analytics", label: "แดชบอร์ดโรงเรียน", icon: <BarChart3 size={16} />, show: perm("reports.view") },
    { tab: "reports", label: "รายงาน", icon: <FileBarChart size={16} />, show: perm("reports.view") }
  ] },
  { id: "training", title: "งานอบรมและหลักสูตร", hint: "รอบอบรม ผู้สมัคร การอนุมัติคอร์ส หมวดหมู่ และใบประกาศ", items: [
    { tab: "site", label: "รอบอบรมและผู้สมัคร", icon: <CalendarDays size={16} />, show: perm(...TRAINING_PERMISSIONS) },
    { tab: "courses", label: "ตรวจและเผยแพร่คอร์ส", icon: <GraduationCap size={16} />, show: perm("courses.approve") },
    { tab: "categories", label: "หมวดหมู่คอร์ส", icon: <FolderTree size={16} />, show: perm("courses.approve", "website.design") },
    { tab: "certificates", label: "ใบประกาศ", icon: <Award size={16} />, show: perm(...CERTIFICATE_PERMISSIONS) }
  ] },
  { id: "sales", title: "การขาย", hint: "คำสั่งซื้อ สลิปโอน ใบเสร็จ/ใบกำกับภาษี ชุดคอร์ส สมาชิก และใบเสนอราคา", items: [
    { tab: "orders", label: "คำสั่งซื้อและการชำระเงิน", icon: <Receipt size={16} />, show: perm("payments.manage") },
    { tab: "commerce", label: "สินค้า ชุดคอร์ส ใบเสนอราคา", icon: <ShoppingBag size={16} />, show: perm("commerce.manage") }
  ] },
  { id: "outreach", title: "สื่อสาร การตลาด และเนื้อหา", hint: "ประกาศ อีเมล ชุมชน affiliate บทความ และหน้าเว็บ", items: [
    { tab: "communication", label: "การสื่อสารและชุมชน", icon: <MessagesSquare size={16} />, show: perm("communication.manage") },
    { tab: "marketing", label: "การตลาด", icon: <Megaphone size={16} />, show: perm("marketing.manage") },
    { tab: "articles", label: "บทความ", icon: <Newspaper size={16} />, show: perm("articles.publish", "articles.manage") },
    { tab: "website", label: "เว็บไซต์", icon: <Globe size={16} />, show: perm(...WEBSITE_PERMISSIONS) }
  ] },
  { id: "system", title: "ระบบและผู้ดูแล", hint: "ผู้ใช้ สิทธิ์ องค์กรลูกค้า PDPA AI และการเชื่อมต่อระบบ", items: [
    { tab: "admin", label: "ภาพรวมผู้ดูแลระบบ", icon: <ShieldCheck size={16} />, show: role("admin") },
    { tab: "users", label: "ผู้ใช้และสิทธิ์", icon: <UserCog size={16} />, show: perm("users.view", "roles.manage") },
    { tab: "privacy", label: "คำขอข้อมูลส่วนบุคคล", icon: <ShieldAlert size={16} />, show: perm("privacy.manage") },
    { tab: "audit", label: "ประวัติการแก้ไข", icon: <History size={16} />, show: perm("site.audit") },
    { tab: "ai", label: "ผู้ช่วย AI", icon: <Sparkles size={16} />, show: perm("integrations.manage") },
    { tab: "settings", label: "ตั้งค่าระบบ", icon: <Settings size={16} />, show: perm("integrations.manage") }
  ] }
];

/** The group for the account's primary role goes first, so each person sees their own work at the top. */
const PRIMARY_GROUP: Partial<Record<User["role"], string>> = {
  student: "learn", instructor: "teach", partner: "org", hr: "org", coordinator: "overview", admin: "overview"
};

const ALL_TABS = new Set<string>(["profile", ...NAV_GROUPS.flatMap(g => g.items.map(i => i.tab))]);
const NAV_COLLAPSED_KEY = "netprime.nav.collapsed";

/** Starting console for the primary (highest) role; other roles are reachable from the sidebar. */
function homeTab(role?: User["role"]): ConsoleTab {
  if (role === "admin") return "admin";
  if (role === "coordinator") return "site";
  if (role === "instructor") return "instructor";
  if (role === "partner" || role === "hr") return "hr";
  return "dashboard";
}

/** All roles of the account, e.g. "เจ้าหน้าที่ประสานงาน · ผู้เรียน". */
function rolesLabel(user: User | null): string {
  const roles = user?.roles?.length ? user.roles : [user?.role];
  return roles.map(roleLabel).join(" · ");
}

function roleLabel(role?: User["role"]): string {
  switch (role) {
    case "student": return "ผู้เรียน";
    case "instructor": return "ผู้สอน";
    case "partner":
    case "hr": return "พาร์ตเนอร์องค์กร";
    case "admin": return "ผู้ดูแลระบบ";
    case "coordinator": return "เจ้าหน้าที่ประสานงาน";
    default: return "ผู้เรียน";
  }
}

export const App: React.FC = () => {
  const api = useApi();
  // Re-render on client-side navigation; the URL decides between the public site and the console.
  const location = useLocation();
  const [currentTab, setCurrentTab] = useState<ConsoleTab>(homeTab(api.user?.role));
  const [oauthProcessing, setOauthProcessing] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const processingCode = React.useRef<string | null>(null);
  React.useEffect(() => {
    api.refreshUser().catch((error: Error) => setSessionError(error.message));
  }, [api.refreshUser]);
  React.useEffect(() => {
    setCurrentTab(homeTab(api.user?.role));
  }, [api.user?.id, api.user?.role]);
  const inConsole = !!api.token && !isPublicPath(location.pathname);
  // Learning is a role of its own: staff see it only when they also hold the student role.
  const canLearn = hasRole(api.user, "student", "admin");
  usePresenceHeartbeat();
  const openTab = (tab: string) => { if (ALL_TABS.has(tab)) setCurrentTab(tab as ConsoleTab); };
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(NAV_COLLAPSED_KEY) || "[]"); } catch { return []; }
  });
  const toggleGroup = (id: string) => setCollapsed(prev => {
    const next = prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id];
    try { localStorage.setItem(NAV_COLLAPSED_KEY, JSON.stringify(next)); } catch { /* menu state is a convenience */ }
    return next;
  });
  const visibleGroups = React.useMemo(() => {
    const groups = NAV_GROUPS
      .map(g => ({ ...g, items: g.items.filter(i => i.show(api.user)) }))
      .filter(g => g.items.length > 0);
    const first = PRIMARY_GROUP[api.user?.role ?? "student"];
    return [...groups.filter(g => g.id === first), ...groups.filter(g => g.id !== first)];
  }, [api.user]);
  React.useEffect(() => {
    if (inConsole) document.title = "แดชบอร์ด | NetPrime";
  }, [inConsole]);

  const urlParams = new URLSearchParams(window.location.search);
  const rawCode = urlParams.get("code")?.trim() || null;
  const isCertificate = rawCode && (window.location.pathname === "/verify-certificates" || /^(NP-|CERT-)/i.test(rawCode) || urlParams.has("cert"));
  const verifyCode = isCertificate ? rawCode : null;

  // Auto-process OAuth 2.0 Return Callback (e.g. ?code=xxx&state=yyy)
  React.useEffect(() => {
    const processOAuthRedirect = async () => {
      if (rawCode && !isCertificate && !api.token && /^\/auth\/callback\/(google|github|microsoft)$/.test(window.location.pathname) && processingCode.current !== rawCode) {
        processingCode.current = rawCode;
        try {
          setOauthProcessing(true);
          const provider = window.location.pathname.split("/").pop()!;
          const saved = JSON.parse(sessionStorage.getItem("netprime_oauth") || "null");
          const redirectUri = window.location.origin + window.location.pathname;
          if (!saved || saved.provider !== provider || saved.redirectUri !== redirectUri || saved.state !== urlParams.get("state")) {
            throw new Error("คำขอเข้าสู่ระบบไม่ถูกต้องหรือหมดอายุ กรุณาเริ่มใหม่อีกครั้ง");
          }
          const res = await api.post<{ token: string; user: User }>(`/auth/oauth/${provider}/callback`, {
            code: rawCode, redirectUri, state: saved.state
          });
          sessionStorage.removeItem("netprime_oauth");

          // Clear the OAuth code from the URL and open the console
          window.history.replaceState({}, document.title, "/dashboard");
          handleLoginSuccess(res.token, res.user);
          // Referral/UTM captured before the redirect (email sign-ups send it from the auth dialog).
          sendSignupAttribution(res.token).catch(() => undefined);
        } catch (err: any) {
          console.error("OAuth Exchange failed:", err);
          setSessionError(err.message || "เข้าสู่ระบบไม่สำเร็จ");
          sessionStorage.removeItem("netprime_oauth");
          window.history.replaceState({}, document.title, "/");
        } finally {
          setOauthProcessing(false);
        }
      }
    };

    processOAuthRedirect();
  }, [rawCode]);

  const handleLoginSuccess = (token: string, user: User) => {
    api.saveAuth(token, user);
    
    // Auto-select starting tab based on role permissions
    setCurrentTab(homeTab(user.role));
  };

  const pageTransition = {
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -12 },
    transition: { duration: 0.25, ease: "easeInOut" }
  } as const;

  return (
    <div className="app-container">
      {/* Background neon ambient layout blobs */}
      <div className="ambient-glow-wrapper">
        <div className="glow-blob blob-1" />
        <div className="glow-blob blob-2" />
      </div>

      <AnimatePresence mode="wait">
        {oauthProcessing ? (
          <motion.div
            key="oauth-processing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              minHeight: "100vh",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "16px",
              padding: "20px"
            }}
          >
            <div className="spinner" style={{ border: "3px solid rgba(229,107,37,0.2)", borderTop: "3px solid var(--primary)", borderRadius: "50%", width: "40px", height: "40px", animation: "spin 1s linear infinite" }} />
            <h3 style={{ fontSize: "18px", color: "var(--text-primary)", fontWeight: "700" }}>กำลังตรวจสอบการเข้าสู่ระบบแบบ Single Sign-On...</h3>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>กำลังเชื่อมต่อผู้ให้บริการยืนยันตัวตนขององค์กร</p>
          </motion.div>
        ) : location.pathname === "/auth/sso/complete" ? (
          // Enterprise SSO (OIDC) hands back a one-time ticket in the URL fragment.
          <motion.div key="sso-complete" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ width: "100%" }}>
            <SsoCompletePage onLogin={(token, user) => { handleLoginSuccess(token, user); navigate("/dashboard"); }} />
          </motion.div>
        ) : verifyCode ? (
          // Public Certificate Verification Portal
          <motion.div 
            key="verify-certificate" 
            initial={{ opacity: 0, scale: 0.95 }} 
            animate={{ opacity: 1, scale: 1 }} 
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.25 }}
            style={{ width: "100%" }}
          >
            <VerifyCertificate />
          </motion.div>
        ) : !api.token || isPublicPath(location.pathname) ? (
          // Public website at "/", "/blog" etc. for everyone; the signed-in console lives at /dashboard
          <motion.div 
            key="public-site" 
            initial={{ opacity: 0, y: 20 }} 
            animate={{ opacity: 1, y: 0 }} 
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
            style={{ width: "100%" }}
          >
            <PublicSite loggedIn={!!api.token} onLogin={handleLoginSuccess} />
          </motion.div>
        ) : (
          // Authenticated Workspace Layout
          <motion.div 
            key={`workspace-${api.user?.id}`}
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            style={{ display: "flex", width: "100%", minHeight: "100vh" }}
          >
            {/* Left Navigation Sidebar */}
            <aside className="sidebar">
              <div className="sidebar-brand">
                <img src={logo} alt="โลโก้ NetPrime" style={{ height: "32px", width: "auto" }} />
                NETPRIME<span style={{ color: "var(--primary)" }}>LMS</span>
              </div>

              <div style={{ padding: "0 12px 12px" }}>
                <GlobalSearch onNavigate={t => openTab(t.tab)} />
              </div>
              <nav className="nav-links" aria-label="เมนูหลัก">
                {visibleGroups.map(group => {
                  const open = visibleGroups.length === 1 || !collapsed.includes(group.id) || group.items.some(i => i.tab === currentTab);
                  return (
                    <div key={group.id} className="nav-group">
                      {visibleGroups.length > 1 ? (
                        <button type="button" className="nav-group-title" aria-expanded={open} title={group.hint}
                          onClick={() => toggleGroup(group.id)}>
                          <span>{group.title}</span>
                          <ChevronDown size={14} className={open ? "" : "nav-group-chevron-closed"} />
                        </button>
                      ) : (
                        <div className="nav-group-title" title={group.hint} style={{ cursor: "default" }}>{group.title}</div>
                      )}
                      {open && (
                        <ul className="nav-group-items">
                          {group.items.map(item => (
                            <li key={item.tab}>
                              <button type="button" onClick={() => setCurrentTab(item.tab)}
                                className={`nav-item ${currentTab === item.tab ? "active" : ""}`}
                                aria-current={currentTab === item.tab ? "page" : undefined}>
                                {item.icon}
                                {item.label}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
                <div className="nav-group nav-group-account">
                  <ul className="nav-group-items">
                    <li>
                      <button type="button" onClick={() => setCurrentTab("profile")}
                        className={`nav-item ${currentTab === "profile" ? "active" : ""}`}
                        aria-current={currentTab === "profile" ? "page" : undefined}>
                        <CircleUser size={16} />
                        โปรไฟล์ของฉัน
                      </button>
                    </li>
                  </ul>
                </div>
              </nav>

              <div className="sidebar-footer" style={{ paddingTop: "12px" }}>
                <div style={{ marginBottom: "10px" }}>
                  <p style={{ fontSize: "13px", fontWeight: "700", color: "#ffffff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {api.user?.name}
                  </p>
                  <p style={{ fontSize: "11px", color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={api.user?.email}>
                    {rolesLabel(api.user)}
                  </p>
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <InstallAppButton className="tech-button-outline" label="ติดตั้งแอป" style={{ flex: 1, fontSize: "12px", padding: "7px 10px", borderRadius: "1rem" }} />
                  <button
                    onClick={() => { setSessionError(null); api.logout().then(() => navigate("/")).catch((error: Error) => setSessionError("ออกจากระบบไม่สำเร็จ กรุณาลองอีกครั้ง: " + error.message)); }}
                    className="tech-button-outline"
                    style={{ flex: 1, gap: "6px", fontSize: "12px", padding: "7px 10px", border: "1px solid var(--color-brand-primary)", borderRadius: "1rem" }}
                  >
                    <LogOut size={14} />
                    ออกจากระบบ
                  </button>
                </div>
              </div>
            </aside>

            {/* Right Main Content Panel */}
            <main className="main-content">
              <MaintenanceBanner />
              <VerifyEmailBanner onOpenProfile={() => setCurrentTab("profile")} />
              <AnimatePresence mode="wait">
                {currentTab === "dashboard" && canLearn && (
                  <motion.div key="dashboard" {...pageTransition}>
                    <Dashboard />
                  </motion.div>
                )}
                {currentTab === "hr" && (
                  <motion.div key="hr" {...pageTransition}>
                    <HRConsole />
                  </motion.div>
                )}
                {currentTab === "instructor" && (
                  <motion.div key="instructor" {...pageTransition}>
                    <InstructorConsole />
                  </motion.div>
                )}
                {currentTab === "admin" && (
                  <motion.div key="admin" {...pageTransition}>
                    <AdminConsole onOpenUsers={() => setCurrentTab("users")} onOpenAnalytics={() => setCurrentTab("analytics")} />
                  </motion.div>
                )}
                {currentTab === "site" && (
                  <motion.div key="site" {...pageTransition}>
                    <SiteManager />
                  </motion.div>
                )}
                {currentTab === "articles" && (
                  <motion.div key="articles" {...pageTransition}>
                    <ArticlesStudio />
                  </motion.div>
                )}
                {currentTab === "users" && (
                  <motion.div key="users" {...pageTransition}>
                    <UsersPage />
                  </motion.div>
                )}
                {currentTab === "orders" && <motion.div key="orders" {...pageTransition}><OrdersPage /></motion.div>}
                {currentTab === "courses" && <motion.div key="courses" {...pageTransition}><CoursesAdminPage /></motion.div>}
                {currentTab === "certificates" && <motion.div key="certificates" {...pageTransition}><CertificatesPage /></motion.div>}
                {currentTab === "privacy" && <motion.div key="privacy" {...pageTransition}><PrivacyRequestsPage /></motion.div>}
                {currentTab === "analytics" && <motion.div key="analytics" {...pageTransition}><AnalyticsDashboard onNavigate={t => openTab(t.tab)} onContact={() => setCurrentTab("communication")} /></motion.div>}
                {currentTab === "reports" && <motion.div key="reports" {...pageTransition}><ReportsPage onNavigate={t => openTab(t.tab)} /></motion.div>}
                {currentTab === "assessments" && <motion.div key="assessments" {...pageTransition}><AssessmentsConsole /></motion.div>}
                {currentTab === "categories" && <motion.div key="categories" {...pageTransition}><CourseCategoriesPanel /></motion.div>}
                {currentTab === "communication" && <motion.div key="communication" {...pageTransition}><CommunicationPage /></motion.div>}
                {currentTab === "marketing" && <motion.div key="marketing" {...pageTransition}><MarketingPage /></motion.div>}
                {currentTab === "website" && <motion.div key="website" {...pageTransition}><WebsiteBuilderPage /></motion.div>}
                {currentTab === "ai" && <motion.div key="ai" {...pageTransition}><AiSettingsPanel /></motion.div>}
                {currentTab === "settings" && <motion.div key="settings" {...pageTransition}><SettingsPage onOpenBranding={() => setCurrentTab("website")} /></motion.div>}
                {currentTab === "audit" && <motion.div key="audit" {...pageTransition}><AuditPage /></motion.div>}
                {currentTab === "commerce" && <motion.div key="commerce" {...pageTransition}><CommercePage /></motion.div>}
                {currentTab === "affiliate" && <motion.div key="affiliate" {...pageTransition}><AffiliateDashboard /></motion.div>}
                {currentTab === "profile" && (
                  <motion.div key="profile" {...pageTransition}>
                    <ProfilePage><NotificationPreferences /><PrivacyPanel /></ProfilePage>
                  </motion.div>
                )}
              </AnimatePresence>
            </main>
          </motion.div>
        )}
      </AnimatePresence>

      {sessionError && <div role="alert" style={{ position: "fixed", bottom: 20, right: 20, zIndex: 11000, padding: 16, maxWidth: 420, background: "#fff", color: "#991b1b", border: "1px solid #ef4444", borderRadius: 12 }}>
        {sessionError} <button onClick={() => setSessionError(null)} aria-label="ปิดข้อความ">×</button>
      </div>}
    </div>
  );
};
export default App;
