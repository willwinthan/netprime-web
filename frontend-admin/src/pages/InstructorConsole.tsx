import React, { useState, useEffect } from "react";
import { useApi, hasRole } from "../hooks/useApi";
import { Chip } from "../components/site-admin/ui";
import { COURSE_STATUS, CourseStatus } from "./CoursesAdminPage";
import { MetricsCard } from "../components/MetricsCard";
import { CourseWorkspace } from "../components/instructor/CourseWorkspace";
import { StudentEmailLookup } from "../components/instructor/StudentEmailLookup";
import { InstructorCourse, WorkspaceTab, isWorkspaceTab } from "../components/instructor/types";
import { navigate, useLocation } from "../site/router";
import { CourseBuilder } from "../components/course/CourseBuilder";
import { AiInstructorTools } from "../components/ai/AiInstructorTools";
import { motion, AnimatePresence } from "framer-motion";
import { 
  BookOpen, 
  MoreHorizontal, 
  PlusCircle, 
  Film, 
  Plus, 
  TrendingUp, 
  Users,
  LayoutGrid,
  ClipboardList,
  Youtube,
  FileText,
  Trash2,
  Edit,
  ArrowLeft,
  Ticket,
  Tag,
  Calendar,
  ShieldAlert,
  Key,
  Check,
  Search,
  X
} from "lucide-react";
import { useDangerousDelete } from "../components/security/DangerConfirmDialog";

interface RecentActivity {
  name: string;
  email: string;
  course_title: string;
  progress_percent: number;
  completed_at: string | null;
}

interface InstructorAnalytics {
  totalCourses: number;
  totalStudents: number;
  averageCohortProgress: number;
  courses: InstructorCourse[];
  recentActivity: RecentActivity[];
}

const PROVIDER_LABELS: Record<string, string> = {
  cloudflare: "อัปโหลดเข้าระบบ",
  youtube: "YouTube",
  vimeo: "Vimeo",
};

/**
 * Pages of the console besides the course list and a course's workspace. The open page is kept in the
 * URL (?view=...) next to the course (?course=<id>&tab=<tab>), so Back and refresh behave.
 * "dashboard" and "curriculum" both mean "no page open": the list, or the open course's workspace.
 */
type ConsoleView =
  | "dashboard"
  | "curriculum"
  | "create-course"
  | "vouchers"
  | "groups"
  | "telemetry"
  | "qa";

const PAGE_VIEWS: ConsoleView[] = ["create-course", "vouchers", "groups", "telemetry", "qa"];

