import React, { useState } from "react";
import { can, hasRole, useApi, User } from "./hooks/useApi";
import { PublicSite, isPublicPath } from "./site/PublicSite";
import { navigate, useLocation } from "./site/router";
import { Dashboard } from "./pages/Dashboard";
import { HRConsole } from "./pages/HRConsole";
import { InstructorConsole } from "./pages/InstructorConsole";
import { AdminConsole } from "./pages/AdminConsole";
import { SiteManager, SITE_PERMISSIONS } from "./pages/SiteManager";
import { UsersPage } from "./pages/UsersPage";
import { ArticlesStudio } from "./pages/ArticlesStudio";
import { ProfilePage, VerifyEmailBanner } from "./pages/ProfilePage";
import { OrdersPage } from "./pages/OrdersPage";
import { CoursesAdminPage } from "./pages/CoursesAdminPage";
import { PrivacyPanel, PrivacyRequestsPage } from "./pages/PrivacyPages";
import { CertificatesAdminPanel } from "./components/site-admin/CertificatesAdminPanel";
import { VerifyCertificate } from "./pages/VerifyCertificate";
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
  CircleUser
} from "lucide-react";

type ConsoleTab = "dashboard" | "hr" | "instructor" | "admin" | "site" | "articles" | "users"
  | "orders" | "courses" | "certificates" | "privacy" | "profile";