export const InstructorConsole: React.FC = () => {
  const api = useApi();
  const { confirmDelete, dangerDialog } = useDangerousDelete();
  const isAdmin = hasRole(api.user, "admin");
  const [data, setData] = useState<InstructorAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Navigation View State
  const location = useLocation();
  const viewParam = location.searchParams.get("view") as ConsoleView | null;
  const courseParam = location.searchParams.get("course");
  const tabParam = location.searchParams.get("tab");
  const workspaceTab: WorkspaceTab = isWorkspaceTab(tabParam) ? tabParam : "overview";
  const requestedView: ConsoleView = viewParam && PAGE_VIEWS.includes(viewParam) ? viewParam : "dashboard";

  /** Opens a page (pushes ?view=), or closes the open one with "dashboard" / "curriculum". */
  const setView = (next: ConsoleView) => {
    const url = new URL(window.location.href);
    if (!PAGE_VIEWS.includes(next)) {
      if (!url.searchParams.has("view")) return;
      // Pages we opened are their own history entry: go back to it so Forward/Back stay natural.
      if (window.history.state?.npConsolePage) { window.history.back(); return; }
      url.searchParams.delete("view");
      navigate(url.pathname + url.search, { replace: true });
      return;
    }
    const replace = url.searchParams.has("view");
    url.searchParams.set("view", next);
    navigate(url.pathname + url.search, { replace, state: { npConsolePage: true } });
  };
  const openCourse = (courseId: string, tab: WorkspaceTab = "overview", replace = false) =>
    navigate(`${window.location.pathname}?course=${encodeURIComponent(courseId)}&tab=${tab}`, { replace });
  const closeCourse = () => navigate(window.location.pathname);
  // Course list: search, status filter and the "เพิ่มเติม" menu for occasional tools
  const [courseQuery, setCourseQuery] = useState("");
  const [courseFilter, setCourseFilter] = useState<"all" | CourseStatus>("all");
  const [moreOpen, setMoreOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Add Course state
  const [courseTitle, setCourseTitle] = useState("");
  const [courseDesc, setCourseDesc] = useState("");
  const [courseThumb, setCourseThumb] = useState("");

  // Course CRUD state

  // Curriculum State
  const [selectedCourseForCurriculum, setSelectedCourseForCurriculum] = useState<InstructorCourse | null>(null);
  const [curriculumLessons, setCurriculumLessons] = useState<any[]>([]);
  const [curriculumLoading, setCurriculumLoading] = useState(false);

  // Extended course metadata
  const [coursePrice, setCoursePrice] = useState<number>(0);
  const [courseCover, setCourseCover] = useState<string>("");
  const [courseDuration, setCourseDuration] = useState<string>("");


  // Access Control states

  // Voucher states
  const [vouchers, setVouchers] = useState<any[]>([]);
  const [voucherCode, setVoucherCode] = useState<string>("");
  const [voucherDiscountType, setVoucherDiscountType] = useState<"percent" | "fixed">("percent");
  const [voucherDiscountValue, setVoucherDiscountValue] = useState<number>(0);
  const [voucherCourseId, setVoucherCourseId] = useState<string>("");
  const [voucherExpiry, setVoucherExpiry] = useState<string>("");
  const [voucherMaxUses, setVoucherMaxUses] = useState<string>("");

  // Group states
  const [groups, setGroups] = useState<any[]>([]);
  const [groupName, setGroupName] = useState<string>("");
  const [selectedGroup, setSelectedGroup] = useState<any | null>(null);
  const [groupMembers, setGroupMembers] = useState<any[]>([]);
  const [groupMemberSearchUserId, setGroupMemberSearchUserId] = useState<string>("");
  const [allStudents, setAllStudents] = useState<any[]>([]);



  // Telemetry & Audit states
  const [quizFailures, setQuizFailures] = useState<any[]>([]);
  const [videoStuck, setVideoStuck] = useState<any[]>([]);
  const [telemetryLoading, setTelemetryLoading] = useState(false);

  // Central Q&A states
  const [instructorQuestions, setInstructorQuestions] = useState<any[]>([]);
  const [instructorQaLoading, setInstructorQaLoading] = useState(false);
  const [qaReplyTexts, setQaReplyTexts] = useState<Record<string, string>>({});
  const [qaRepliesMap, setQaRepliesMap] = useState<Record<string, any[]>>({});
  const [qaRepliesLoadingMap, setQaRepliesLoadingMap] = useState<Record<string, boolean>>({});

  // File upload helper: files up to 100 MB stream through the Worker into R2 (server-issued key);
  // larger videos go directly to Cloudflare Stream with tus and return the Stream video UID.
  const handleSubmitForReview = async (course: InstructorCourse) => {
    if (!window.confirm(`ส่งคอร์ส "${course.title}" ให้ผู้ตรวจ? ระหว่างรอตรวจยังแก้ไขเนื้อหาได้`)) return;
    try {
      setActionLoading(true);
      setError(null);
      await api.post(`/instructor/courses/${course.id}/submit`, {});
      await fetchAnalytics();
    } catch (err: any) {
      setError(err.message || "ส่งตรวจไม่สำเร็จ");
    } finally {
      setActionLoading(false);
    }
  };

  // Fetch Telemetry Audits
  const fetchTelemetry = async () => {
    try {
      setTelemetryLoading(true);
      const qFailures = await api.get<any[]>("/instructor/telemetry/quiz-failures");
      const vStuck = await api.get<any[]>("/instructor/telemetry/video-stuck");
      setQuizFailures(qFailures || []);
      setVideoStuck(vStuck || []);
    } catch (err: any) {
      console.error("Failed to fetch telemetry:", err);
    } finally {
      setTelemetryLoading(false);
    }
  };

  // Fetch Instructor Central Q&A threads
  const fetchInstructorQuestions = async () => {
    try {
      setInstructorQaLoading(true);
      const questions = await api.get<any[]>("/instructor/qa");
      setInstructorQuestions(questions || []);
      if (questions && questions.length > 0) {
        for (const q of questions) {
          fetchQuestionReplies(q.id, q.lesson_id);
        }
      }
    } catch (err: any) {
      console.error("Failed to fetch instructor questions:", err);
    } finally {
      setInstructorQaLoading(false);
    }
  };

  const fetchQuestionReplies = async (questionId: string, lessonId: string) => {
    try {
      setQaRepliesLoadingMap(prev => ({ ...prev, [questionId]: true }));
      const threads = await api.get<any[]>(`/lessons/${lessonId}/qa`);
      const thread = threads?.find((t: any) => t.id === questionId);
      if (thread) {
        setQaRepliesMap(prev => ({ ...prev, [questionId]: thread.replies || [] }));
      }
    } catch (err) {
      console.error("Failed to fetch question replies:", err);
    } finally {
      setQaRepliesLoadingMap(prev => ({ ...prev, [questionId]: false }));
    }
  };

  const handlePostInstructorReply = async (questionId: string, lessonId: string) => {
    const text = qaReplyTexts[questionId];
    if (!text || !text.trim()) return;
    try {
      const res = await api.post<any>(`/lessons/${lessonId}/qa`, {
        content: text.trim(),
        parent_id: questionId
      });
      setQaRepliesMap(prev => ({
        ...prev,
        [questionId]: [...(prev[questionId] || []), res]
      }));
      setQaReplyTexts(prev => ({ ...prev, [questionId]: "" }));
    } catch (err: any) {
      alert("ส่งคำตอบไม่สำเร็จ: " + err.message);
    }
  };

  const fetchAnalytics = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.get<InstructorAnalytics>("/instructor/analytics");
      setData(res);

    } catch (err: any) {
      console.error(err);
      setError(err.message || "โหลดคอนโซลผู้สอนไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  };

  const fetchVouchers = async () => {
    try {
      setActionLoading(true);
      const res = await api.get<any[]>("/instructor/vouchers");
      setVouchers(res);
    } catch (err: any) {
      console.error(err);
      alert(err.message || "โหลดโค้ดส่วนลดไม่สำเร็จ");
    } finally {
      setActionLoading(false);
    }
  };

  const fetchGroups = async () => {
    try {
      setActionLoading(true);
      const res = await api.get<any[]>("/instructor/groups");
      setGroups(res);
    } catch (err: any) {
      console.error(err);
      alert(err.message || "โหลดกลุ่มเรียนไม่สำเร็จ");
    } finally {
      setActionLoading(false);
    }
  };

  useEffect(() => {
    if (hasRole(api.user, "instructor", "admin")) fetchAnalytics();
  }, [api.token]);

  // The open course comes from the URL (?course=<id>); load its lessons when it changes.
  const missingCourseCheck = React.useRef<string | null>(null);
  const openCourseData = courseParam ? data?.courses.find(c => c.id === courseParam) ?? null : null;
  useEffect(() => {
    if (!courseParam) { setSelectedCourseForCurriculum(null); return; }
    if (!data) return;
    if (!openCourseData) {
      // The URL can change before the list that contains a just-created course is rendered:
      // reload the list once, and only then treat the course as gone (deleted / not this instructor's).
      if (missingCourseCheck.current !== courseParam) { missingCourseCheck.current = courseParam; fetchAnalytics(); return; }
      navigate(window.location.pathname, { replace: true });
      return;
    }
    setSelectedCourseForCurriculum(openCourseData);
    if (selectedCourseForCurriculum?.id !== openCourseData.id) loadCurriculum(openCourseData.id);
  }, [courseParam, data]);

  const view: ConsoleView = requestedView;
  // List pages load their data when opened, including after a refresh.
  useEffect(() => {
    if (view === "vouchers") fetchVouchers();
    else if (view === "groups") fetchGroups();
    else if (view === "telemetry") fetchTelemetry();
    else if (view === "qa") fetchInstructorQuestions();
  }, [view]);

  const handleAddCourse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!courseTitle || !courseDesc) {
      setModalError("กรุณากรอกชื่อคอร์สและคำอธิบาย");
      return;
    }

    try {
      setActionLoading(true);
      setModalError(null);
      
      const created = await api.post<{ course: { id: string } }>("/instructor/courses", {
        title: courseTitle,
        description: courseDesc,
        thumbnail_url: courseThumb || undefined,
        price: Number(coursePrice),
        cover_image_url: courseCover || undefined,
        access_duration_days: courseDuration ? Number(courseDuration) : null
      });

      // Reset fields and return
      setCourseTitle("");
      setCourseDesc("");
      setCourseThumb("");
      setCoursePrice(0);
      setCourseCover("");
      setCourseDuration("");

      await fetchAnalytics();
      // Straight into the new course, replacing the create form in the history.
      if (created?.course?.id) openCourse(created.course.id, "content", true);
      else setView("dashboard");
    } catch (err: any) {
      console.error(err);
      setModalError(err.message || "บันทึกคอร์สใหม่ไม่สำเร็จ");
    } finally {
      setActionLoading(false);
    }
  };

  // Course Operations
  const handleDeleteCourse = async (courseId: string) => {
    try {
      setError(null);
      // Always an emailed code from the course owner or an admin; a course with learners or orders is archived instead.
      const done = await confirmDelete<{ message: string; archived?: boolean }>({ action: "course.delete", targetId: courseId,
        path: `/instructor/courses/${courseId}`, confirmMessage: "คุณแน่ใจหรือไม่ว่าต้องการลบคอร์สนี้และบทเรียนทั้งหมด? การดำเนินการนี้ไม่สามารถย้อนกลับได้" });
      if (!done) return;
      if (done.archived) alert(done.message);
      setActionLoading(true);
      await fetchAnalytics();
      if (courseParam === courseId) closeCourse();
    } catch (err: any) {
      console.error(err);
      setError(err.message || "ลบคอร์สไม่สำเร็จ");
    } finally {
      setActionLoading(false);
    }
  };

  // Curriculum Operations
  const loadCurriculum = async (courseId: string) => {
    try {
      setCurriculumLoading(true);
      const res = await api.get<any>(`/courses/${courseId}`);
      setCurriculumLessons(res.lessons || []);
    } catch (err: any) {
      console.error(err);
      alert("โหลดเนื้อหาหลักสูตรไม่สำเร็จ");
    } finally {
      setCurriculumLoading(false);
    }
  };

  const handleManageCurriculumClick = (course: InstructorCourse) => openCourse(course.id, "content");

  // Lesson Operations
  const handleDeleteLesson = async (lessonId: string) => {
    try {
      // A course with learners needs an emailed code (owner or admin); otherwise the simple confirm.
      const done = await confirmDelete({ action: "lesson.delete", targetId: lessonId, path: `/instructor/lessons/${lessonId}`,
        confirmMessage: "คุณแน่ใจหรือไม่ว่าต้องการลบบทเรียนนี้?" });
      if (!done) return;
      setActionLoading(true);
      if (selectedCourseForCurriculum) {
        await loadCurriculum(selectedCourseForCurriculum.id);
      }
      await fetchAnalytics();
    } catch (err: any) {
      console.error(err);
      alert(err.message || "ลบบทเรียนไม่สำเร็จ");
    } finally {
      setActionLoading(false);
    }
  };

  const renderDashboard = () => {
    const query = courseQuery.trim().toLowerCase();
    const visibleCourses = (data?.courses ?? []).filter(course =>
      (courseFilter === "all" || course.status === courseFilter) && (!query || course.title.toLowerCase().includes(query)));
    return (
      <div>
        <div className="header-row">
          <div>
            <h1 className="header-title">คอนโซลผู้สอน</h1>
            <p className="header-desc">
              สวัสดี อาจารย์{api.user?.name || "ผู้สอน"} • สร้างคอร์ส เพิ่มบทเรียน แล้วกด "ส่งตรวจ" เมื่อพร้อมเผยแพร่
            </p>
          </div>

          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <button 
              onClick={() => {
                setView("qa");
              }}
              className="tech-button-outline"
              style={{ borderRadius: "1rem", display: "flex", alignItems: "center", gap: "6px" }}
            >
              <ClipboardList size={16} />
              ถามตอบ
            </button>
            <div style={{ position: "relative" }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setMoreOpen(false); }}>
              <button
                type="button"
                onClick={() => setMoreOpen(open => !open)}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                className="tech-button-outline"
                style={{ borderRadius: "1rem", display: "flex", alignItems: "center", gap: "6px" }}
              >
                <MoreHorizontal size={16} />
                เพิ่มเติม
              </button>
              {moreOpen && (
                <div role="menu" className="glass-card" style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 50, background: "#fff", padding: "6px", minWidth: "220px", display: "grid", gap: "2px" }}>
                  {([
                    ["โค้ดส่วนลด", <Ticket size={15} />, () => setView("vouchers")],
                    ["กลุ่มเรียน", <Users size={15} />, () => setView("groups")],
                    ["จุดที่ผู้เรียนติดขัด", <TrendingUp size={15} />, () => setView("telemetry")]
                  ] as [string, React.ReactNode, () => void][]).map(([label, icon, open]) => (
                    <button key={label} type="button" role="menuitem" onClick={() => { setMoreOpen(false); open(); }}
                      style={{ display: "flex", alignItems: "center", gap: "8px", padding: "9px 12px", border: "none", background: "none", borderRadius: "0.6rem", cursor: "pointer", fontFamily: "inherit", fontSize: "14px", color: "var(--text-primary)", textAlign: "left" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--primary-glow)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "none")}>
                      {icon}{label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <AiInstructorTools courses={data?.courses ?? []} onChanged={() => fetchAnalytics()} />
            <button 
              onClick={() => {
                setModalError(null);
                setCourseTitle("");
                setCourseDesc("");
                setCourseThumb("");
                setCoursePrice(0);
                setCourseCover("");
                setCourseDuration("");
                setView("create-course");
              }}
              className="tech-button-primary"
              style={{ borderRadius: "1rem", display: "flex", alignItems: "center", gap: "6px" }}
            >
              <Plus size={16} />
              สร้างคอร์ส
            </button>
          </div>
        </div>

        {error && (
          <div className="glass-card" style={{ borderLeft: "4px solid var(--danger)", background: "rgba(239, 68, 68, 0.08)", color: "var(--danger)", padding: "16px", marginBottom: "24px" }}>
            <strong>ข้อผิดพลาด:</strong> {error}
          </div>
        )}

        {loading && !data ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "64px" }}>
            <div className="spinner" style={{ border: "3px solid var(--border-subtle)", borderTop: "3px solid var(--primary)", borderRadius: "50%", width: "40px", height: "40px", animation: "spin 1s linear infinite" }} />
          </div>
        ) : data ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
            
            {/* Top Row: Metrics Cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "24px" }}>
              <MetricsCard
                title="คอร์สที่เปิดสอน"
                value={data.totalCourses}
                subValue="คอร์สทั้งหมดของคุณ"
                icon="BookOpen"
                color="blue"
              />
              
              <MetricsCard
                title="ผู้เรียนที่ลงทะเบียนอยู่"
                value={data.totalStudents}
                subValue="รวมทุกคอร์ส"
                icon="Users"
                color="accent"
              />

              <MetricsCard
                title="ความคืบหน้าเฉลี่ยของผู้เรียน"
                value={`${data.averageCohortProgress}%`}
                subValue="ความคืบหน้าเฉลี่ยของผู้เรียนทั้งหมด"
                icon="TrendingUp"
                color="purple"
              />
            </div>

            <div className="dashboard-grid">
              
              {/* Left side: Course list */}
              <div className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                <h3 style={{ fontSize: "18px", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
                  <LayoutGrid size={18} color="var(--primary)" />
                  คอร์สของฉัน
                </h3>

                {data.courses.length > 0 && (
                  <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
                    <div style={{ position: "relative", flex: "1 1 220px" }}>
                      <Search size={15} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }} />
                      <input className="form-input" type="search" value={courseQuery} onChange={e => setCourseQuery(e.target.value)}
                        placeholder="ค้นหาชื่อคอร์ส" aria-label="ค้นหาชื่อคอร์ส" style={{ paddingLeft: 34, width: "100%" }} />
                    </div>
                    <div role="group" aria-label="กรองตามสถานะ" style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      {(["all", "draft", "review", "published", "archived"] as const)
                        .filter(key => key === "all" || data.courses.some(c => c.status === key))
                        .map(key => {
                          const count = key === "all" ? data.courses.length : data.courses.filter(c => c.status === key).length;
                          const active = courseFilter === key;
                          return (
                            <button key={key} type="button" aria-pressed={active} onClick={() => setCourseFilter(key)}
                              style={{ padding: "6px 12px", borderRadius: "999px", fontSize: "13px", fontFamily: "inherit", cursor: "pointer",
                                border: `1px solid ${active ? "var(--primary)" : "var(--border-subtle)"}`,
                                background: active ? "var(--primary-glow)" : "#fff", color: active ? "var(--color-brand-primary, var(--primary))" : "var(--text-secondary)", fontWeight: active ? 700 : 500 }}>
                              {key === "all" ? "ทั้งหมด" : COURSE_STATUS[key].label} {count}
                            </button>
                          );
                        })}
                    </div>
                  </div>
                )}

                {data.courses.length === 0 ? (
                  <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
                    ยังไม่มีคอร์สในระบบ กด "สร้างคอร์ส" เพื่อเพิ่มคอร์สใหม่
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                    {visibleCourses.length === 0 && (
                      <div style={{ padding: "24px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>ไม่พบคอร์สที่ตรงกับการค้นหา</div>
                    )}
                    {visibleCourses.map((course) => (
                      <div 
                        key={course.id} 
                        style={{ 
                          display: "flex", 
                          flexDirection: "column",
                          padding: "16px", 
                          background: "rgba(255,255,255,0.4)", 
                          border: "1px solid var(--border-subtle)", 
                          borderRadius: "1rem",
                          gap: "16px"
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", width: "100%", flexWrap: "wrap" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "16px", flexGrow: 1, minWidth: 0 }}>
                            <img 
                              src={course.thumbnail_url} 
                              alt={course.title} 
                              style={{ width: "64px", height: "48px", borderRadius: "0.5rem", objectFit: "cover", border: "1px solid var(--border-active)" }} 
                            />
                            <div>
                              <h4 style={{ fontSize: "15px", fontWeight: "700", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <button type="button" onClick={() => openCourse(course.id)} title="เปิดคอร์สนี้"
                                  style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }}>
                                  {course.title}
                                </button>
                                {COURSE_STATUS[course.status] && <Chip {...COURSE_STATUS[course.status]} />}
                              </h4>
                              <p style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>
                                สร้างเมื่อ {new Date(course.created_at).toLocaleDateString("th-TH")}
                                {course.status === "review" && course.submitted_at && ` • ส่งตรวจเมื่อ ${new Date(course.submitted_at).toLocaleDateString("th-TH")}`}
                              </p>
                            </div>
                          </div>

                          <div style={{ display: "flex", gap: "24px", alignItems: "center", flexShrink: 0 }}>
                            <div style={{ textAlign: "right" }}>
                              <span style={{ fontSize: "11px", color: "var(--text-secondary)", display: "block" }}>การลงทะเบียนเรียน</span>
                              <span style={{ fontSize: "13px", fontWeight: "700", color: "var(--text-primary)" }}>{course.student_count} คน</span>
                            </div>

                            <div style={{ textAlign: "right" }}>
                              <span style={{ fontSize: "11px", color: "var(--text-secondary)", display: "block" }}>ความคืบหน้าเฉลี่ย</span>
                              <span style={{ fontSize: "13px", fontWeight: "700", color: "var(--color-brand-primary)" }}>
                                {course.avg_progress !== null ? `${Math.round(course.avg_progress)}%` : "ไม่มีข้อมูล"}
                              </span>
                            </div>
                          </div>
                        </div>

                        {course.status === "draft" && course.review_note && (
                          <div role="note" style={{ fontSize: "12px", color: "#9a5b00", background: "rgba(245,158,11,0.1)", borderRadius: "0.75rem", padding: "10px 12px" }}>
                            <strong>ผู้ตรวจส่งกลับให้แก้ไข:</strong> {course.review_note}
                          </div>
                        )}
                        {course.status === "draft" && !course.review_note && (
                          <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                            ฉบับร่างยังไม่แสดงในแคตตาล็อก เพิ่มบทเรียนแล้วกด "ส่งตรวจ" เพื่อให้ผู้ตรวจอนุมัติ
                          </div>
                        )}

                        {/* Course Action Buttons */}
                        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", borderTop: "1px solid var(--border-subtle)", paddingTop: "12px", flexWrap: "wrap" }}>
                          {course.status === "draft" && (
                            <button
                              onClick={() => handleSubmitForReview(course)}
                              disabled={actionLoading}
                              className="tech-button-primary"
                              style={{ padding: "6px 12px", fontSize: "12px", borderRadius: "0.5rem" }}
                            >
                              ส่งตรวจ
                            </button>
                          )}
                          <button
                            onClick={() => openCourse(course.id, "learners")}
                            className="tech-button-outline"
                            style={{ padding: "6px 12px", fontSize: "12px", borderRadius: "0.5rem" }}
                          >
                            ผู้เรียน
                          </button>
                          <button
                            onClick={() => openCourse(course.id)}
                            className={course.status === "draft" ? "tech-button-outline" : "tech-button-primary"}
                            style={{ padding: "6px 12px", fontSize: "12px", borderRadius: "0.5rem" }}
                          >
                            จัดการคอร์ส
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Right side: Recent Activity */}
              <div className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                <h3 style={{ fontSize: "16px", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
                  <ClipboardList size={16} color="var(--primary)" />
                  กิจกรรมการเรียนล่าสุด
                </h3>

                {data.recentActivity.length === 0 ? (
                  <div style={{ padding: "20px", textAlign: "center", color: "var(--text-muted)", fontSize: "12px" }}>
                    ยังไม่มีบันทึกกิจกรรมการเรียนของผู้เรียน
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    {data.recentActivity.map((act, index) => (
                      <div 
                        key={index} 
                        style={{ 
                          padding: "12px", 
                          background: "rgba(0,0,0,0.02)", 
                          border: "1px solid var(--border-subtle)", 
                          borderRadius: "1rem", 
                          fontSize: "12px" 
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: "600", marginBottom: "4px" }}>
                          <span style={{ color: "var(--text-primary)" }}>{act.name}</span>
                          <span style={{ color: "var(--primary)" }}>ความคืบหน้า {act.progress_percent}%</span>
                        </div>
                        <p style={{ color: "var(--text-secondary)", fontSize: "11px" }}>คอร์ส: {act.course_title}</p>
                        {act.completed_at && (
                          <span className="badge-gamified" style={{ display: "inline-block", marginTop: "6px", textTransform: "none", fontSize: "10px", backgroundColor: "rgba(16,185,129,0.1)", color: "var(--accent)", borderColor: "rgba(16,185,129,0.2)" }}>
                            ✓ เรียนจบเมื่อ {new Date(act.completed_at).toLocaleDateString("th-TH")}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

            </div>

          </div>
        ) : null}
      </div>
    );
  };

  const renderCreateCourse = () => {
    return (
      <div className="glass-card animate-fade-in" style={{ padding: "32px", border: "1px solid var(--border-subtle)", borderRadius: "1.5rem" }}>
        <button 
          onClick={() => setView("dashboard")} 
          style={{ display: "flex", alignItems: "center", gap: "8px", background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: "14px", fontWeight: "600", marginBottom: "24px" }}
        >
          <ArrowLeft size={16} />
          กลับไปแดชบอร์ด
        </button>

        <h3 style={{ fontSize: "24px", display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px", color: "var(--text-primary)" }}>
          <PlusCircle size={24} color="var(--primary)" />
          สร้างคอร์สใหม่
        </h3>
        <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginBottom: "24px" }}>
          กรอกรายละเอียดด้านล่างเพื่อเผยแพร่คอร์สใหม่ลงในระบบ
        </p>

        {modalError && (
          <div style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", color: "var(--danger)", padding: "12px", borderRadius: "1rem", fontSize: "13px", marginBottom: "20px" }}>
            <strong>ข้อผิดพลาด:</strong> {modalError}
          </div>
        )}

        <form onSubmit={handleAddCourse} style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div className="form-group">
            <label className="form-label">ชื่อคอร์ส</label>
            <input
              type="text"
              placeholder="เช่น พื้นฐานระบบเครือข่ายสำหรับผู้เริ่มต้น"
              value={courseTitle}
              onChange={(e) => setCourseTitle(e.target.value)}
              className="form-input"
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label">คำอธิบาย</label>
            <textarea
              rows={6}
              placeholder="อธิบายโครงสร้างคอร์ส สิ่งที่ผู้เรียนจะได้เรียนรู้ และเทคโนโลยีที่ใช้..."
              value={courseDesc}
              onChange={(e) => setCourseDesc(e.target.value)}
              className="form-input"
              style={{ resize: "none", fontFamily: "inherit", borderRadius: "1rem" }}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label">URL รูปปก (ไม่บังคับ)</label>
            <input
              type="url"
              placeholder="https://images.unsplash.com/... (URL รูปภาพ)"
              value={courseThumb}
              onChange={(e) => setCourseThumb(e.target.value)}
              className="form-input"
            />
          </div>

          <div className="form-group">
            <label className="form-label">URL แบนเนอร์หน้าปก (ไม่บังคับ)</label>
            <input
              type="url"
              placeholder="https://images.unsplash.com/... (URL รูปแบนเนอร์ขนาดใหญ่)"
              value={courseCover}
              onChange={(e) => setCourseCover(e.target.value)}
              className="form-input"
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div className="form-group">
              <label className="form-label">ราคาคอร์ส (บาท)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="เช่น 149.00 (ใส่ 0 หากเป็นคอร์สฟรี)"
                value={coursePrice === 0 ? "" : coursePrice}
                onChange={(e) => setCoursePrice(Number(e.target.value))}
                className="form-input"
              />
            </div>

            <div className="form-group">
              <label className="form-label">ระยะเวลาเข้าถึง (วัน)</label>
              <input
                type="number"
                min="1"
                placeholder="เช่น 30 (เว้นว่างหากเข้าถึงตลอดชีพ)"
                value={courseDuration}
                onChange={(e) => setCourseDuration(e.target.value)}
                className="form-input"
              />
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "12px" }}>
            <button type="button" onClick={() => setView("dashboard")} className="tech-button-outline" style={{ borderRadius: "1rem" }}>ยกเลิก</button>
            <button type="submit" disabled={actionLoading} className="tech-button-primary" style={{ borderRadius: "1rem" }}>
              {actionLoading ? "กำลังบันทึก..." : "สร้างคอร์ส"}
            </button>
          </div>
        </form>
      </div>
    );
  };

  /** One course with its tabs (components/instructor/CourseWorkspace.tsx). */
  const renderWorkspace = (course: InstructorCourse) => {
    return (
      <>
        {error && (
          <div className="glass-card" style={{ borderLeft: "4px solid var(--danger)", background: "rgba(239, 68, 68, 0.08)", color: "var(--danger)", padding: "16px", marginBottom: "16px" }}>
            {error}
          </div>
        )}
        <CourseWorkspace
          course={course}
          tab={workspaceTab}
          onTabChange={tab => openCourse(course.id, tab)}
          onBack={closeCourse}
          onSubmitForReview={() => handleSubmitForReview(course)}
          onDelete={() => handleDeleteCourse(course.id)}
          onCourseChanged={() => fetchAnalytics()}
          busy={actionLoading}
          lessonsVersion={curriculumLessons}
          aiTools={<AiInstructorTools courses={data?.courses ?? []} course={course} lessons={curriculumLessons}
            onChanged={() => loadCurriculum(course.id)} />}
          content={
            <CourseBuilder
              courseId={course.id}
              refreshToken={curriculumLessons}
              onDeleteLesson={lessonId => handleDeleteLesson(lessonId)}
            />
          }
        />
      </>
    );
  };

  const renderVouchers = () => {
    return (
      <div className="glass-card animate-fade-in" style={{ padding: "32px", border: "1px solid var(--border-subtle)", borderRadius: "1.5rem" }}>
        <button 
          onClick={() => setView("dashboard")} 
          style={{ display: "flex", alignItems: "center", gap: "8px", background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: "14px", fontWeight: "600", marginBottom: "24px" }}
        >
          <ArrowLeft size={16} />
          กลับไปแดชบอร์ด
        </button>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px", flexWrap: "wrap", gap: "16px" }}>
          <div>
            <h3 style={{ fontSize: "24px", display: "flex", alignItems: "center", gap: "8px", color: "var(--text-primary)" }}>
              <Ticket size={24} color="var(--primary)" />
              โค้ดส่วนลด
            </h3>
            <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginTop: "4px" }}>
              สร้างโค้ดส่วนลดสำหรับการชำระเงินของผู้เรียน
            </p>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "32px" }}>
          {/* Create Voucher Form */}
          <div className="glass-card" style={{ padding: "24px", background: "rgba(255, 255, 255, 0.45)", borderRadius: "1.25rem", border: "1px solid var(--border-subtle)" }}>
            <h4 style={{ fontSize: "16px", fontWeight: "700", marginBottom: "16px", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "6px" }}>
              <PlusCircle size={18} color="var(--primary)" />
              สร้างโค้ดส่วนลดใหม่
            </h4>
            <form onSubmit={async (e) => {
              e.preventDefault();
              if (!voucherCode || voucherDiscountValue <= 0) {
                alert("กรุณาระบุโค้ดและมูลค่าส่วนลดที่ถูกต้อง");
                return;
              }
              try {
                setActionLoading(true);
                await api.post("/instructor/vouchers", {
                  code: voucherCode.trim().toUpperCase(),
                  discount_type: voucherDiscountType,
                  discount_value: Number(voucherDiscountValue),
                  course_id: voucherCourseId || null,
                  expires_at: voucherExpiry || null,
                  max_uses: voucherMaxUses ? Number(voucherMaxUses) : null
                });
                setVoucherCode("");
                setVoucherDiscountValue(0);
                setVoucherCourseId("");
                setVoucherExpiry("");
                setVoucherMaxUses("");
                await fetchVouchers();
              } catch (err: any) {
                console.error(err);
                alert(err.message || "สร้างโค้ดส่วนลดไม่สำเร็จ");
              } finally {
                setActionLoading(false);
              }
            }} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
                <div className="form-group">
                  <label className="form-label">โค้ดส่วนลด (ตัวพิมพ์ใหญ่)</label>
                  <input
                    type="text"
                    placeholder="เช่น NETPRIME50"
                    value={voucherCode}
                    onChange={(e) => setVoucherCode(e.target.value)}
                    className="form-input"
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">ประเภทส่วนลด</label>
                  <select
                    value={voucherDiscountType}
                    onChange={(e: any) => setVoucherDiscountType(e.target.value)}
                    className="form-input"
                    style={{ borderRadius: "1rem", fontSize: "13px" }}
                  >
                    <option value="percent">ส่วนลดเป็นเปอร์เซ็นต์ (%)</option>
                    <option value="fixed">ส่วนลดเป็นจำนวนเงิน (฿)</option>
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">มูลค่าส่วนลด</label>
                  <input
                    type="number"
                    min="1"
                    placeholder="เช่น 50 (ลด 50% หรือ ฿50)"
                    value={voucherDiscountValue === 0 ? "" : voucherDiscountValue}
                    onChange={(e) => setVoucherDiscountValue(Number(e.target.value))}
                    className="form-input"
                    required
                  />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
                <div className="form-group">
                  <label className="form-label">{isAdmin ? "คอร์สที่ใช้ได้ (ไม่บังคับ)" : "คอร์สที่ใช้ได้"}</label>
                  <select
                    value={voucherCourseId}
                    onChange={(e) => setVoucherCourseId(e.target.value)}
                    className="form-input"
                    required={!isAdmin}
                    style={{ borderRadius: "1rem", fontSize: "13px" }}
                  >
                    <option value="">{isAdmin ? "ใช้ได้ทุกคอร์ส" : "เลือกคอร์สของคุณ"}</option>
                    {data?.courses.map((course) => (
                      <option key={course.id} value={course.id}>{course.title}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">วันหมดอายุ (ไม่บังคับ)</label>
                  <input
                    type="date"
                    value={voucherExpiry}
                    onChange={(e) => setVoucherExpiry(e.target.value)}
                    className="form-input"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">ใช้ได้สูงสุด (ครั้ง, ไม่บังคับ)</label>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={voucherMaxUses}
                    onChange={(e) => setVoucherMaxUses(e.target.value)}
                    placeholder="ไม่จำกัด"
                    className="form-input"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={actionLoading}
                className="tech-button-primary"
                style={{ alignSelf: "flex-end", padding: "10px 24px", borderRadius: "1rem", fontSize: "13px" }}
              >
                {actionLoading ? "กำลังสร้าง..." : "สร้างโค้ดส่วนลด"}
              </button>
            </form>
          </div>

          {/* Vouchers List */}
          <div className="glass-card" style={{ padding: "24px", background: "rgba(255, 255, 255, 0.45)", borderRadius: "1.25rem", border: "1px solid var(--border-subtle)" }}>
            <h4 style={{ fontSize: "16px", fontWeight: "700", marginBottom: "16px", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "6px" }}>
              <Tag size={18} color="var(--primary)" />
              รายการโค้ดส่วนลด
            </h4>
            
            {vouchers.length === 0 ? (
              <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
                ยังไม่มีโค้ดส่วนลดในระบบ
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid var(--border-subtle)" }}>
                      <th style={{ padding: "12px", color: "var(--text-secondary)" }}>โค้ด</th>
                      <th style={{ padding: "12px", color: "var(--text-secondary)" }}>ส่วนลด</th>
                      <th style={{ padding: "12px", color: "var(--text-secondary)" }}>ขอบเขตการใช้งาน</th>
                      <th style={{ padding: "12px", color: "var(--text-secondary)" }}>วันหมดอายุ</th>
                      <th style={{ padding: "12px", color: "var(--text-secondary)" }}>ใช้ไปแล้ว</th>
                      <th style={{ padding: "12px", textAlign: "right" }}>การดำเนินการ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vouchers.map((voucher) => (
                      <tr key={voucher.id} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                        <td style={{ padding: "12px", fontWeight: "700", color: "var(--color-brand-primary)" }}>{voucher.code}</td>
                        <td style={{ padding: "12px" }}>
                          {voucher.discount_type === "percent" ? `ลด ${voucher.discount_value}%` : `ลด ฿${Number(voucher.discount_value).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                        </td>
                        <td style={{ padding: "12px", color: "var(--text-secondary)" }}>
                          {voucher.course_title ? `เฉพาะ: ${voucher.course_title}` : "ใช้ได้ทุกคอร์ส"}
                        </td>
                        <td style={{ padding: "12px", color: "var(--text-secondary)" }}>
                          {voucher.expires_at ? new Date(voucher.expires_at).toLocaleDateString("th-TH") : "ไม่มีวันหมดอายุ"}
                        </td>
                        <td style={{ padding: "12px", color: voucher.max_uses && voucher.used_count >= voucher.max_uses ? "var(--danger, #dc2626)" : "var(--text-secondary)" }}>
                          {voucher.max_uses ? `${voucher.used_count ?? 0} / ${voucher.max_uses} ครั้ง` : `${voucher.used_count ?? 0} ครั้ง (ไม่จำกัด)`}
                          {voucher.max_uses && voucher.used_count >= voucher.max_uses ? " · ใช้ครบแล้ว" : ""}
                        </td>
                        <td style={{ padding: "12px", textAlign: "right" }}>
                          <button
                            type="button"
                            onClick={async () => {
                              if (!window.confirm(`คุณแน่ใจหรือไม่ว่าต้องการลบโค้ดส่วนลด ${voucher.code}?`)) return;
                              try {
                                setActionLoading(true);
                                await api.request(`/instructor/vouchers/${voucher.id}`, { method: "DELETE" });
                                await fetchVouchers();
                              } catch (err: any) {
                                console.error(err);
                                alert(err.message || "ลบโค้ดส่วนลดไม่สำเร็จ");
                              } finally {
                                setActionLoading(false);
                              }
                            }}
                            className="tech-button-outline"
                            style={{ padding: "4px 8px", fontSize: "11px", color: "var(--danger)", borderColor: "rgba(239, 68, 68, 0.2)", borderRadius: "0.5rem" }}
                            disabled={actionLoading}
                          >
                            <Trash2 size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const fetchGroupMembers = async (groupId: string) => {
    try {
      setActionLoading(true);
      const res = await api.get<any[]>(`/instructor/groups/${groupId}/members`);
      setGroupMembers(res);
      
      // Also fetch all students if not loaded to list members for additions
      const students = await api.get<any[]>("/instructor/students");
      setAllStudents(students);
      if (students.length > 0) {
        setGroupMemberSearchUserId(students[0].id);
      }
    } catch (err: any) {
      console.error(err);
      alert(err.message || "โหลดสมาชิกกลุ่มไม่สำเร็จ");
    } finally {
      setActionLoading(false);
    }
  };

  const renderGroups = () => {
    return (
      <div className="glass-card animate-fade-in" style={{ padding: "32px", border: "1px solid var(--border-subtle)", borderRadius: "1.5rem" }}>
        <button 
          onClick={() => {
            setSelectedGroup(null);
            setView("dashboard");
          }} 
          style={{ display: "flex", alignItems: "center", gap: "8px", background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: "14px", fontWeight: "600", marginBottom: "24px" }}
        >
          <ArrowLeft size={16} />
          กลับไปแดชบอร์ด
        </button>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px", flexWrap: "wrap", gap: "16px" }}>
          <div>
            <h3 style={{ fontSize: "24px", display: "flex", alignItems: "center", gap: "8px", color: "var(--text-primary)" }}>
              <Users size={24} color="var(--primary)" />
              กลุ่มเรียน
            </h3>
            <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginTop: "4px" }}>
              สร้างกลุ่มเรียนเพื่อกำหนดสิทธิ์เข้าถึงคอร์สให้ผู้เรียนพร้อมกันหลายคน
            </p>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: "32px", alignItems: "start" }}>
          
          {/* Left Column: Create & List Groups */}
          <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
            
            {/* Create Group Form */}
            <div className="glass-card" style={{ padding: "20px", background: "rgba(255,255,255,0.45)", borderRadius: "1.25rem", border: "1px solid var(--border-subtle)" }}>
              <h4 style={{ fontSize: "15px", fontWeight: "700", marginBottom: "12px", color: "var(--text-primary)" }}>สร้างกลุ่มใหม่</h4>
              <form onSubmit={async (e) => {
                e.preventDefault();
                if (!groupName.trim()) return;
                try {
                  setActionLoading(true);
                  await api.post("/instructor/groups", { name: groupName.trim() });
                  setGroupName("");
                  await fetchGroups();
                } catch (err: any) {
                  console.error(err);
                  alert(err.message || "สร้างกลุ่มเรียนไม่สำเร็จ");
                } finally {
                  setActionLoading(false);
                }
              }} style={{ display: "flex", gap: "8px" }}>
                <input
                  type="text"
                  placeholder="เช่น กลุ่ม Arista ขั้นสูง"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  className="form-input"
                  style={{ flexGrow: 1 }}
                  required
                />
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="tech-button-primary"
                  style={{ padding: "8px 16px", borderRadius: "1rem", fontSize: "12px" }}
                >
                  สร้าง
                </button>
              </form>
            </div>

            {/* Groups List */}
            <div className="glass-card" style={{ padding: "20px", background: "rgba(255,255,255,0.45)", borderRadius: "1.25rem", border: "1px solid var(--border-subtle)" }}>
              <h4 style={{ fontSize: "15px", fontWeight: "700", marginBottom: "16px", color: "var(--text-primary)" }}>กลุ่มเรียนทั้งหมด</h4>
              
              {groups.length === 0 ? (
                <div style={{ padding: "20px", textAlign: "center", color: "var(--text-muted)", fontSize: "12px" }}>
                  ยังไม่มีกลุ่มเรียน
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {groups.map((g) => {
                    const isSelected = selectedGroup?.id === g.id;
                    return (
                      <div
                        key={g.id}
                        onClick={() => {
                          setSelectedGroup(g);
                          fetchGroupMembers(g.id);
                        }}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "12px 16px",
                          borderRadius: "0.75rem",
                          border: isSelected ? "1px solid var(--primary)" : "1px solid var(--border-subtle)",
                          background: isSelected ? "rgba(229,107,37,0.08)" : "rgba(255,255,255,0.3)",
                          cursor: "pointer",
                          transition: "all 0.2s"
                        }}
                      >
                        <div>
                          <span style={{ fontSize: "14px", fontWeight: "600", color: "var(--text-primary)", display: "block" }}>{g.name}</span>
                          <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>{g.member_count} คน</span>
                        </div>
                        
                        <div style={{ display: "flex", gap: "8px", alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={async () => {
                              if (!window.confirm(`คุณแน่ใจหรือไม่ว่าต้องการลบกลุ่ม "${g.name}"? การลบจะลบเฉพาะกลุ่ม ผู้เรียนยังคงอยู่ในระบบ`)) return;
                              try {
                                setActionLoading(true);
                                await api.request(`/instructor/groups/${g.id}`, { method: "DELETE" });
                                if (selectedGroup?.id === g.id) {
                                  setSelectedGroup(null);
                                }
                                await fetchGroups();
                              } catch (err: any) {
                                console.error(err);
                                alert(err.message || "ลบกลุ่มไม่สำเร็จ");
                              } finally {
                                setActionLoading(false);
                              }
                            }}
                            className="tech-button-outline"
                            style={{ padding: "4px 8px", fontSize: "11px", color: "var(--danger)", borderColor: "rgba(239, 68, 68, 0.15)", borderRadius: "0.5rem" }}
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

          </div>

          {/* Right Column: Members Detail Panel */}
          <div className="glass-card" style={{ padding: "24px", background: "rgba(255,255,255,0.45)", borderRadius: "1.25rem", border: "1px solid var(--border-subtle)", minHeight: "350px" }}>
            {selectedGroup ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "12px" }}>
                  <div>
                    <h4 style={{ fontSize: "16px", fontWeight: "700", color: "var(--text-primary)" }}>{selectedGroup.name}</h4>
                    <p style={{ fontSize: "12px", color: "var(--text-secondary)" }}>จัดการสมาชิกของกลุ่มเรียนนี้</p>
                  </div>
                </div>

                {/* Add Member Form */}
                <form onSubmit={async (e) => {
                  e.preventDefault();
                  if (!groupMemberSearchUserId) return;
                  try {
                    setActionLoading(true);
                    await api.post(`/instructor/groups/${selectedGroup.id}/members`, { user_id: groupMemberSearchUserId });
                    await fetchGroupMembers(selectedGroup.id);
                    await fetchGroups(); // refresh counts
                  } catch (err: any) {
                    console.error(err);
                    alert(err.message || "เพิ่มสมาชิกเข้ากลุ่มไม่สำเร็จ");
                  } finally {
                    setActionLoading(false);
                  }
                }} style={{ display: "flex", gap: "10px", alignItems: "flex-end" }}>
                  <div className="form-group" style={{ flexGrow: 1 }}>
                    <label className="form-label">เพิ่มผู้เรียนเข้ากลุ่ม</label>
                    <select
                      value={groupMemberSearchUserId}
                      onChange={(e) => setGroupMemberSearchUserId(e.target.value)}
                      className="form-input"
                      style={{ borderRadius: "1rem", fontSize: "13px" }}
                    >
                      {allStudents.map((st) => (
                        <option key={st.id} value={st.id}>{st.name} ({st.email})</option>
                      ))}
                    </select>
                    <StudentEmailLookup onFound={st => { setAllStudents(prev => prev.some(p => p.id === st.id) ? prev : [...prev, st]); setGroupMemberSearchUserId(st.id); }} />
                  </div>
                  <button
                    type="submit"
                    disabled={actionLoading}
                    className="tech-button-primary"
                    style={{ padding: "10px 20px", borderRadius: "1rem", fontSize: "12px" }}
                  >
                    เพิ่มผู้เรียน
                  </button>
                </form>

                {/* Member Table */}
                <div>
                  <h5 style={{ fontSize: "13px", fontWeight: "700", color: "var(--text-primary)", marginBottom: "10px" }}>สมาชิกในกลุ่ม</h5>
                  {groupMembers.length === 0 ? (
                    <div style={{ padding: "24px", textAlign: "center", color: "var(--text-muted)", fontSize: "12px" }}>
                      กลุ่มนี้ยังไม่มีผู้เรียน
                    </div>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", textAlign: "left" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                          <th style={{ padding: "8px", color: "var(--text-secondary)" }}>ชื่อ</th>
                          <th style={{ padding: "8px", color: "var(--text-secondary)" }}>อีเมล</th>
                          <th style={{ padding: "8px", textAlign: "right" }}>การดำเนินการ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groupMembers.map((m) => (
                          <tr key={m.id} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                            <td style={{ padding: "8px", fontWeight: "600" }}>{m.name}</td>
                            <td style={{ padding: "8px", color: "var(--text-secondary)" }}>{m.email}</td>
                            <td style={{ padding: "8px", textAlign: "right" }}>
                              <button
                                type="button"
                                onClick={async () => {
                                  if (!window.confirm(`นำ ${m.name} ออกจากกลุ่มนี้หรือไม่?`)) return;
                                  try {
                                    setActionLoading(true);
                                    await api.request(`/instructor/groups/${selectedGroup.id}/members/${m.id}`, { method: "DELETE" });
                                    await fetchGroupMembers(selectedGroup.id);
                                    await fetchGroups(); // refresh counts
                                  } catch (err: any) {
                                    console.error(err);
                                    alert(err.message || "นำสมาชิกออกจากกลุ่มไม่สำเร็จ");
                                  } finally {
                                    setActionLoading(false);
                                  }
                                }}
                                className="tech-button-outline"
                                style={{ padding: "2px 6px", fontSize: "10px", color: "var(--danger)", borderColor: "rgba(239,68,68,0.15)", borderRadius: "0.25rem" }}
                                disabled={actionLoading}
                              >
                                นำออก
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)", fontSize: "13px", textAlign: "center", padding: "48px" }}>
                <Users size={32} style={{ marginBottom: "12px", opacity: 0.5 }} />
                เลือกกลุ่มเรียนจากด้านซ้ายเพื่อจัดการสมาชิก
              </div>
            )}
          </div>

        </div>

      </div>
    );
  };

  const renderTelemetry = () => {
    return (
      <div>
        <div className="header-row">
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <button onClick={() => setView("dashboard")} className="back-button" title="กลับไปแดชบอร์ด" style={{ background: "none", border: "none", color: "var(--text-primary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <ArrowLeft size={20} />
            </button>
            <div>
              <h1 className="header-title">ตรวจสอบความคืบหน้าและข้อมูลการใช้งานของผู้เรียน</h1>
              <p className="header-desc">วิเคราะห์ผู้เรียนที่ทำแบบทดสอบไม่ผ่านและติดค้างที่วิดีโอบทเรียน</p>
            </div>
          </div>
        </div>

        {telemetryLoading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "48px" }}>
            <div className="spinner" style={{ border: "3px solid var(--border-subtle)", borderTop: "3px solid var(--primary)", borderRadius: "50%", width: "32px", height: "32px", animation: "spin 1s linear infinite" }} />
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "32px", marginTop: "24px" }}>
            
            {/* Section 1: Quiz Struggles */}
            <div className="glass-card" style={{ padding: "24px" }}>
              <h3 style={{ fontSize: "18px", color: "var(--text-primary)", marginBottom: "16px", display: "flex", alignItems: "center", gap: "8px" }}>
                <ShieldAlert size={18} color="var(--danger)" />
                ผู้เรียนที่ทำแบบทดสอบไม่ผ่านและต้องการความช่วยเหลือ
              </h3>
              
              {quizFailures.length === 0 ? (
                <p style={{ color: "var(--text-muted)", fontSize: "14px" }}>ยังไม่มีการทำแบบทดสอบ</p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" }}>
                    <thead>
                      <tr style={{ borderBottom: "2px solid var(--border-subtle)" }}>
                        <th style={{ padding: "12px", color: "var(--text-secondary)" }}>ผู้เรียน</th>
                        <th style={{ padding: "12px", color: "var(--text-secondary)" }}>คอร์ส / บทเรียน</th>
                        <th style={{ padding: "12px", color: "var(--text-secondary)" }}>จำนวนครั้งที่ทำ</th>
                        <th style={{ padding: "12px", color: "var(--text-secondary)" }}>คะแนนต่ำสุด</th>
                        <th style={{ padding: "12px", color: "var(--text-secondary)" }}>คะแนนสูงสุด</th>
                        <th style={{ padding: "12px", color: "var(--text-secondary)" }}>จำนวนข้อ</th>
                        <th style={{ padding: "12px", color: "var(--text-secondary)" }}>สถานะ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quizFailures.map((q, idx) => {
                        const avgScore = (q.min_score + q.max_score) / 2;
                        const failRate = avgScore / q.total_questions;
                        const isStruggling = failRate < 0.6;
                        
                        return (
                          <tr key={idx} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                            <td style={{ padding: "12px" }}>
                              <div style={{ fontWeight: "600", color: "var(--text-primary)" }}>{q.student_name}</div>
                              <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{q.student_email}</div>
                            </td>
                            <td style={{ padding: "12px" }}>
                              <div style={{ fontWeight: "600", color: "var(--text-primary)" }}>{q.lesson_title}</div>
                              <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{q.course_title}</div>
                            </td>
                            <td style={{ padding: "12px", fontWeight: "600" }}>{q.attempt_count}</td>
                            <td style={{ padding: "12px", color: "var(--danger)", fontWeight: "600" }}>{q.min_score}</td>
                            <td style={{ padding: "12px", color: "var(--success)", fontWeight: "600" }}>{q.max_score}</td>
                            <td style={{ padding: "12px" }}>{q.total_questions}</td>
                            <td style={{ padding: "12px" }}>
                              <span className="badge-gamified" style={{ 
                                padding: "4px 8px", 
                                borderRadius: "99px", 
                                fontSize: "10px", 
                                fontWeight: "700",
                                background: isStruggling ? "rgba(239, 68, 68, 0.1)" : "rgba(16, 185, 129, 0.1)",
                                color: isStruggling ? "var(--danger)" : "var(--success)",
                                border: "none"
                              }}>
                                {isStruggling ? "ต้องช่วยเหลือเร่งด่วน" : "ผ่านเกณฑ์"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Section 2: Stuck Videos */}
            <div className="glass-card" style={{ padding: "24px" }}>
              <h3 style={{ fontSize: "18px", color: "var(--text-primary)", marginBottom: "16px", display: "flex", alignItems: "center", gap: "8px" }}>
                <Film size={18} color="var(--primary)" />
                ผู้เรียนที่ติดค้างที่วิดีโอบทเรียน (กำลังเรียน)
              </h3>
              
              {videoStuck.length === 0 ? (
                <p style={{ color: "var(--text-muted)", fontSize: "14px" }}>ขณะนี้ไม่มีผู้เรียนที่หยุดค้างที่วิดีโอบทเรียน</p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" }}>
                    <thead>
                      <tr style={{ borderBottom: "2px solid var(--border-subtle)" }}>
                        <th style={{ padding: "12px", color: "var(--text-secondary)" }}>ผู้เรียน</th>
                        <th style={{ padding: "12px", color: "var(--text-secondary)" }}>คอร์ส / บทเรียน</th>
                        <th style={{ padding: "12px", color: "var(--text-secondary)" }}>เวลาที่หยุด</th>
                        <th style={{ padding: "12px", color: "var(--text-secondary)" }}>ใช้งานล่าสุด</th>
                        <th style={{ padding: "12px", color: "var(--text-secondary)" }}>สถานะ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {videoStuck.map((v, idx) => {
                        const mins = Math.floor(v.resume_seconds / 60);
                        const secs = Math.floor(v.resume_seconds % 60);
                        const formattedTime = `${mins}:${secs < 10 ? "0" : ""}${secs}`;
                        
                        return (
                          <tr key={idx} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                            <td style={{ padding: "12px" }}>
                              <div style={{ fontWeight: "600", color: "var(--text-primary)" }}>{v.student_name}</div>
                              <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{v.student_email}</div>
                            </td>
                            <td style={{ padding: "12px" }}>
                              <div style={{ fontWeight: "600", color: "var(--text-primary)" }}>{v.lesson_title}</div>
                              <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{v.course_title}</div>
                            </td>
                            <td style={{ padding: "12px", fontFamily: "monospace", fontWeight: "600" }}>{formattedTime}</td>
                            <td style={{ padding: "12px" }}>{new Date(v.updated_at).toLocaleString("th-TH")}</td>
                            <td style={{ padding: "12px" }}>
                              <span className="badge-gamified" style={{ 
                                padding: "4px 8px", 
                                borderRadius: "99px", 
                                fontSize: "10px", 
                                fontWeight: "700",
                                background: "rgba(245, 158, 11, 0.1)",
                                color: "#d97706",
                                border: "none"
                              }}>
                                ควรติดตามผล
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

          </div>
        )}
      </div>
    );
  };

  const renderQa = () => {
    return (
      <div>
        <div className="header-row">
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <button onClick={() => setView("dashboard")} className="back-button" title="กลับไปแดชบอร์ด" style={{ background: "none", border: "none", color: "var(--text-primary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <ArrowLeft size={20} />
            </button>
            <div>
              <h1 className="header-title">ถามตอบในบทเรียน</h1>
              <p className="header-desc">ตอบคำถามของผู้เรียนจากทุกคอร์สของคุณ</p>
            </div>
          </div>
        </div>

        {instructorQaLoading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "48px" }}>
            <div className="spinner" style={{ border: "3px solid var(--border-subtle)", borderTop: "3px solid var(--primary)", borderRadius: "50%", width: "32px", height: "32px", animation: "spin 1s linear infinite" }} />
          </div>
        ) : instructorQuestions.length === 0 ? (
          <div className="glass-card" style={{ padding: "48px", textAlign: "center", marginTop: "24px" }}>
            <p style={{ color: "var(--text-muted)", fontSize: "16px" }}>ยังไม่มีคำถามจากผู้เรียน เมื่อมีการถามตอบ รายการจะแสดงที่นี่</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "20px", marginTop: "24px" }}>
            {instructorQuestions.map((q) => (
              <div key={q.id} className="glass-card" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "16px", background: "rgba(255, 255, 255, 0.45)", border: "1px solid var(--border-subtle)" }}>
                
                {/* Heading context */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "12px" }}>
                  <div>
                    <span className="badge-gamified" style={{ fontSize: "11px", background: "var(--primary-glow)", color: "var(--primary)", padding: "2px 8px", borderRadius: "99px", fontWeight: "700", border: "none", textTransform: "none" }}>
                      {q.course_title}
                    </span>
                    <span style={{ fontSize: "12px", color: "var(--text-muted)", marginLeft: "8px" }}>
                      บทเรียน: <strong>{q.lesson_title}</strong>
                    </span>
                  </div>
                  <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>{new Date(q.created_at).toLocaleString("th-TH")}</span>
                </div>

                {/* Question details */}
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
                    <div style={{ width: "28px", height: "28px", borderRadius: "50%", backgroundColor: "rgba(0,0,0,0.05)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: "600", color: "var(--text-secondary)" }}>
                      {q.user_name?.substring(0, 2).toUpperCase()}
                    </div>
                    <span style={{ fontSize: "13px", fontWeight: "600", color: "var(--text-primary)" }}>{q.user_name} (ผู้เรียน)</span>
                  </div>
                  <p style={{ fontSize: "14px", color: "var(--text-primary)", lineHeight: "1.6", whiteSpace: "pre-wrap", marginLeft: "38px" }}>
                    {q.content}
                  </p>
                </div>

                {/* Replies */}
                <div style={{ borderLeft: "2px solid var(--border-subtle)", paddingLeft: "16px", marginLeft: "38px", display: "flex", flexDirection: "column", gap: "10px" }}>
                  {qaRepliesLoadingMap[q.id] ? (
                     <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>กำลังโหลดคำตอบ...</span>
                  ) : !qaRepliesMap[q.id] || qaRepliesMap[q.id].length === 0 ? (
                     <span style={{ fontSize: "12px", color: "var(--text-muted)", fontStyle: "italic" }}>ยังไม่มีคำตอบ</span>
                  ) : (
                    qaRepliesMap[q.id].map((reply) => (
                      <div key={reply.id} style={{ background: "rgba(255,255,255,0.2)", padding: "10px 14px", borderRadius: "0.5rem", border: "1px solid rgba(0,0,0,0.03)" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--text-muted)", marginBottom: "4px" }}>
                          <span style={{ fontWeight: "600", color: reply.user_role === "instructor" || reply.user_role === "admin" ? "var(--primary)" : "var(--text-primary)" }}>
                            {reply.user_name} {reply.user_role === "instructor" || reply.user_role === "admin" ? "(ทีมงาน)" : "(ผู้เรียน)"}
                          </span>
                          <span>{new Date(reply.created_at).toLocaleString("th-TH")}</span>
                         </div>
                         <p style={{ fontSize: "13px", color: "var(--text-primary)", lineHeight: "1.5" }}>{reply.content}</p>
                       </div>
                    ))
                  )}

                  {/* Reply composer */}
                  <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
                    <input
                      type="text"
                      placeholder="เขียนคำตอบอย่างเป็นทางการ..."
                      value={qaReplyTexts[q.id] || ""}
                      onChange={(e) => setQaReplyTexts(prev => ({ ...prev, [q.id]: e.target.value }))}
                      style={{ flexGrow: 1, padding: "8px 12px", borderRadius: "0.5rem", border: "1px solid var(--border-subtle)", fontSize: "13px", backgroundColor: "rgba(255,255,255,0.7)", color: "var(--text-primary)" }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (qaReplyTexts[q.id] || "").trim()) {
                          handlePostInstructorReply(q.id, q.lesson_id);
                        }
                      }}
                    />
                    <button
                      onClick={() => handlePostInstructorReply(q.id, q.lesson_id)}
                      disabled={!(qaReplyTexts[q.id] || "").trim()}
                      className="tech-button-primary"
                      style={{ padding: "8px 16px", borderRadius: "0.5rem", fontSize: "12px" }}
                    >
                      ตอบกลับ
                    </button>
                  </div>
                </div>

              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="instructor-console-container">
      {dangerDialog}
      <AnimatePresence mode="wait">
        {view === "dashboard" && openCourseData && (
          <motion.div
            key={`course-${openCourseData.id}`}
            initial={{ opacity: 0, x: 15 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -15 }}
            transition={{ duration: 0.2 }}
          >
            {renderWorkspace(openCourseData)}
          </motion.div>
        )}
        {view === "dashboard" && !courseParam && (
          <motion.div 
            key="dashboard" 
            initial={{ opacity: 0, x: -15 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 15 }}
            transition={{ duration: 0.2 }}
          >
            {renderDashboard()}
          </motion.div>
        )}
        {view === "create-course" && (
          <motion.div 
            key="create-course"
            initial={{ opacity: 0, x: 15 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -15 }}
            transition={{ duration: 0.2 }}
          >
            {renderCreateCourse()}
          </motion.div>
        )}
        {view === "vouchers" && (
          <motion.div 
            key="vouchers"
            initial={{ opacity: 0, x: 15 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -15 }}
            transition={{ duration: 0.2 }}
          >
            {renderVouchers()}
          </motion.div>
        )}
        {view === "groups" && (
          <motion.div 
            key="groups"
            initial={{ opacity: 0, x: 15 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -15 }}
            transition={{ duration: 0.2 }}
          >
            {renderGroups()}
          </motion.div>
        )}
        {view === "telemetry" && (
          <motion.div 
            key="telemetry"
            initial={{ opacity: 0, x: 15 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -15 }}
            transition={{ duration: 0.2 }}
          >
            {renderTelemetry()}
          </motion.div>
        )}
        {view === "qa" && (
          <motion.div 
            key="qa"
            initial={{ opacity: 0, x: 15 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -15 }}
            transition={{ duration: 0.2 }}
          >
            {renderQa()}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default InstructorConsole;