/** Staff menus shown by permission: [tab, label, icon, permissions (any)]. */
const PERMISSION_TABS: Array<[ConsoleTab, string, React.ReactNode, string[]]> = [
  ["orders", "คำสั่งซื้อและการชำระเงิน", <Receipt size={16} />, ["payments.manage"]],
  ["courses", "ตรวจและเผยแพร่คอร์ส", <GraduationCap size={16} />, ["courses.approve"]],
  ["certificates", "ใบประกาศ", <Award size={16} />, ["certificates.manage"]],
  ["privacy", "คำขอข้อมูลส่วนบุคคล", <ShieldAlert size={16} />, ["privacy.manage"]]
];

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

              <nav className="nav-links">
                {canLearn && <li>
                  <button 
                    onClick={() => setCurrentTab("dashboard")}
                    className={`nav-item ${currentTab === "dashboard" ? "active" : ""}`}
                    style={{ width: "100%", background: "none", border: "none", textAlign: "left" }}
                  >
                    <BookOpen size={16} />
                    การเรียนของฉัน
                  </button>
                </li>}

                {/* HR / Corporate Access */}
                {hasRole(api.user, "hr", "partner", "admin") && (
                  <li>
                    <button 
                      onClick={() => setCurrentTab("hr")}
                      className={`nav-item ${currentTab === "hr" ? "active" : ""}`}
                      style={{ width: "100%", background: "none", border: "none", textAlign: "left" }}
                    >
                      <Users size={16} />
                      พาร์ตเนอร์องค์กร
                    </button>
                  </li>
                )}

                {/* Instructor Access */}
                {hasRole(api.user, "instructor", "admin") && (
                  <li>
                    <button 
                      onClick={() => setCurrentTab("instructor")}
                      className={`nav-item ${currentTab === "instructor" ? "active" : ""}`}
                      style={{ width: "100%", background: "none", border: "none", textAlign: "left" }}
                    >
                      <Hammer size={16} />
                      ผู้สอน
                    </button>
                  </li>
                )}

                {/* Global Admin Access */}
                {hasRole(api.user, "admin") && (
                  <li>
                    <button 
                      onClick={() => setCurrentTab("admin")}
                      className={`nav-item ${currentTab === "admin" ? "active" : ""}`}
                      style={{ width: "100%", background: "none", border: "none", textAlign: "left" }}
                    >
                      <ShieldCheck size={16} />
                      ผู้ดูแลระบบ
                    </button>
                  </li>
                )}

                {/* Articles: anyone allowed to write, review or manage them */}
                {can(api.user, "articles.write", "articles.publish", "articles.manage") && (
                  <li>
                    <button 
                      onClick={() => setCurrentTab("articles")}
                      className={`nav-item ${currentTab === "articles" ? "active" : ""}`}
                      style={{ width: "100%", background: "none", border: "none", textAlign: "left" }}
                    >
                      <Newspaper size={16} />
                      บทความ
                    </button>
                  </li>
                )}

                {/* Website content: whoever holds a site.* permission */}
                {can(api.user, ...SITE_PERMISSIONS) && (
                  <li>
                    <button 
                      onClick={() => setCurrentTab("site")}
                      className={`nav-item ${currentTab === "site" ? "active" : ""}`}
                      style={{ width: "100%", background: "none", border: "none", textAlign: "left" }}
                    >
                      <Globe size={16} />
                      จัดการเว็บไซต์
                    </button>
                  </li>
                )}

                {PERMISSION_TABS.filter(([, , , perms]) => can(api.user, ...perms)).map(([key, label, icon]) => (
                  <li key={key}>
                    <button 
                      onClick={() => setCurrentTab(key)}
                      className={`nav-item ${currentTab === key ? "active" : ""}`}
                      style={{ width: "100%", background: "none", border: "none", textAlign: "left" }}
                    >
                      {icon}
                      {label}
                    </button>
                  </li>
                ))}

                {can(api.user, "users.view", "roles.manage") && (
                  <li>
                    <button 
                      onClick={() => setCurrentTab("users")}
                      className={`nav-item ${currentTab === "users" ? "active" : ""}`}
                      style={{ width: "100%", background: "none", border: "none", textAlign: "left" }}
                    >
                      <UserCog size={16} />
                      ผู้ใช้และสิทธิ์
                    </button>
                  </li>
                )}
                <li>
                  <button 
                    onClick={() => setCurrentTab("profile")}
                    className={`nav-item ${currentTab === "profile" ? "active" : ""}`}
                    style={{ width: "100%", background: "none", border: "none", textAlign: "left" }}
                  >
                    <CircleUser size={16} />
                    โปรไฟล์ของฉัน
                  </button>
                </li>
              </nav>

              <div className="sidebar-footer">
                <div style={{ marginBottom: "12px" }}>
                  <p style={{ fontSize: "13px", fontWeight: "700", color: "#ffffff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {api.user?.name}
                  </p>
                  <p style={{ fontSize: "11px", color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {api.user?.email}
                  </p>
                </div>

                <div className="role-tag" style={{ marginBottom: "16px" }}>
                  <span className={`user-badge badge-${api.user?.role || "student"}`} />
                  <span style={{ textTransform: "capitalize", fontWeight: "600", fontSize: "11px" }}>
                    บทบาท: {rolesLabel(api.user)}
                  </span>
                </div>

                <button 
                  onClick={() => { setSessionError(null); api.logout().then(() => navigate("/")).catch((error: Error) => setSessionError("ออกจากระบบไม่สำเร็จ กรุณาลองอีกครั้ง: " + error.message)); }}
                  className="tech-button-outline"
                  style={{ width: "100%", gap: "8px", fontSize: "12px", padding: "8px 12px", border: "1px solid var(--color-brand-primary)", borderRadius: "1rem" }}
                >
                  <LogOut size={14} />
                  ออกจากระบบ
                </button>
              </div>
            </aside>

            {/* Right Main Content Panel */}
            <main className="main-content">
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
                    <AdminConsole onOpenUsers={() => setCurrentTab("users")} />
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
                {currentTab === "certificates" && <motion.div key="certificates" {...pageTransition}><CertificatesAdminPanel /></motion.div>}
                {currentTab === "privacy" && <motion.div key="privacy" {...pageTransition}><PrivacyRequestsPage /></motion.div>}
                {currentTab === "profile" && (
                  <motion.div key="profile" {...pageTransition}>
                    <ProfilePage><PrivacyPanel /></ProfilePage>
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
