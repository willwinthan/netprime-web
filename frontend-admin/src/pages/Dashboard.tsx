import React, { useState, useEffect } from "react";
import { useApi, User, API_BASE_URL, hasRole } from "../hooks/useApi";
import { VideoPlayer } from "../components/VideoPlayer";
import { motion, AnimatePresence } from "framer-motion";
import Confetti from "react-confetti";
import { CourseOrderModal } from "../components/learner/CourseOrder";
import { MyPayments } from "../components/learner/MyPayments";
import { CommunityPage } from "./CommunityPage";
import { Inbox, useInboxUnread } from "../components/communication/Inbox";
import { CourseAnnouncements, MyAnnouncements } from "../components/communication/CourseAnnouncements";
import { CertificatePrint } from "../components/learner/PrintView";
import { runInSandbox } from "../components/learner/codeSandbox";
import { LessonContentView } from "../components/course/LessonContentView";
import { CurriculumOutline } from "../components/course/CurriculumOutline";
import { MyLiveClasses } from "../components/settings/MyLiveClasses";
import { CourseReviewForm } from "../components/marketing/CourseReviewForm";
import { CategoryFilter } from "../components/course/CategoryFilter";
import type { CourseSection, LessonType } from "../components/course/types";
import { InteractiveVideo } from "../components/assessment/InteractiveVideo";
import { LearnerAssessments } from "../components/assessment/LearnerAssessments";
import { LessonAiSummary } from "../components/ai/LessonAiSummary";
import { 
  BookOpen, 
  PlayCircle, 
  CheckCircle, 
  Download, 
  Clock, 
  Award, 
  Lock, 
  Sparkles,
  ChevronRight,
  TrendingUp,
  FileText,
  AlertCircle,
  X,
  Check,
  Calendar,
  Building2,
  Users,
  DollarSign,
  Target,
  ExternalLink,
  Zap,
  Briefcase,
  Plus,
  Trash2,
  ClipboardList,
  Send,
  Bell,
  Flame,
  Terminal,
  Linkedin,
  Printer,
  Receipt
} from "lucide-react";

interface Course {
  id: string;
  title: string;
  description: string;
  thumbnail_url: string;
  cover_image_url?: string | null;
  access_duration_days?: number | null;
  price?: number;
  progress_percent: number | null;
  completed_at: string | null;
  expires_at?: string | null;
  category_id?: string | null;
}

interface Lesson {
  id: string;
  title: string;
  video_stream_uid: string;
  video_provider?: string;
  sort_order: number;
  handout_r2_key?: string | null; // course staff only
  has_handout?: boolean;
  handout_name?: string | null;
  /** Course structure (components/course): type, chapter, completion and drip/sequential lock. */
  type?: LessonType;
  section_id?: string | null;
  completed?: number;
  locked?: boolean;
  lock_reason?: "date" | "drip" | "sequence" | null;
  unlock_at?: string | null;
}

interface VideoResponse {
  lessonId: string;
  title: string;
  videoStreamUid: string;
  videoProvider?: string;
  signedUrl: string;
  token: string;
  isMock: boolean;
}

export const Dashboard: React.FC = () => {
  const api = useApi();
  const [courses, setCourses] = useState<Course[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  
  // Selected course details
  const [courseDetail, setCourseDetail] = useState<Course | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [sections, setSections] = useState<CourseSection[]>([]);
  const [catalogCategory, setCatalogCategory] = useState("");
  const [enrollment, setEnrollment] = useState<{ progress_percent: number; completed_at: string | null; expires_at: string | null; status?: string } | null>(null);

  // Student view configuration (my courses vs explorer catalog)
  const [studentSubView, setStudentSubView] = useState<"my-courses" | "catalog" | "internships" | "freelance" | "payments" | "community" | "inbox">(() => {
    // Notification links: /dashboard?community=<post id> and /dashboard?inbox=<thread id>
    const q = new URLSearchParams(window.location.search);
    return q.get("community") ? "community" : q.get("inbox") ? "inbox" : "my-courses";
  });
  const inboxUnread = useInboxUnread();
  const [corporateInfo, setCorporateInfo] = useState<any | null>(null);
  const [studentStats, setStudentStats] = useState<any | null>(null);
  const [dashboardStatsLoading, setDashboardStatsLoading] = useState(false);
  
  // Active streaming lesson
  const [activeLessonId, setActiveLessonId] = useState<string | null>(null);
  const [videoData, setVideoData] = useState<VideoResponse | null>(null);
  
  // Tab selector state
  const [activeDetailTab, setActiveDetailTab] = useState<"video" | "resources" | "quizzes" | "notes" | "qa" | "ai" | "sandbox" | "assessments">("video");

  // Q&A state
  const [qaThreads, setQaThreads] = useState<any[]>([]);
  const [qaLoading, setQaLoading] = useState(false);
  const [newQuestionContent, setNewQuestionContent] = useState("");
  const [replyContents, setReplyContents] = useState<Record<string, string>>({});

  // Playback resume & current state
  const [playbackResumeSeconds, setPlaybackResumeSeconds] = useState<number>(0);
  const [currentVideoSeconds, setCurrentVideoSeconds] = useState<number>(0);

  // Lecture notes state
  const [notes, setNotes] = useState<any[]>([]);
  const [noteContent, setNoteContent] = useState("");
  const [notesLoading, setNotesLoading] = useState(false);

  // Certificate claims state
  const [certificate, setCertificate] = useState<any | null>(null);
  const [isClaimingCertificate, setIsClaimingCertificate] = useState(false);
  const [showCertificateModal, setShowCertificateModal] = useState(false);
  const certDialogRef = React.useRef<HTMLDialogElement>(null);

  // Quiz attempts state
  const [quizAttempts, setQuizAttempts] = useState<any[]>([]);
  
  // Quizzes state
  const [quizzes, setQuizzes] = useState<any[]>([]);
  const [quizzesLoading, setQuizzesLoading] = useState(false);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, number>>({});
  const [quizResults, setQuizResults] = useState<Record<string, { correct: boolean }>>({});
  const [submittingQuizId, setSubmittingQuizId] = useState<string | null>(null);

  // Course purchase (bank-transfer order) dialog; org-sponsored courses enroll directly
  const [checkoutCourse, setCheckoutCourse] = useState<Course | null>(null);
  const [courseSponsored, setCourseSponsored] = useState(false);
  const [printingCertificate, setPrintingCertificate] = useState(false);

  // Internship Portal states
  const [internshipOpenings, setInternshipOpenings] = useState<any[]>([]);
  const [myApplications, setMyApplications] = useState<any[]>([]);
  const [selectedApplicationId, setSelectedApplicationId] = useState<string | null>(null);
  const [applicationLogs, setApplicationLogs] = useState<any[]>([]);
  const [loadingInternships, setLoadingInternships] = useState(false);
  const [submittingLog, setSubmittingLog] = useState(false);
  const [applyingForOpeningId, setApplyingForOpeningId] = useState<string | null>(null);

  // Timesheet form states
  const [logDate, setLogDate] = useState(new Date().toISOString().split("T")[0]);
  const [logHours, setLogHours] = useState<string>("8.0");
  const [logDescription, setLogDescription] = useState("");
  const [internshipError, setInternshipError] = useState<string | null>(null);
  const [internshipSuccess, setInternshipSuccess] = useState<string | null>(null);

  // Gamification states
  const [gamificationProfile, setGamificationProfile] = useState<any | null>(null);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [showLevelUpAlert, setShowLevelUpAlert] = useState(false);
  const [levelUpData, setLevelUpData] = useState<any | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);
  const [achievementUnlockedAlert, setAchievementUnlockedAlert] = useState<string | null>(null);

  // Notification Hub states
  const [notifications, setNotifications] = useState<any[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showNotificationsDropdown, setShowNotificationsDropdown] = useState(false);

  // AI Tutor states
  const [aiChatHistory, setAiChatHistory] = useState<any[]>([]);
  const [aiMessage, setAiMessage] = useState("");
  const [aiLoading, setAiLoading] = useState(false);

  // Code Sandbox states
  const [sandboxCode, setSandboxCode] = useState(`// Netprime Interactive Code Sandbox\n// Write JavaScript code here and hit Run!\n\nconsole.log("Welcome to Netprime Playground!");\n\nfunction calculateExp(level) {\n  // TODO: Implement challenge code\n  // Level 2 -> returns 500, Level 3 -> returns 1000\n  return 0;\n}`);
  const [sandboxConsole, setSandboxConsole] = useState<string[]>([]);
  const [sandboxChallengeCompleted, setSandboxChallengeCompleted] = useState(false);

  // Freelance Outsource states
  const [outsourceProjects, setOutsourceProjects] = useState<any[]>([]);
  const [applyingProjectId, setApplyingProjectId] = useState<string | null>(null);
  const [proposalText, setProposalText] = useState("");
  const [bidAmountText, setBidAmountText] = useState("5000");
  const [milestoneDeliverablesText, setMilestoneDeliverablesText] = useState("");
  const [submittingMilestoneId, setSubmittingMilestoneId] = useState<string | null>(null);
  const [activeOutsourceTab, setActiveOutsourceTab] = useState<"projects" | "my-bids" | "my-projects">("projects");

  const fetchOutsourceProjects = async () => {
    try {
      const projects = await api.get<any[]>("/outsource/projects");
      
      const projectsWithMilestones = await Promise.all(projects.map(async (proj) => {
        if (proj.myBidStatus === 'accepted') {
          try {
            const milestones = await api.get<any[]>(`/outsource/applications/${proj.myBidId}/milestones`);
            return { ...proj, milestones };
          } catch (e) {
            console.error("Failed to fetch milestones for project", proj.id, e);
            return { ...proj, milestones: [] };
          }
        }
        return proj;
      }));

      setOutsourceProjects(projectsWithMilestones);
    } catch (err) {
      console.error("Failed to fetch outsource projects:", err);
    }
  };

  const handleApplyProject = async (projectId: string) => {
    try {
      await api.post(`/outsource/projects/${projectId}/apply`, {
        proposal: proposalText,
        bidAmount: bidAmountText
      });
      alert("ส่งข้อเสนอราคาเรียบร้อยแล้ว");
      setApplyingProjectId(null);
      setProposalText("");
      fetchOutsourceProjects();
      fetchNotifications();
    } catch (err: any) {
      alert("ส่งข้อเสนอราคาไม่สำเร็จ: " + err.message);
    }
  };

  const handleMilestoneSubmit = async (milestoneId: string) => {
    try {
      await api.post(`/outsource/milestones/${milestoneId}/submit`, {
        deliverables: milestoneDeliverablesText
      });
      alert("ส่งงานงวดนี้เรียบร้อยแล้ว");
      setSubmittingMilestoneId(null);
      setMilestoneDeliverablesText("");
      fetchOutsourceProjects();
    } catch (err: any) {
      alert("ส่งงานงวดไม่สำเร็จ: " + err.message);
    }
  };

  const fetchGamificationData = async () => {
    try {
      const profileData = await api.get<any>("/gamification/profile");
      setGamificationProfile(profileData);
      const leaderboardData = await api.get<any[]>("/gamification/leaderboard");
      setLeaderboard(leaderboardData);
    } catch (err) {
      console.error("Failed to load gamification data:", err);
    }
  };

  const fetchNotifications = async () => {
    try {
      const data = await api.get<any[]>("/notifications");
      setNotifications(data);
      setUnreadCount(data.filter((n: any) => n.is_read === 0).length);
    } catch (err) {
      console.error("Failed to fetch notifications:", err);
    }
  };

  const markNotificationsRead = async () => {
    try {
      await api.post("/notifications/read-all", {});
      setUnreadCount(0);
      setNotifications(prev => prev.map(n => ({ ...n, is_read: 1 })));
    } catch (err) {
      console.error("Failed to mark notifications read:", err);
    }
  };

  const handleSendAiMessage = async () => {
    if (!aiMessage.trim()) return;
    const userMsg = { sender: "user", text: aiMessage };
    setAiChatHistory(prev => [...prev, userMsg]);
    setAiMessage("");
    setAiLoading(true);

    try {
      const res = await api.post<{ reply: string }>("/ai/chat", {
        message: aiMessage,
        history: aiChatHistory,
        courseTitle: courseDetail?.title || "ความรู้ทั่วไป",
        lessonTitle: (courseDetail as any)?.lessons?.find((l: any) => l.id === activeLessonId)?.title || "Intro"
      });
      const aiReply = { sender: "ai", text: res.reply };
      setAiChatHistory(prev => [...prev, aiReply]);
    } catch (err: any) {
      console.error("AI chat call failed:", err);
      setAiChatHistory(prev => [...prev, { sender: "ai", text: "เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาตรวจสอบการตั้งค่า edge worker" }]);
    } finally {
      setAiLoading(false);
    }
  };

  // Learner code runs in a sandboxed iframe (opaque origin, no network), never with new Function() on the app origin.
  const handleRunCode = async () => {
    setSandboxConsole(["[ระบบ] กำลังเริ่มต้นเอนจินจำลองแบบแยกส่วน..."]);
    const result = await runInSandbox(sandboxCode);
    if (result.error) {
      setSandboxConsole(prev => [
        ...prev,
        ...result.logs.map(l => `[คอนโซล] ${l}`),
        `[ข้อผิดพลาด] เกิดข้อผิดพลาดขณะรันโค้ด: ${result.error}`
      ]);
      return;
    }
    setSandboxConsole(prev => [
      ...prev,
      ...result.logs.map(l => `[คอนโซล] ${l}`),
      `[ระบบ] รันโค้ดสำเร็จใน ${result.durationMs.toFixed(2)} มิลลิวินาที`,
      result.challengePassed ? "[ผ่านความท้าทาย] 🎉 เขียนฟังก์ชันถูกต้อง! คุณแก้โจทย์โค้ดในพื้นที่ทดลองสำเร็จ ได้รับ +100 EXP" : "[สถานะความท้าทาย] ยังไม่สมบูรณ์ ให้เขียน 'calculateExp(level)' ให้คืนค่า (level - 1) * 500"
    ]);
    if (result.challengePassed && !sandboxChallengeCompleted) {
      setSandboxChallengeCompleted(true);
      fetchGamificationData();
      setAchievementUnlockedAlert("ปรมาจารย์ความท้าทายพื้นที่ทดลองโค้ด");
      setTimeout(() => setAchievementUnlockedAlert(null), 4500);
    }
  };

  const checkGamificationResponse = (res: any) => {
    if (res.gamification) {
      fetchGamificationData();
      if (res.gamification.leveledUp) {
        setLevelUpData(res.gamification);
        setShowLevelUpAlert(true);
        setShowConfetti(true);
        setTimeout(() => setShowLevelUpAlert(false), 5000);
      }
    }
    if (res.achievementUnlocked) {
      setAchievementUnlockedAlert(res.achievementUnlocked);
      setTimeout(() => setAchievementUnlockedAlert(null), 4500);
    }
  };

  const fetchApplicationLogs = async (appId: string) => {
    try {
      const logs = await api.get<any[]>(`/internships/applications/${appId}/logs`);
      setApplicationLogs(logs);
    } catch (err: any) {
      console.error("Failed to load logs:", err);
      setInternshipError("โหลดบันทึกชั่วโมงทำงานไม่สำเร็จ: " + err.message);
    }
  };

  const fetchInternshipData = async () => {
    try {
      setLoadingInternships(true);
      setInternshipError(null);
      
      const [openings, apps] = await Promise.all([
        api.get<any[]>("/internships/openings"),
        api.get<any[]>("/internships/applications/me")
      ]);
      
      setInternshipOpenings(openings);
      setMyApplications(apps);
      
      // If there's an active application selected, refresh its logs
      if (selectedApplicationId) {
        await fetchApplicationLogs(selectedApplicationId);
      } else if (apps.length > 0) {
        const activeApp = apps.find(a => a.status === 'accepted' || a.status === 'completed');
        if (activeApp) {
          setSelectedApplicationId(activeApp.id);
          await fetchApplicationLogs(activeApp.id);
        } else {
          setSelectedApplicationId(apps[0].id);
          await fetchApplicationLogs(apps[0].id);
        }
      }
    } catch (err: any) {
      console.error("Failed to load internship data:", err);
      setInternshipError("โหลดข้อมูลฝึกงานไม่สำเร็จ: " + err.message);
    } finally {
      setLoadingInternships(false);
    }
  };

  const handleApplyInternship = async (openingId: string) => {
    try {
      setApplyingForOpeningId(openingId);
      setInternshipError(null);
      setInternshipSuccess(null);
      
      await api.post<any>("/internships/applications", { openingId });
      setInternshipSuccess("ส่งใบสมัครเรียบร้อยแล้ว");
      await fetchInternshipData();
    } catch (err: any) {
      console.error("Apply failed:", err);
      setInternshipError(err.error || err.message || "สมัครฝึกงานไม่สำเร็จ");
    } finally {
      setApplyingForOpeningId(null);
    }
  };

  const handleSubmitDailyLog = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedApplicationId) return;
    
    try {
      setSubmittingLog(true);
      setInternshipError(null);
      setInternshipSuccess(null);
      
      const res = await api.post<any>(`/internships/applications/${selectedApplicationId}/logs`, {
        logDate,
        hoursWorked: parseFloat(logHours),
        activityDescription: logDescription
      });
      
      setInternshipSuccess("ส่งบันทึกประจำวันเรียบร้อยแล้ว");
      setLogDescription("");
      setLogHours("8.0");
      await fetchApplicationLogs(selectedApplicationId);
      checkGamificationResponse(res);
    } catch (err: any) {
      console.error("Submit log failed:", err);
      setInternshipError(err.error || err.message || "ส่งบันทึกชั่วโมงทำงานไม่สำเร็จ");
    } finally {
      setSubmittingLog(false);
    }
  };

  // Loading & Error States
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Fetch Course catalog
  const fetchCourses = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.get<Course[]>("/courses");
      setCourses(data);
      
      // If we already have a course selected, refresh its details
      if (selectedCourseId) {
        await selectCourse(selectedCourseId);
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "โหลดรายการคอร์สไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  };

  const fetchDashboardStats = async () => {
    if (!api.token) return;
    try {
      setDashboardStatsLoading(true);
      
      // 1. Fetch student metrics
      const stats = await api.get<any>("/student/stats");
      setStudentStats(stats);

      // 2. Fetch Corporate details if they belong to a corporate partner
      const partnerId = api.user?.corporate_id || (api.user as any)?.partner_id;
      if (partnerId) {
        const corp = await api.get<any>("/student/corporate");
        setCorporateInfo(corp);
      } else {
        setCorporateInfo(null);
      }
    } catch (err) {
      console.error("Failed to load dashboard stats & corporate info:", err);
    } finally {
      setDashboardStatsLoading(false);
    }
  };

  useEffect(() => {
    fetchCourses();
    fetchDashboardStats();
    fetchGamificationData();
    fetchNotifications();
  }, [api.token, api.user?.id]); // Refresh on auth changes

  useEffect(() => {
    if (studentSubView === "internships") {
      fetchInternshipData();
      fetchGamificationData();
    } else if (studentSubView === "freelance") {
      fetchOutsourceProjects();
      fetchGamificationData();
    }
  }, [studentSubView]);

  // Control native dialog state
  useEffect(() => {
    if (showCertificateModal) {
      certDialogRef.current?.showModal();
    } else {
      certDialogRef.current?.close();
    }
  }, [showCertificateModal]);

  // Click outside to dismiss certificate modal (Safari fallback)
  useEffect(() => {
    const dialog = certDialogRef.current;
    if (!dialog) return;

    if (!("closedBy" in HTMLDialogElement.prototype)) {
      const handleOutsideClick = (event: MouseEvent) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isDialogContent = (
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width
        );
        if (!isDialogContent) {
          setShowCertificateModal(false);
        }
      };
      dialog.addEventListener("click", handleOutsideClick);
      return () => {
        dialog.removeEventListener("click", handleOutsideClick);
      };
    }
    return; // Explicit return to satisfy TS7030
  }, [showCertificateModal]);

  // Select and load course details
  const selectCourse = async (courseId: string) => {
    try {
      setError(null);
      setSelectedCourseId(courseId);
      const data = await api.get<{
        course: Course;
        lessons: Lesson[];
        sections?: CourseSection[];
        enrollment: { progress_percent: number; completed_at: string | null; expires_at: string | null; status?: string } | null;
        sponsored?: boolean;
      }>(`/courses/${courseId}`);
      setSections(data.sections || []);

      setCourseDetail(data.course);
      // The API reports sponsored=true for everyone; only organization learners get sponsored seats.
      setCourseSponsored(!!data.sponsored && !!(api.user?.corporate_id || (api.user as any)?.partner_id));
      setLessons(data.lessons);
      setEnrollment(data.enrollment);
      
      // Auto-select the first lesson if enrolled and no active lesson is selected
      if (data.enrollment && data.lessons.length > 0 && !activeLessonId) {
        const firstLesson = data.lessons[0];
        await loadVideo(firstLesson.id, firstLesson);
      } else if (!data.enrollment) {
        // Clear active video states if user is not enrolled
        setActiveLessonId(null);
        setVideoData(null);
      }

      // Load student progress features if enrolled
      if (data.enrollment) {
        fetchNotes(courseId);
        fetchQuizAttempts(courseId);
        
        // Fetch certificate if exists
        try {
          const certData = await api.get<any>(`/student/courses/${courseId}/certificate`);
          setCertificate(certData.certificate || certData);
        } catch (e) {
          setCertificate(null);
        }
      } else {
        setCertificate(null);
        setNotes([]);
        setQuizAttempts([]);
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "โหลดรายละเอียดคอร์สไม่สำเร็จ");
    }
  };

  // Paid courses open the bank-transfer order dialog; free or organization-sponsored courses enroll directly
  const startEnrollmentFlow = (course: Course) => {
    if (course.price && course.price > 0 && !(selectedCourseId === course.id && courseSponsored)) {
      setCheckoutCourse(course);
    } else {
      handleEnrollDirect(course.id);
    }
  };

  // Direct enrollment for free courses
  const handleEnrollDirect = async (courseId: string) => {
    try {
      setActionLoading(true);
      setError(null);
      await api.post(`/courses/${courseId}/enroll`, {});
      await selectCourse(courseId);
      
      const listData = await api.get<Course[]>("/courses");
      setCourses(listData);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "ลงทะเบียนเรียนไม่สำเร็จ");
    } finally {
      setActionLoading(false);
    }
  };

  // Handout Download Proxy handler
  const handleDownloadHandout = async (lessonId: string, filename: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/student/lessons/${lessonId}/handout`, {
        headers: {
          Authorization: `Bearer ${api.token}`
        }
      });
      if (!response.ok) {
        throw new Error("Download failed");
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error("Failed to download handout:", err);
      alert("ดาวน์โหลดเอกสารประกอบการเรียนไม่สำเร็จ กรุณาตรวจสอบสิทธิ์การเข้าถึงของคุณ");
    }
  };

  // Fetch student lecture notes
  const fetchNotes = async (courseId: string) => {
    try {
      setNotesLoading(true);
      const data = await api.get<any[]>(`/student/notes?course_id=${courseId}`);
      setNotes(data);
    } catch (err) {
      console.error("Failed to fetch notes:", err);
    } finally {
      setNotesLoading(false);
    }
  };

  // Save new lecture note
  const handleSaveNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCourseId || !activeLessonId || !noteContent.trim()) return;
    try {
      await api.post("/student/notes", {
        course_id: selectedCourseId,
        lesson_id: activeLessonId,
        timestamp_seconds: currentVideoSeconds,
        content: noteContent.trim()
      });
      setNoteContent("");
      await fetchNotes(selectedCourseId);
    } catch (err: any) {
      console.error("Failed to save note:", err);
      alert(err.message || "บันทึกบันทึกย่อไม่สำเร็จ");
    }
  };

  // Delete lecture note
  const handleDeleteNote = async (noteId: string) => {
    try {
      await api.request(`/student/notes/${noteId}`, { method: "DELETE" });
      if (selectedCourseId) {
        await fetchNotes(selectedCourseId);
      }
    } catch (err: any) {
      console.error("Failed to delete note:", err);
    }
  };

  // Jump player to note timestamp
  const handleNoteSeek = (seconds: number) => {
    setPlaybackResumeSeconds(seconds);
  };

  // Fetch quiz attempts history
  const fetchQuizAttempts = async (courseId: string) => {
    try {
      const data = await api.get<any[]>(`/student/courses/${courseId}/quiz-attempts`);
      setQuizAttempts(data);
    } catch (err) {
      console.error("Failed to fetch quiz attempts:", err);
    }
  };

  // Progress, completions and certificates change inside a course; refresh the summary on the way back.
  useEffect(() => {
    if (!selectedCourseId && api.token) fetchDashboardStats();
  }, [selectedCourseId]);

  // Claim Certificate when course is 100%
  const handleClaimCertificate = async () => {
    if (!selectedCourseId) return;
    try {
      setIsClaimingCertificate(true);
      const res = await api.post<{ certificate: any }>(`/student/courses/${selectedCourseId}/certificate`, {});
      setCertificate(res.certificate);
      setShowCertificateModal(true);
      fetchDashboardStats();
    } catch (err: any) {
      alert(err.message || "รับใบประกาศนียบัตรไม่สำเร็จ");
    } finally {
      setIsClaimingCertificate(false);
    }
  };

  // Throttled playback progress save handler (calls API every 5 seconds)
  const handleTimeProgressUpdate = async (seconds: number) => {
    setCurrentVideoSeconds(seconds);
    const sec = Math.floor(seconds);
    if (sec > 0 && sec % 5 === 0 && activeLessonId) {
      try {
        await api.post(`/student/lessons/${activeLessonId}/progress`, {
          resume_seconds: seconds,
          completed: 0
        });
      } catch (err) {
        console.error("Failed to sync playback progress:", err);
      }
    }
  };

  // Fetch Q&A threads
  const fetchQaThreads = async (lessonId: string) => {
    try {
      setQaLoading(true);
      const res = await api.get<any[]>(`/lessons/${lessonId}/qa`);
      setQaThreads(res || []);
    } catch (err: any) {
      console.error("Failed to fetch Q&A threads:", err);
    } finally {
      setQaLoading(false);
    }
  };

  const handlePostQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newQuestionContent.trim() || !activeLessonId) return;
    try {
      const res = await api.post<any>(`/lessons/${activeLessonId}/qa`, {
        content: newQuestionContent.trim()
      });
      setQaThreads(prev => [...prev, { ...res, replies: [] }]);
      setNewQuestionContent("");
    } catch (err: any) {
      alert("ตั้งคำถามไม่สำเร็จ: " + err.message);
    }
  };

  const handlePostReply = async (questionId: string) => {
    const replyText = replyContents[questionId];
    if (!replyText || !replyText.trim() || !activeLessonId) return;
    try {
      const res = await api.post<any>(`/lessons/${activeLessonId}/qa`, {
        content: replyText.trim(),
        parent_id: questionId
      });
      setQaThreads(prev => prev.map(t => {
        if (t.id === questionId) {
          return { ...t, replies: [...t.replies, res] };
        }
        return t;
      }));
      setReplyContents(prev => ({ ...prev, [questionId]: "" }));
    } catch (err: any) {
      alert("ตอบกลับไม่สำเร็จ: " + err.message);
    }
  };

  const handleDeleteQaPost = async (qaId: string, parentId?: string | null) => {
    if (!window.confirm("ต้องการลบโพสต์นี้ใช่หรือไม่?")) return;
    try {
      await api.request(`/lessons/${activeLessonId}/qa/${qaId}`, { method: "DELETE" });
      if (parentId) {
        setQaThreads(prev => prev.map(t => {
          if (t.id === parentId) {
            return { ...t, replies: t.replies.filter((r: any) => r.id !== qaId) };
          }
          return t;
        }));
      } else {
        setQaThreads(prev => prev.filter(t => t.id !== qaId));
      }
    } catch (err: any) {
      alert("ลบโพสต์ไม่สำเร็จ: " + err.message);
    }
  };

  useEffect(() => {
    if (activeLessonId && activeDetailTab === "qa") {
      fetchQaThreads(activeLessonId);
    }
  }, [activeLessonId, activeDetailTab]);

  // Retrieve Secure Stream URL and Resume playback duration
  const loadVideo = async (lessonId: string, meta?: Pick<Lesson, "type" | "locked">) => {
    try {
      setVideoLoading(true);
      setActiveLessonId(lessonId);
      setVideoData(null);
      // Text / PDF / embed / SCORM and locked lessons render in LessonContentView instead
      if (meta?.locked || (meta?.type && meta.type !== "video")) return;

      // Fetch progress
      let resumeTime = 0;
      try {
        const prog = await api.get<{ resume_seconds: number; completed: number }>(`/student/lessons/${lessonId}/progress`);
        resumeTime = prog.resume_seconds || 0;
      } catch (err) {
        console.error("Failed to fetch lesson progress:", err);
      }
      setPlaybackResumeSeconds(resumeTime);
      setCurrentVideoSeconds(resumeTime);

      const data = await api.get<VideoResponse>(`/lessons/${lessonId}/stream-token`);
      setVideoData(data);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "ขอสิทธิ์เล่นวิดีโอแบบปลอดภัยไม่สำเร็จ");
    } finally {
      setVideoLoading(false);
    }
  };

  // Fetch Quizzes from Hono
  const fetchQuizzes = async (courseId: string) => {
    try {
      setQuizzesLoading(true);
      setError(null);
      const data = await api.get<any[]>(`/student/courses/${courseId}/quizzes`);
      setQuizzes(data);
      setSelectedAnswers({});
      setQuizResults({});
    } catch (err: any) {
      console.error("Failed to load quizzes:", err);
      setQuizzes([]);
    } finally {
      setQuizzesLoading(false);
    }
  };

  // Submit Quiz Choice
  const handleQuizSubmit = async (quizId: string, answerIndex: number) => {
    try {
      setSubmittingQuizId(quizId);
      const res = await api.post<{ quizId: string; correct: boolean }>(
        `/student/quizzes/${quizId}/submit`,
        { answer_index: answerIndex }
      );
      setQuizResults(prev => ({
        ...prev,
        [quizId]: { correct: res.correct }
      }));
    } catch (err: any) {
      console.error(err);
      setError(err.message || "ส่งคำตอบแบบทดสอบไม่สำเร็จ");
    } finally {
      setSubmittingQuizId(null);
    }
  };

  // Telemetry: Update progress on backend as they watch
  const handleProgressUpdate = async (percent: number) => {
    if (!selectedCourseId || !enrollment) return;
    
    // Only update if current percent is greater than recorded progress
    if (percent <= enrollment.progress_percent) return;

    try {
      const data = await api.patch<any>("/progress", {
        course_id: selectedCourseId,
        progress_percent: percent
      });

      // Update local enrollment state
      setEnrollment(prev => prev ? {
        ...prev,
        progress_percent: data.progress_percent,
        completed_at: data.completed_at
      } : null);

      // Update in courses list as well
      setCourses(prev => prev.map(c => 
        c.id === selectedCourseId ? { ...c, progress_percent: percent, completed_at: data.completed_at } : c
      ));

      checkGamificationResponse(data);
    } catch (err) {
      console.error("Failed to sync progress telemetry:", err);
    }
  };

  // Reload lesson completion and locks (sequential unlocks) after a lesson is completed
  const refreshCurriculum = async (courseId: string) => {
    try {
      const data = await api.get<{ lessons: Lesson[]; sections?: CourseSection[]; enrollment: typeof enrollment }>(`/courses/${courseId}`);
      setLessons(data.lessons);
      setSections(data.sections || []);
      if (data.enrollment) setEnrollment(data.enrollment);
      setCourses(prev => prev.map(course => course.id === courseId && data.enrollment ? { ...course, progress_percent: data.enrollment.progress_percent } : course));
    } catch (error) {
      console.error("Failed to refresh curriculum:", error);
    }
  };
  const activeLessonMeta = lessons.find(l => l.id === activeLessonId) || null;

  // Triggered when lesson is completed
  const handleVideoCompleted = async () => {
    if (!activeLessonId || !selectedCourseId) return;
    try {
      const result = await api.post<{ progress_percent: number }>(`/student/lessons/${activeLessonId}/progress`, {
        resume_seconds: currentVideoSeconds,
        completed: 1
      });
      setEnrollment(prev => prev ? { ...prev, progress_percent: result.progress_percent,
        completed_at: result.progress_percent === 100 ? new Date().toISOString() : prev.completed_at } : null);
      setCourses(prev => prev.map(course => course.id === selectedCourseId
        ? { ...course, progress_percent: result.progress_percent } : course));
      refreshCurriculum(selectedCourseId);
    } catch (error) {
      console.error("Failed to complete lesson:", error);
    }
  };

  // Helper: Format ISO date to read humanly
  const formatDate = (dateString: string | null) => {
    if (!dateString) return "";
    return new Date(dateString).toLocaleDateString("th-TH", {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  };

  // Helper: Format seconds to mm:ss
  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  };

  // Thai display labels for raw enum values (logic keeps original values)
  const budgetTypeLabel = (t: string) => {
    const m: Record<string, string> = { fixed: "ราคาคงที่", hourly: "รายชั่วโมง", monthly: "รายเดือน" };
    return m[String(t).toLowerCase()] || t;
  };
  const bidStatusLabel = (s: string | null | undefined) => {
    const m: Record<string, string> = {
      pending: "รอดำเนินการ", accepted: "อนุมัติแล้ว", rejected: "ปฏิเสธแล้ว", approved: "อนุมัติแล้ว",
      completed: "เรียนจบ", open: "เปิดรับ", closed: "ปิดรับ", in_progress: "กำลังดำเนินการ",
      submitted: "ส่งแล้ว", paid: "ชำระแล้ว", expired: "หมดอายุ", active: "ใช้งานอยู่", cancelled: "ยกเลิกแล้ว"
    };
    return s ? (m[String(s).toLowerCase()] || s) : "";
  };

  const renderFreelancePortal = () => {
    const studentBids = outsourceProjects.filter(p => p.myBidStatus !== null && p.myBidStatus !== 'accepted');
    const studentProjects = outsourceProjects.filter(p => p.myBidStatus === 'accepted');

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
        {/* Student Outsource Agent Portfolio */}
        <div className="glass-card" style={{ 
          padding: "20px", 
          background: "linear-gradient(135deg, rgba(168,85,247,0.06) 0%, rgba(59,130,246,0.03) 100%)",
          border: "1px solid rgba(168,85,247,0.2)",
          borderRadius: "1.5rem",
          display: "flex",
          flexDirection: "column",
          gap: "12px"
        }}>
          <div>
            <span style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase", color: "var(--primary)", letterSpacing: "1px" }}>
              🤖 พอร์ตโฟลิโอเอเจนต์รับงาน Outsource
            </span>
            <h3 style={{ fontSize: "18px", fontWeight: "800", color: "var(--text-primary)", margin: "4px 0 0 0" }}>
              {api.user?.name} (เอเจนต์ เลเวล {gamificationProfile.level})
            </h3>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", margin: "4px 0 0 0" }}>
              แสดงโปรไฟล์การเรียนของคุณเป็นเอเจนต์ไอทีอัตโนมัติ คอร์สที่เรียนจบและพื้นที่ทดลองโค้ดจะถูกผูกเป็น **เครื่องมือ/ทักษะของเอเจนต์** สำหรับจับคู่กับองค์กร
            </p>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", marginTop: "8px" }}>
            {courses.filter(c => c.progress_percent === 100).length === 0 && (!gamificationProfile.achievements || gamificationProfile.achievements.length === 0) ? (
              <span style={{ fontSize: "12px", color: "var(--text-muted)", fontStyle: "italic" }}>
                ยังไม่มีทักษะที่ผูกไว้ เรียนคอร์สให้จบหรือลองเล่นในพื้นที่ทดลองโค้ดเพื่อรับเครื่องมือ!
              </span>
            ) : (
              <>
                {courses.filter(c => c.progress_percent === 100).map(c => (
                  <div key={c.id} style={{ 
                    display: "flex", 
                    alignItems: "center", 
                    gap: "6px", 
                    background: "rgba(168,85,247,0.08)", 
                    border: "1px solid rgba(168,85,247,0.3)", 
                    padding: "6px 12px", 
                    borderRadius: "1rem", 
                    fontSize: "12px",
                    color: "var(--accent)"
                  }}>
                    <Zap size={12} />
                    <strong>ทักษะที่ติดตั้ง:</strong> {c.title.replace("Masterclass", "").replace("Exam Prep", "")}
                  </div>
                ))}
                {gamificationProfile?.achievements?.map((ach: any) => (
                  <div key={ach.id} style={{ 
                    display: "flex", 
                    alignItems: "center", 
                    gap: "6px", 
                    background: "rgba(59,130,246,0.08)", 
                    border: "1px solid rgba(59,130,246,0.3)", 
                    padding: "6px 12px", 
                    borderRadius: "1rem", 
                    fontSize: "12px",
                    color: "#60a5fa"
                  }}>
                    <Terminal size={12} />
                    <strong>เครื่องมือจากพื้นที่ทดลอง:</strong> {ach.name}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        {/* Navigation Tabs */}
        <div style={{ display: "flex", gap: "12px", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "12px" }}>
          <button
            onClick={() => setActiveOutsourceTab("projects")}
            className={activeOutsourceTab === "projects" ? "tech-button-primary" : "tech-button-outline"}
            style={{ borderRadius: "1rem", padding: "8px 16px", cursor: "pointer" }}
          >
            กระดานโปรเจกต์
          </button>
          <button
            onClick={() => setActiveOutsourceTab("my-bids")}
            className={activeOutsourceTab === "my-bids" ? "tech-button-primary" : "tech-button-outline"}
            style={{ borderRadius: "1rem", padding: "8px 16px", cursor: "pointer" }}
          >
            ข้อเสนอของฉัน ({studentBids.length})
          </button>
          <button
            onClick={() => setActiveOutsourceTab("my-projects")}
            className={activeOutsourceTab === "my-projects" ? "tech-button-primary" : "tech-button-outline"}
            style={{ borderRadius: "1rem", padding: "8px 16px", cursor: "pointer" }}
          >
            งานที่ได้รับ ({studentProjects.length})
          </button>
        </div>

        {/* Tab 1: Available Projects */}
        {activeOutsourceTab === "projects" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {outsourceProjects.filter(p => p.myBidStatus === null && p.status === 'open').length === 0 ? (
              <div className="glass-card" style={{ padding: "48px", textAlign: "center", color: "var(--text-secondary)" }}>
                ขณะนี้ยังไม่มีโปรเจกต์จ้างงานที่เปิดรับ กลับมาตรวจสอบใหม่ภายหลัง
              </div>
            ) : (
              outsourceProjects.filter(p => p.myBidStatus === null && p.status === 'open').map((proj) => (
                <motion.div 
                  key={proj.id} 
                  className="glass-card" 
                  whileHover={{ scale: 1.02, boxShadow: "0 0 20px rgba(168,85,247,0.3)", borderColor: "rgba(168,85,247,0.5)" }}
                  transition={{ type: "spring", stiffness: 300 }}
                  style={{
                  padding: "24px", 
                  display: "flex", 
                  flexDirection: "column", 
                  gap: "16px",
                  border: "1px solid var(--border-subtle)",
                  background: "linear-gradient(135deg, rgba(255,255,255,0.01) 0%, rgba(255,255,255,0.03) 100%)"
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
                    <div>
                      <span style={{ fontSize: "11px", color: "var(--primary)", fontWeight: 700, textTransform: "uppercase" }}>{proj.companyName}</span>
                      <h3 style={{ fontSize: "18px", fontWeight: "bold", color: "var(--text-primary)", margin: "4px 0" }}>{proj.title}</h3>
                      <p style={{ fontSize: "13px", color: "var(--text-secondary)", margin: 0 }}>{proj.description}</p>
                    </div>
                    {/* Matching score badge */}
                    <div style={{ 
                      background: proj.matchingScore >= 80 ? "rgba(34,197,94,0.12)" : proj.matchingScore >= 50 ? "rgba(245,158,11,0.12)" : "rgba(239,68,68,0.12)",
                      border: `1px solid ${proj.matchingScore >= 80 ? "#22c55e" : proj.matchingScore >= 50 ? "#f59e0b" : "#ef4444"}`,
                      color: proj.matchingScore >= 80 ? "#22c55e" : proj.matchingScore >= 50 ? "#f59e0b" : "#ef4444",
                      padding: "6px 14px",
                      borderRadius: "2rem",
                      fontSize: "12px",
                      fontWeight: "bold"
                    }}>
                      เหมาะสม {proj.matchingScore}%
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", borderTop: "1px solid var(--border-subtle)", paddingTop: "12px" }}>
                    <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                      งบประมาณ: <strong style={{ color: "var(--text-primary)" }}>{proj.budget_range} ({budgetTypeLabel(proj.budget_type)})</strong>
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                      เลเวลขั้นต่ำ: <strong style={{ color: "var(--text-primary)" }}>เลเวล {proj.min_level}</strong>
                    </div>
                  </div>

                  <div style={{ fontSize: "13px", color: "var(--text-secondary)", background: "rgba(0,0,0,0.1)", padding: "12px", borderRadius: "8px" }}>
                    <strong>ขอบเขตงาน:</strong>
                    <p style={{ margin: "4px 0 0 0", fontSize: "12px", lineHeight: "1.5" }}>{proj.scope_of_work}</p>
                  </div>

                  {applyingProjectId === proj.id ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px", background: "rgba(255,255,255,0.02)", padding: "16px", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.05)" }}>
                      <h4 style={{ fontSize: "14px", color: "var(--text-primary)", fontWeight: "bold" }}>ส่งข้อเสนอราคา</h4>
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <label style={{ fontSize: "11px", color: "var(--text-secondary)" }}>ราคาที่คุณเสนอ (฿)</label>
                        <input
                          type="text"
                          className="form-input"
                          value={bidAmountText}
                          onChange={(e) => setBidAmountText(e.target.value)}
                          style={{ width: "200px" }}
                        />
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <label style={{ fontSize: "11px", color: "var(--text-secondary)" }}>ข้อเสนองาน / ข้อความแนะนำตัว</label>
                        <textarea
                          className="form-input"
                          rows={3}
                          placeholder="อธิบายคุณสมบัติของคุณและแนวทางการดำเนินงานตามขอบเขตงาน..."
                          value={proposalText}
                          onChange={(e) => setProposalText(e.target.value)}
                          style={{ width: "100%", resize: "none" }}
                        />
                      </div>
                      <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
                        <button
                          onClick={() => handleApplyProject(proj.id)}
                          disabled={!proposalText.trim() || !bidAmountText.trim()}
                          className="tech-button-primary"
                          style={{ padding: "8px 16px", borderRadius: "0.5rem" }}
                        >
                          ส่งข้อเสนอ
                        </button>
                        <button
                          onClick={() => setApplyingProjectId(null)}
                          className="tech-button-outline"
                          style={{ padding: "8px 16px", borderRadius: "0.5rem" }}
                        >
                          ยกเลิก
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setApplyingProjectId(proj.id);
                        setBidAmountText(proj.budget_range.replace(/[^0-9-]/g, '').split('-')[0] || "5000");
                      }}
                      className="tech-button-primary"
                      style={{ alignSelf: "flex-start", padding: "8px 16px", borderRadius: "0.5rem" }}
                    >
                      เสนอราคา
                    </button>
                  )}
                </motion.div>
              ))
            )}
          </div>
        )}

        {/* Tab 2: Submitted Bids */}
        {activeOutsourceTab === "my-bids" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {studentBids.length === 0 ? (
              <div className="glass-card" style={{ padding: "48px", textAlign: "center", color: "var(--text-secondary)" }}>
                คุณยังไม่ได้เสนอราคาโปรเจกต์จ้างงานใดเลย
              </div>
            ) : (
              studentBids.map((proj) => (
                <motion.div 
                  key={proj.id} 
                  className="glass-card" 
                  whileHover={{ scale: 1.02, boxShadow: "0 0 20px rgba(168,85,247,0.3)", borderColor: "rgba(168,85,247,0.5)" }}
                  transition={{ type: "spring", stiffness: 300 }}
                  style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>{proj.companyName}</span>
                      <h4 style={{ fontSize: "16px", fontWeight: "bold", color: "var(--text-primary)", margin: "2px 0" }}>{proj.title}</h4>
                    </div>
                    <span className="badge-gamified" style={{ 
                      background: proj.myBidStatus === 'rejected' ? "rgba(239,68,68,0.12)" : "rgba(59,130,246,0.12)",
                      color: proj.myBidStatus === 'rejected' ? "#ef4444" : "#3b82f6",
                      borderColor: "transparent"
                    }}>
                      {bidStatusLabel(proj.myBidStatus)}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: "16px", fontSize: "12px", color: "var(--text-secondary)" }}>
                    <span>งบประมาณตามขอบเขตงาน: <strong>{proj.budget_range}</strong></span>
                    <span>ราคาที่คุณเสนอ: <strong>฿{proj.myBidAmount}</strong></span>
                  </div>
                </motion.div>
              ))
            )}
          </div>
        )}

        {/* Tab 3: Active Hires & Milestones */}
        {activeOutsourceTab === "my-projects" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            {studentProjects.length === 0 ? (
              <div className="glass-card" style={{ padding: "48px", textAlign: "center", color: "var(--text-secondary)" }}>
                คุณยังไม่มีข้อตกลงโปรเจกต์ฟรีแลนซ์ที่กำลังดำเนินการ
              </div>
            ) : (
              studentProjects.map((proj) => (
                <motion.div 
                  key={proj.id} 
                  className="glass-card" 
                  whileHover={{ scale: 1.02, boxShadow: "0 0 20px rgba(34,197,94,0.3)", borderColor: "rgba(34,197,94,0.5)" }}
                  transition={{ type: "spring", stiffness: 300 }}
                  style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px", border: "1px solid rgba(34,197,94,0.2)" }}>
                  <div>
                    <span style={{ fontSize: "11px", color: "#22c55e", fontWeight: "bold" }}>ได้รับงานแล้ว • กำลังดำเนินการ</span>
                    <h3 style={{ fontSize: "18px", fontWeight: "bold", color: "var(--text-primary)", margin: "4px 0" }}>{proj.title}</h3>
                    <p style={{ fontSize: "12px", color: "var(--text-secondary)" }}>ลูกค้า: {proj.companyName} • งบประมาณ: ฿{proj.myBidAmount}</p>
                  </div>

                  {/* Milestones Area */}
                  <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: "16px" }}>
                    <h4 style={{ fontSize: "14px", fontWeight: "bold", color: "var(--text-primary)", marginBottom: "12px" }}>การส่งมอบงานตามงวดงาน (Milestone)</h4>
                    
                    {proj.milestones && proj.milestones.length > 0 ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        {proj.milestones.map((ms: any) => (
                          <div key={ms.id} style={{ 
                            background: "rgba(255,255,255,0.02)", 
                            border: "1px solid rgba(255,255,255,0.05)", 
                            borderRadius: "12px", 
                            padding: "16px",
                            display: "flex",
                            flexDirection: "column",
                            gap: "10px"
                          }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <strong style={{ fontSize: "13px", color: "var(--text-primary)" }}>{ms.title}</strong>
                              <span style={{ 
                                fontSize: "11px", 
                                fontWeight: "bold", 
                                color: ms.status === 'approved' ? "#22c55e" : ms.status === 'submitted' ? "#f59e0b" : "var(--text-secondary)"
                              }}>
                                {ms.status === 'approved' ? "อนุมัติแล้ว ✓" : ms.status === 'submitted' ? "ส่งตรวจสอบแล้ว" : "รอดำเนินการ"}
                              </span>
                            </div>
                            <p style={{ fontSize: "12px", color: "var(--text-secondary)", margin: 0 }}>{ms.description}</p>
                            
                            {ms.status === 'approved' && (
                              <div style={{ fontSize: "11px", color: "#22c55e", background: "rgba(34,197,94,0.08)", padding: "8px", borderRadius: "6px" }}>
                                <strong>ความเห็นจากลูกค้า:</strong> ตรวจสอบงานที่ส่งมอบแล้ว เพิ่ม +200 EXP
                              </div>
                            )}

                            {ms.status === 'pending' && (
                              submittingMilestoneId === ms.id ? (
                                <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "6px" }}>
                                  <textarea
                                    className="form-input"
                                    placeholder="แนบลิงก์ GitHub repo ภาพหน้าจอ หรือบันทึกการตั้งค่า..."
                                    rows={2}
                                    value={milestoneDeliverablesText}
                                    onChange={(e) => setMilestoneDeliverablesText(e.target.value)}
                                    style={{ width: "100%", fontSize: "12px", resize: "none" }}
                                  />
                                  <div style={{ display: "flex", gap: "8px" }}>
                                    <button
                                      onClick={() => handleMilestoneSubmit(ms.id)}
                                      disabled={!milestoneDeliverablesText.trim()}
                                      className="tech-button-primary"
                                      style={{ padding: "6px 12px", borderRadius: "0.25rem", fontSize: "11px" }}
                                    >
                                      ส่งงาน
                                    </button>
                                    <button
                                      onClick={() => setSubmittingMilestoneId(null)}
                                      className="tech-button-outline"
                                      style={{ padding: "6px 12px", borderRadius: "0.25rem", fontSize: "11px" }}
                                    >
                                      ยกเลิก
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setSubmittingMilestoneId(ms.id)}
                                  className="tech-button-outline"
                                  style={{ alignSelf: "flex-start", padding: "6px 12px", borderRadius: "0.25rem", fontSize: "11px", marginTop: "4px" }}
                                >
                                  ส่งงานงวดนี้
                                </button>
                              )
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>ยังไม่มีการกำหนดงวดงานสำหรับข้อตกลงโปรเจกต์นี้</span>
                    )}
                  </div>
                </motion.div>
              ))
            )}
          </div>
        )}
      </div>
    );
  };

  const renderInternshipPortal = () => {
    if (loadingInternships) {
      return (
        <div style={{ display: "flex", justifyContent: "center", padding: "64px" }}>
          <div className="spinner" style={{ border: "3px solid var(--border-subtle)", borderTop: "3px solid var(--primary)", borderRadius: "50%", width: "40px", height: "40px", animation: "spin 1s linear infinite" }} />
        </div>
      );
    }

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
        {internshipError && (
          <div className="glass-card" style={{ padding: "16px", borderColor: "rgba(239, 68, 68, 0.4)", background: "rgba(239, 68, 68, 0.05)", color: "#ef4444", borderRadius: "1rem", display: "flex", gap: "10px", alignItems: "center" }}>
            <AlertCircle size={20} />
            <span>{internshipError}</span>
          </div>
        )}

        {internshipSuccess && (
          <div className="glass-card" style={{ padding: "16px", borderColor: "rgba(34, 197, 94, 0.4)", background: "rgba(34, 197, 94, 0.05)", color: "#22c55e", borderRadius: "1rem", display: "flex", gap: "10px", alignItems: "center" }}>
            <CheckCircle size={20} />
            <span>{internshipSuccess}</span>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: "32px", alignItems: "start" }} className="internship-grid-responsive">
          <style>{`
            @media (max-width: 1024px) {
              .internship-grid-responsive {
                grid-template-columns: 1fr !important;
              }
            }
          `}</style>

          {/* Left Column: Job Openings Board */}
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <Briefcase size={20} color="var(--primary)" />
              <h2 style={{ fontSize: "20px", color: "var(--text-primary)" }}>ตำแหน่งฝึกงานที่เปิดรับ</h2>
            </div>

            {internshipOpenings.length === 0 ? (
              <div className="glass-card" style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary)" }}>
                ขณะนี้ยังไม่มีตำแหน่งฝึกงานที่เปิดรับ
              </div>
            ) : (
              internshipOpenings.map((opening) => {
                const requiredCourseId = opening.required_course_id;
                const matchCourse = courses.find(c => c.id === requiredCourseId);
                const progress = matchCourse ? (matchCourse.progress_percent || 0) : 0;
                const isEligible = progress >= 95;
                const hasApplied = myApplications.some(app => app.opening_id === opening.id);

                return (
                  <div key={opening.id} className="glass-card" style={{
                    padding: "20px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "14px",
                    borderLeft: isEligible ? "4px solid var(--primary)" : "4px solid var(--border-subtle)"
                  }}>
                    <div>
                      <h3 style={{ fontSize: "16px", color: "var(--text-primary)", fontWeight: 600, marginBottom: "4px" }}>{opening.title}</h3>
                      <span style={{ fontSize: "13px", color: "var(--text-secondary)", display: "block" }}>🏢 {opening.company_name}</span>
                    </div>

                    <p style={{ fontSize: "14px", color: "var(--text-secondary)", lineHeight: "1.5", margin: 0 }}>
                      {opening.description}
                    </p>

                    <div style={{ padding: "10px 14px", background: "rgba(255,255,255,0.02)", borderRadius: "0.5rem", border: "1px solid var(--border-subtle)", fontSize: "13px" }}>
                      <span style={{ color: "var(--text-secondary)", display: "block", marginBottom: "4px" }}>คอร์สที่ต้องเรียนก่อน:</span>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{opening.course_title}</span>
                        <span style={{
                          color: isEligible ? "#22c55e" : "var(--primary)",
                          fontWeight: 600,
                          background: isEligible ? "rgba(34, 197, 94, 0.1)" : "rgba(229, 107, 37, 0.1)",
                          padding: "2px 8px",
                          borderRadius: "0.5rem"
                        }}>
                          เรียนแล้ว {progress}%
                        </span>
                      </div>
                    </div>

                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "4px" }}>
                      {hasApplied ? (
                        <button disabled className="tech-button-outline" style={{ borderRadius: "0.75rem", fontSize: "13px", padding: "8px 16px", opacity: 0.7, cursor: "not-allowed" }}>
                          สมัครแล้ว ✓
                        </button>
                      ) : (
                        <button
                          disabled={!isEligible || applyingForOpeningId === opening.id}
                          onClick={() => handleApplyInternship(opening.id)}
                          className={isEligible ? "tech-button-primary" : "tech-button-outline"}
                          style={{
                            borderRadius: "0.75rem",
                            fontSize: "13px",
                            padding: "8px 16px",
                            opacity: isEligible ? 1 : 0.5,
                            cursor: isEligible ? "pointer" : "not-allowed",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px"
                          }}
                        >
                          {applyingForOpeningId === opening.id ? (
                            <div className="spinner" style={{ border: "2px solid #fff", borderTop: "2px solid transparent", borderRadius: "50%", width: "14px", height: "14px", animation: "spin 1s linear infinite" }} />
                          ) : (
                            <Send size={14} />
                          )}
                          สมัครฝึกงาน
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Right Column: Applications & Daily Logs */}
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <ClipboardList size={20} color="var(--primary)" />
              <h2 style={{ fontSize: "20px", color: "var(--text-primary)" }}>ใบสมัครและบันทึกของฉัน</h2>
            </div>

            {myApplications.length === 0 ? (
              <div className="glass-card" style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary)" }}>
                คุณยังไม่ได้ส่งใบสมัครฝึกงาน เรียนคอร์สตามเกณฑ์ให้ครบแล้วสมัครตำแหน่งทางด้านซ้าย
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <label style={{ fontSize: "13px", color: "var(--text-secondary)", fontWeight: 600 }}>เลือกใบสมัครฝึกงาน:</label>
                  <select
                    value={selectedApplicationId || ""}
                    onChange={(e) => {
                      const appId = e.target.value;
                      setSelectedApplicationId(appId);
                      fetchApplicationLogs(appId);
                    }}
                    style={{
                      background: "rgba(255, 255, 255, 0.05)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "0.75rem",
                      padding: "10px 14px",
                      fontSize: "14px",
                      width: "100%",
                      outline: "none"
                    }}
                  >
                    {myApplications.map(app => (
                      <option key={app.id} value={app.id} style={{ background: "#18181b", color: "#fff" }}>
                        {app.opening_title} ที่ {app.company_name} ({bidStatusLabel(app.status)})
                      </option>
                    ))}
                  </select>
                </div>

                {(() => {
                  const currentApp = myApplications.find(a => a.id === selectedApplicationId);
                  if (!currentApp) return null;

                  const isActiveOrCompleted = currentApp.status === "accepted" || currentApp.status === "completed";

                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                      <div className="glass-card" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontSize: "14px", color: "var(--text-secondary)" }}>สถานะ:</span>
                          <span style={{
                            padding: "4px 10px",
                            borderRadius: "1rem",
                            fontSize: "12px",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            background:
                              currentApp.status === "accepted" ? "rgba(34,197,94,0.15)" :
                              currentApp.status === "completed" ? "rgba(59,130,246,0.15)" :
                              currentApp.status === "rejected" ? "rgba(239,68,68,0.15)" :
                              "rgba(229,107,37,0.15)",
                            color:
                              currentApp.status === "accepted" ? "#22c55e" :
                              currentApp.status === "completed" ? "#3b82f6" :
                              currentApp.status === "rejected" ? "#ef4444" :
                              "var(--primary)",
                            border: `1px solid ${
                              currentApp.status === "accepted" ? "rgba(34,197,94,0.3)" :
                              currentApp.status === "completed" ? "rgba(59,130,246,0.3)" :
                              currentApp.status === "rejected" ? "rgba(239,68,68,0.3)" :
                              "rgba(229,107,37,0.3)"
                            }`
                          }}>
                            {bidStatusLabel(currentApp.status)}
                          </span>
                        </div>

                        {currentApp.evaluation_score !== null && (
                          <div style={{ padding: "10px", background: "rgba(255,255,255,0.02)", borderRadius: "0.5rem", border: "1px solid var(--border-subtle)" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                              <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>การประเมินจากบริษัท:</span>
                              <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--primary)" }}>{currentApp.evaluation_score}/100</span>
                            </div>
                            {currentApp.evaluation_feedback && (
                              <p style={{ fontSize: "13px", color: "var(--text-primary)", margin: 0, fontStyle: "italic" }}>
                                "{currentApp.evaluation_feedback}"
                              </p>
                            )}
                          </div>
                        )}

                        {currentApp.university_feedback && (
                          <div style={{ padding: "10px", background: "rgba(168,85,247,0.05)", borderRadius: "0.5rem", border: "1px solid rgba(168,85,247,0.2)" }}>
                            <span style={{ fontSize: "13px", color: "rgb(216,180,254)", display: "block", marginBottom: "4px", fontWeight: 600 }}>ความเห็นจากผู้ประสานงานมหาวิทยาลัย:</span>
                            <p style={{ fontSize: "13px", color: "var(--text-primary)", margin: 0, fontStyle: "italic" }}>
                              "{currentApp.university_feedback}"
                            </p>
                          </div>
                        )}
                      </div>

                      {isActiveOrCompleted && (
                        <div className="glass-card" style={{ padding: "20px" }}>
                          <h3 style={{ fontSize: "16px", color: "var(--text-primary)", fontWeight: 600, marginBottom: "16px", display: "flex", alignItems: "center", gap: "8px" }}>
                            <Plus size={18} color="var(--primary)" /> เพิ่มบันทึกชั่วโมงทำงานประจำวัน
                          </h3>
                          <form onSubmit={handleSubmitDailyLog} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>วันที่บันทึก</label>
                                <input
                                  type="date"
                                  value={logDate}
                                  onChange={(e) => setLogDate(e.target.value)}
                                  required
                                  style={{
                                    background: "rgba(255,255,255,0.05)",
                                    border: "1px solid var(--border-subtle)",
                                    borderRadius: "0.5rem",
                                    padding: "8px 12px",
                                    color: "#fff",
                                    outline: "none"
                                  }}
                                />
                              </div>
                              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>ชั่วโมงที่ทำงาน</label>
                                <input
                                  type="number"
                                  step="0.5"
                                  min="0.5"
                                  max="24"
                                  value={logHours}
                                  onChange={(e) => setLogHours(e.target.value)}
                                  required
                                  style={{
                                    background: "rgba(255,255,255,0.05)",
                                    border: "1px solid var(--border-subtle)",
                                    borderRadius: "0.5rem",
                                    padding: "8px 12px",
                                    color: "#fff",
                                    outline: "none"
                                  }}
                                />
                              </div>
                            </div>

                            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                              <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>รายละเอียดกิจกรรม</label>
                              <textarea
                                value={logDescription}
                                onChange={(e) => setLogDescription(e.target.value)}
                                placeholder="อธิบายงานที่ทำวันนี้ (เช่น สร้างเลย์เอาต์แบบ responsive, แก้บั๊ก API router)..."
                                required
                                rows={3}
                                style={{
                                  background: "rgba(255,255,255,0.05)",
                                  border: "1px solid var(--border-subtle)",
                                  borderRadius: "0.5rem",
                                  padding: "8px 12px",
                                  color: "#fff",
                                  fontFamily: "inherit",
                                  resize: "vertical",
                                  outline: "none"
                                }}
                              />
                            </div>

                            <button
                              type="submit"
                              disabled={submittingLog}
                              className="tech-button-primary"
                              style={{
                                width: "100%",
                                borderRadius: "0.5rem",
                                padding: "10px",
                                display: "inline-flex",
                                justifyContent: "center",
                                alignItems: "center",
                                gap: "8px",
                                cursor: "pointer",
                                marginTop: "6px"
                              }}
                            >
                              {submittingLog && (
                                <div className="spinner" style={{ border: "2px solid #fff", borderTop: "2px solid transparent", borderRadius: "50%", width: "14px", height: "14px", animation: "spin 1s linear infinite" }} />
                              )}
                              ส่งบันทึกชั่วโมงทำงาน
                            </button>
                          </form>
                        </div>
                      )}

                      {isActiveOrCompleted && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                          <h3 style={{ fontSize: "15px", color: "var(--text-primary)", fontWeight: 600, display: "flex", alignItems: "center", gap: "8px" }}>
                            <Clock size={16} color="var(--primary)" /> ประวัติบันทึกชั่วโมงทำงาน ({applicationLogs.length} รายการ)
                          </h3>

                          {applicationLogs.length === 0 ? (
                            <div className="glass-card" style={{ padding: "20px", textAlign: "center", color: "var(--text-secondary)", fontSize: "13px" }}>
                              ยังไม่มีบันทึกประจำวัน เริ่มบันทึกกิจกรรมของคุณด้านบนได้เลย
                            </div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                              {applicationLogs.map((log) => (
                                <div key={log.id} className="glass-card" style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
                                    <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>📅 {log.log_date} ({log.hours_worked} ชม.)</span>
                                    <div style={{ display: "flex", gap: "8px" }}>
                                      <span style={{
                                        fontSize: "11px",
                                        padding: "2px 8px",
                                        borderRadius: "0.5rem",
                                        background: log.company_approved === 1 ? "rgba(34,197,94,0.1)" : log.company_approved === -1 ? "rgba(239,68,68,0.1)" : "rgba(255,255,255,0.05)",
                                        color: log.company_approved === 1 ? "#22c55e" : log.company_approved === -1 ? "#ef4444" : "var(--text-secondary)",
                                        border: `1px solid ${log.company_approved === 1 ? "rgba(34,197,94,0.2)" : log.company_approved === -1 ? "rgba(239,68,68,0.2)" : "var(--border-subtle)"}`
                                      }}>
                                        บริษัท: {log.company_approved === 1 ? "อนุมัติแล้ว" : log.company_approved === -1 ? "ปฏิเสธแล้ว" : "รอดำเนินการ"}
                                      </span>
                                      <span style={{
                                        fontSize: "11px",
                                        padding: "2px 8px",
                                        borderRadius: "0.5rem",
                                        background: log.university_approved === 1 ? "rgba(34,197,94,0.1)" : log.university_approved === -1 ? "rgba(239,68,68,0.1)" : "rgba(255,255,255,0.05)",
                                        color: log.university_approved === 1 ? "#22c55e" : log.university_approved === -1 ? "#ef4444" : "var(--text-secondary)",
                                        border: `1px solid ${log.university_approved === 1 ? "rgba(34,197,94,0.2)" : log.university_approved === -1 ? "rgba(239,68,68,0.2)" : "var(--border-subtle)"}`
                                      }}>
                                        มหาวิทยาลัย: {log.university_approved === 1 ? "อนุมัติแล้ว" : log.university_approved === -1 ? "ปฏิเสธแล้ว" : "รอดำเนินการ"}
                                      </span>
                                    </div>
                                  </div>
                                  <p style={{ fontSize: "13px", color: "var(--text-secondary)", margin: 0, lineHeight: "1.4" }}>
                                    {log.activity_description}
                                  </p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>

        {/* Bottom Section: Achievements & Leaderboard */}
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: "32px", borderTop: "1px solid var(--border-subtle)", paddingTop: "32px" }} className="internship-grid-responsive">
          {/* Achievements Badge Case */}
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <Award size={20} color="var(--primary)" />
              <h2 style={{ fontSize: "20px", color: "var(--text-primary)" }}>ตู้เหรียญตราความสำเร็จของฉัน</h2>
            </div>
            
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: "16px" }}>
              {gamificationProfile?.achievements?.map((ach: any) => {
                const IconComponent = ach.badgeIcon === 'Award' ? Award : ach.badgeIcon === 'BookOpen' ? BookOpen : ach.badgeIcon === 'Clock' ? Clock : Sparkles;
                
                return (
                  <div 
                    key={ach.id} 
                    className="glass-card" 
                    style={{ 
                      padding: "16px", 
                      display: "flex", 
                      flexDirection: "column", 
                      alignItems: "center", 
                      textAlign: "center", 
                      gap: "10px",
                      opacity: ach.unlocked ? 1 : 0.4,
                      filter: ach.unlocked ? "none" : "grayscale(80%)",
                      border: ach.unlocked ? "1px solid rgba(168,85,247,0.3)" : "1px solid var(--border-subtle)",
                      background: ach.unlocked ? "linear-gradient(135deg, rgba(168,85,247,0.05) 0%, rgba(229,107,37,0.02) 100%)" : "rgba(255,255,255,0.01)"
                    }}
                  >
                    <div style={{ 
                      background: ach.unlocked ? "linear-gradient(135deg, #a855f7 0%, #e56b25 100%)" : "rgba(255,255,255,0.05)",
                      color: ach.unlocked ? "#fff" : "var(--text-secondary)",
                      padding: "12px",
                      borderRadius: "50%",
                      boxShadow: ach.unlocked ? "0 4px 12px rgba(168,85,247,0.3)" : "none"
                    }}>
                      <IconComponent size={24} />
                    </div>
                    <div>
                      <h4 style={{ fontSize: "13px", color: "var(--text-primary)", fontWeight: 700, margin: "0 0 2px 0" }}>{ach.name}</h4>
                      <p style={{ fontSize: "11px", color: "var(--text-secondary)", margin: 0, lineHeight: "1.3" }}>{ach.description}</p>
                    </div>
                    <span style={{ 
                      fontSize: "10px", 
                      padding: "1px 6px", 
                      borderRadius: "0.5rem", 
                      background: ach.unlocked ? "rgba(34,197,94,0.1)" : "rgba(255,255,255,0.05)",
                      color: ach.unlocked ? "#22c55e" : "var(--text-secondary)",
                      fontWeight: 600
                    }}>
                      {ach.unlocked ? `ปลดล็อกแล้ว ✓` : `+${ach.expReward} EXP`}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Hall of Fame Leaderboard */}
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <TrendingUp size={20} color="var(--primary)" />
              <h2 style={{ fontSize: "20px", color: "var(--text-primary)" }}>ทำเนียบผู้เรียนเด่น Netprime</h2>
            </div>

            <div className="glass-card" style={{ padding: "0 20px" }}>
              {leaderboard.length === 0 ? (
                <div style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary)" }}>
                  ยังไม่มีผู้เรียนในอันดับ
                </div>
              ) : (
                leaderboard.map((item, idx) => (
                  <div 
                    key={item.email} 
                    style={{ 
                      display: "flex", 
                      alignItems: "center", 
                      justifyContent: "space-between", 
                      padding: "14px 0", 
                      borderBottom: idx === leaderboard.length - 1 ? "none" : "1px solid var(--border-subtle)" 
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                      <span style={{ 
                        fontSize: "14px", 
                        fontWeight: 800, 
                        color: idx === 0 ? "#fbbf24" : idx === 1 ? "#94a3b8" : idx === 2 ? "#b45309" : "var(--text-secondary)",
                        width: "20px"
                      }}>
                        #{idx + 1}
                      </span>
                      <div>
                        <h4 style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>
                          {item.name} {item.email === api.user?.email && <span style={{ fontSize: "10px", background: "var(--primary-glow)", color: "var(--primary)", padding: "1px 6px", borderRadius: "1rem", marginLeft: "4px" }}>คุณ</span>}
                        </h4>
                        <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>{item.title}</span>
                      </div>
                    </div>
                    
                    <div style={{ textAlign: "right" }}>
                      <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--primary)", display: "block" }}>{item.exp} EXP</span>
                      <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>เลเวล {item.level}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div>
      {/* Gamification Alerts */}
      <AnimatePresence>
        {showLevelUpAlert && levelUpData && (
          <motion.div
            initial={{ opacity: 0, y: -50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.9 }}
            transition={{ type: "spring", damping: 15 }}
            style={{
              position: "fixed",
              top: "40px",
              left: 0,
              right: 0,
              margin: "0 auto",
              zIndex: 9999,
              background: "linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)",
              color: "#fff",
              padding: "24px 32px",
              borderRadius: "1.5rem",
              boxShadow: "0 20px 40px rgba(168,85,247,0.4), 0 0 0 1px rgba(255,255,255,0.2)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "12px",
              textAlign: "center",
              width: "320px"
            }}
          >
            <div style={{ background: "rgba(255,255,255,0.2)", borderRadius: "50%", padding: "16px" }}>
              <Sparkles size={36} />
            </div>
            <div>
              <h3 style={{ fontSize: "24px", fontWeight: 800, margin: "0 0 4px 0", letterSpacing: "1px" }}>เลเวลอัป!</h3>
              <p style={{ fontSize: "16px", margin: "0 0 12px 0", opacity: 0.9 }}>
                คุณขึ้นสู่ <strong>เลเวล {levelUpData.newLevel}</strong> แล้ว!
              </p>
              <span style={{ fontSize: "12px", background: "rgba(255,255,255,0.15)", padding: "4px 12px", borderRadius: "1rem", fontWeight: 600 }}>
                ฉายาใหม่: {levelUpData.newTitle}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {achievementUnlockedAlert && (
          <motion.div
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 50, scale: 0.9 }}
            transition={{ type: "spring", damping: 15 }}
            style={{
              position: "fixed",
              bottom: "40px",
              right: "40px",
              zIndex: 9999,
              background: "linear-gradient(135deg, #1e1b4b 0%, #311042 100%)",
              border: "1px solid rgba(168,85,247,0.4)",
              color: "#fff",
              padding: "20px",
              borderRadius: "1.25rem",
              boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
              display: "flex",
              alignItems: "center",
              gap: "16px",
              maxWidth: "380px"
            }}
          >
            <div style={{ background: "linear-gradient(135deg, #a855f7 0%, #e56b25 100%)", borderRadius: "50%", padding: "10px" }}>
              <Award size={24} />
            </div>
            <div>
              <span style={{ fontSize: "11px", color: "#a855f7", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }}>
                ปลดล็อกความสำเร็จ
              </span>
              <h4 style={{ fontSize: "15px", fontWeight: 700, margin: "2px 0 4px 0", color: "#fff" }}>
                {achievementUnlockedAlert}
              </h4>
              <p style={{ fontSize: "12px", color: "#94a3b8", margin: 0 }}>
                ไปดูเหรียญตราใหม่ในตู้เหรียญตราของคุณได้เลย!
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="header-row">
        <div>
          <h1 className="header-title">พอร์ทัลการเรียนของผู้เรียน</h1>
          <p className="header-desc">
            สวัสดี {api.user?.name || "ผู้เรียน"} • 
            {api.user?.corporate_id ? ` บัญชีองค์กร (${corporateInfo?.partner?.companyName || "องค์กรของคุณ"})` : ` บัญชีบุคคลทั่วไป`}
          </p>
        </div>
        
        <div style={{ display: "flex", alignItems: "center", gap: "16px", position: "relative" }}>
          {/* Notification Bell */}
          <div style={{ position: "relative", cursor: "pointer", padding: "8px", borderRadius: "50%", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }} onClick={() => {
            setShowNotificationsDropdown(!showNotificationsDropdown);
            if (!showNotificationsDropdown) {
              markNotificationsRead();
            }
          }}>
            <Bell size={18} color={unreadCount > 0 ? "var(--primary)" : "var(--text-secondary)"} />
            {unreadCount > 0 && (
              <span style={{ 
                position: "absolute", 
                top: "-2px", 
                right: "-2px", 
                background: "var(--danger)", 
                color: "#fff", 
                fontSize: "9px", 
                fontWeight: "bold", 
                borderRadius: "50%", 
                padding: "2px 5px",
                lineHeight: 1
              }}>
                {unreadCount}
              </span>
            )}
          </div>

          <button 
            onClick={() => {
              fetchCourses();
              fetchDashboardStats();
              fetchNotifications();
            }}
            className="tech-button-outline"
            style={{ padding: "8px 16px", borderRadius: "1rem" }}
          >
            รีเฟรชรายการคอร์ส
          </button>

          {/* Notifications Dropdown */}
          <AnimatePresence>
            {showNotificationsDropdown && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                style={{
                  position: "absolute",
                  top: "45px",
                  right: 0,
                  width: "280px",
                  maxHeight: "320px",
                  overflowY: "auto",
                  background: "linear-gradient(135deg, #1e1b4b 0%, #110c26 100%)",
                  border: "1px solid rgba(255, 255, 255, 0.1)",
                  borderRadius: "12px",
                  boxShadow: "0 10px 30px rgba(0, 0, 0, 0.5)",
                  zIndex: 999,
                  padding: "12px",
                  textAlign: "left"
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", borderBottom: "1px solid rgba(255,255,255,0.05)", paddingBottom: "6px" }}>
                  <span style={{ fontSize: "12px", fontWeight: "bold", color: "#fff" }}>การแจ้งเตือน</span>
                  <span style={{ fontSize: "10px", color: "var(--text-secondary)", cursor: "pointer" }} onClick={() => setShowNotificationsDropdown(false)}>ปิด</span>
                </div>
                {notifications.length === 0 ? (
                  <div style={{ padding: "16px", fontSize: "11px", color: "var(--text-secondary)", textAlign: "center" }}>ยังไม่มีการแจ้งเตือน</div>
                ) : (
                  notifications.map((n: any) => (
                    <div key={n.id} style={{ 
                      padding: "8px", 
                      borderBottom: "1px solid rgba(255,255,255,0.03)", 
                      background: n.is_read ? "none" : "rgba(168,85,247,0.08)",
                      borderRadius: "6px",
                      marginBottom: "4px"
                    }}>
                      <div style={{ fontSize: "11px", fontWeight: "bold", color: n.is_read ? "var(--text-primary)" : "var(--accent)" }}>{n.title}</div>
                      <div style={{ fontSize: "10px", color: "var(--text-secondary)", marginTop: "2px" }}>{n.content}</div>
                    </div>
                  ))
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* EXP Progress Bar Widget */}
      {gamificationProfile && (
        <div className="glass-card" style={{ 
          padding: "20px", 
          marginBottom: "24px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          background: "linear-gradient(135deg, rgba(168,85,247,0.05) 0%, rgba(59,130,246,0.02) 100%)",
          border: "1px solid rgba(168,85,247,0.2)",
          boxShadow: "0 8px 32px 0 rgba(168,85,247,0.08)",
          position: "relative",
          overflow: "hidden"
        }}>
          <div style={{ position: "absolute", top: 0, right: 0, width: "150px", height: "150px", background: "radial-gradient(circle, rgba(168,85,247,0.1) 0%, rgba(168,85,247,0) 70%)", pointerEvents: "none" }} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: "12px" }}>
            <div>
              <span style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: "1px", color: "var(--primary)", fontWeight: 700 }}>
                {gamificationProfile.title}
              </span>
              <h2 style={{ fontSize: "24px", fontWeight: 800, margin: "4px 0 0 0", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
                เลเวล {gamificationProfile.level} 
                <span style={{ fontSize: "14px", fontWeight: 400, color: "var(--text-secondary)" }}>
                  (อีก {500 - (gamificationProfile.exp % 500)} EXP ถึงเลเวลถัดไป — {gamificationProfile.exp % 500} / 500 EXP)
                </span>
              </h2>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "16px", textAlign: "right" }}>
              {gamificationProfile.streak_count > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: "6px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", padding: "4px 10px", borderRadius: "1rem" }}>
                  <Flame size={14} color="#ef4444" />
                  <span style={{ fontSize: "11px", fontWeight: "bold", color: "#ef4444" }}>เรียนต่อเนื่อง {gamificationProfile.streak_count} วัน!</span>
                </div>
              )}
              <div>
                <span style={{ fontSize: "14px", color: "var(--text-secondary)" }}>EXP รวม: </span>
                <strong style={{ fontSize: "18px", color: "var(--primary)" }}>{gamificationProfile.exp} EXP</strong>
              </div>
            </div>
          </div>
          
          {/* Progress Bar Container */}
          <div style={{ 
            width: "100%", 
            height: "12px", 
            background: "rgba(255,255,255,0.05)", 
            borderRadius: "6px", 
            overflow: "hidden", 
            position: "relative",
            border: "1px solid rgba(255,255,255,0.08)"
          }}>
            {/* Progress Fill */}
            <div style={{ 
              width: `${Math.min(100, Math.max(0, ((gamificationProfile.exp % 500) / 500) * 100))}%`, 
              height: "100%", 
              background: "linear-gradient(90deg, #a855f7 0%, #3b82f6 100%)",
              boxShadow: "0 0 10px rgba(168, 85, 247, 0.5)",
              borderRadius: "6px",
              transition: "width 0.5s cubic-bezier(0.4, 0, 0.2, 1)"
            }} />
          </div>
        </div>
      )}

      {error && (
        <div className="glass-card" style={{ borderLeft: "4px solid var(--danger)", background: "rgba(239, 68, 68, 0.08)", color: "var(--danger)", padding: "16px", marginBottom: "24px" }}>
          <strong>ข้อผิดพลาด:</strong> {error}
        </div>
      )}

      {loading && courses.length === 0 ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "64px" }}>
          <div className="spinner" style={{ border: "3px solid var(--border-subtle)", borderTop: "3px solid var(--primary)", borderRadius: "50%", width: "40px", height: "40px", animation: "spin 1s linear infinite" }} />
          <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
        </div>
      ) : (
        <div>
          {/* Sub-view Navigation Menu (only shown when not in course detail view) */}
          {!selectedCourseId && (
            <>
              <div style={{ display: "flex", gap: "12px", marginBottom: "24px", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "12px" }}>
                <button
                  onClick={() => {
                    setStudentSubView("my-courses");
                    setSelectedCourseId(null);
                    setCourseDetail(null);
                    setActiveLessonId(null);
                    setVideoData(null);
                  }}
                  className={studentSubView === "my-courses" ? "tech-button-primary" : "tech-button-outline"}
                  style={{
                    borderRadius: "1rem",
                    padding: "8px 16px",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    cursor: "pointer"
                  }}
                >
                  <BookOpen size={16} />
                  พื้นที่การเรียนของฉัน
                </button>
                <button
                  onClick={() => {
                    setStudentSubView("catalog");
                    setSelectedCourseId(null);
                    setCourseDetail(null);
                    setActiveLessonId(null);
                    setVideoData(null);
                  }}
                  className={studentSubView === "catalog" ? "tech-button-primary" : "tech-button-outline"}
                  style={{
                    borderRadius: "1rem",
                    padding: "8px 16px",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    cursor: "pointer"
                  }}
                >
                  <Sparkles size={16} />
                  สำรวจคอร์ส
                </button>
                <button
                  onClick={() => {
                    setStudentSubView("internships");
                    setSelectedCourseId(null);
                    setCourseDetail(null);
                    setActiveLessonId(null);
                    setVideoData(null);
                  }}
                  className={studentSubView === "internships" ? "tech-button-primary" : "tech-button-outline"}
                  style={{
                    borderRadius: "1rem",
                    padding: "8px 16px",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    cursor: "pointer"
                  }}
                >
                  <Briefcase size={16} />
                  พอร์ทัลฝึกงาน
                </button>
                <button
                  onClick={() => {
                    setStudentSubView("freelance");
                    setSelectedCourseId(null);
                    setCourseDetail(null);
                    setActiveLessonId(null);
                    setVideoData(null);
                  }}
                  className={studentSubView === "freelance" ? "tech-button-primary" : "tech-button-outline"}
                  style={{
                    borderRadius: "1rem",
                    padding: "8px 16px",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    cursor: "pointer"
                  }}
                >
                  <Users size={16} />
                  ศูนย์งานฟรีแลนซ์
                </button>
                <button
                  onClick={() => {
                    setStudentSubView("payments");
                    setSelectedCourseId(null);
                    setCourseDetail(null);
                    setActiveLessonId(null);
                    setVideoData(null);
                  }}
                  className={studentSubView === "payments" ? "tech-button-primary" : "tech-button-outline"}
                  style={{
                    borderRadius: "1rem",
                    padding: "8px 16px",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    cursor: "pointer"
                  }}
                >
                  <Receipt size={16} />
                  การชำระเงินของฉัน
                </button>
                {(["community", "inbox"] as const).map(view => (
                  <button
                    key={view}
                    onClick={() => {
                      setStudentSubView(view);
                      setSelectedCourseId(null);
                      setCourseDetail(null);
                      setActiveLessonId(null);
                      setVideoData(null);
                    }}
                    className={studentSubView === view ? "tech-button-primary" : "tech-button-outline"}
                    style={{ borderRadius: "1rem", padding: "8px 16px", display: "inline-flex", alignItems: "center", gap: "8px", cursor: "pointer" }}
                  >
                    {view === "community" ? <Users size={16} /> : <Send size={16} />}
                    {view === "community" ? "ชุมชน" : "ข้อความ"}
                    {view === "inbox" && inboxUnread > 0 && (
                      <span aria-label={`${inboxUnread} ข้อความใหม่`} style={{ background: "var(--danger)", color: "#fff", borderRadius: "99px", fontSize: "11px", padding: "0 7px" }}>{inboxUnread}</span>
                    )}
                  </button>
                ))}
              </div>
              {studentSubView === "my-courses" && <MyAnnouncements onOpenCourse={id => selectCourse(id)} />}
              {studentSubView === "my-courses" && <MyLiveClasses />}

              {/* Render dynamic profile header (B2B Partner status vs B2C personal metrics) */}
              {api.user?.corporate_id || (api.user as any)?.partner_id ? (
                /* B2B Partner Header Card */
                <div className="glass-card" style={{ 
                  marginBottom: "24px", 
                  background: "linear-gradient(135deg, rgba(229,107,37,0.06) 0%, rgba(168,85,247,0.06) 100%)",
                  borderColor: "rgba(229, 107, 37, 0.2)"
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", flexWrap: "wrap", gap: "20px" }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                        <Building2 size={20} color="var(--primary)" />
                        <span style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--primary)", fontWeight: "700" }}>
                          บัญชีการเรียนขององค์กร
                        </span>
                      </div>
                      <h2 style={{ fontSize: "22px", color: "var(--text-primary)", marginBottom: "4px" }}>
                        {corporateInfo?.partner?.companyName || "บริษัท แอคมี จำกัด"}
                      </h2>
                      <p style={{ fontSize: "13px", color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: "6px" }}>
                        <span>เลขประจำตัวผู้เสียภาษี: {corporateInfo?.partner?.taxId || "TX-99881122"}</span>
                        <span>•</span>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                          <Users size={12} />
                          จัดสรรที่นั่งเรียบร้อยแล้ว
                        </span>
                      </p>
                    </div>

                    <div style={{ display: "flex", gap: "16px" }}>
                      <div style={{ 
                        background: "rgba(255, 255, 255, 0.6)", 
                        border: "1px solid var(--border-subtle)", 
                        borderRadius: "1rem", 
                        padding: "12px 18px", 
                        textAlign: "center" 
                      }}>
                        <p style={{ fontSize: "11px", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.02em" }}>ที่นั่งที่ใช้แล้ว</p>
                        <p style={{ fontSize: "20px", fontWeight: "700", color: "var(--primary)" }}>
                          {corporateInfo?.partner?.allocatedSeats || 0} / {corporateInfo?.partner?.totalSeats || 0}
                        </p>
                      </div>

                      <div style={{ 
                        background: "rgba(255, 255, 255, 0.6)", 
                        border: "1px solid var(--border-subtle)", 
                        borderRadius: "1rem", 
                        padding: "12px 18px", 
                        textAlign: "center" 
                      }}>
                        <p style={{ fontSize: "11px", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.02em" }}>คอร์สที่ได้รับมอบหมาย</p>
                        <p style={{ fontSize: "20px", fontWeight: "700", color: "var(--secondary)" }}>
                          {corporateInfo?.enrolledCount || 0}
                        </p>
                      </div>
                    </div>
                  </div>

                  {corporateInfo?.hrContact && (
                    <div style={{ 
                      marginTop: "16px", 
                      paddingTop: "12px", 
                      borderTop: "1px solid rgba(0,0,0,0.05)", 
                      display: "flex", 
                      alignItems: "center", 
                      justifyContent: "space-between", 
                      fontSize: "12px", 
                      color: "var(--text-secondary)",
                      flexWrap: "wrap",
                      gap: "10px"
                    }}>
                      <span>
                        👩‍💼 <strong>ผู้ประสานงานการอบรม:</strong> {corporateInfo.hrContact.name} ({corporateInfo.hrContact.email})
                      </span>
                      <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                        ติดต่อผู้ประสานงานเพื่อขอคอร์สหรือที่นั่งเพิ่ม
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                /* B2C Stats Header Card */
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px", marginBottom: "24px" }}>
                  {/* Card 1: Enrolled/Active Courses */}
                  <div className="glass-card" style={{ display: "flex", alignItems: "center", gap: "16px", padding: "16px 20px" }}>
                    <div style={{ background: "rgba(229,107,37,0.1)", borderRadius: "1rem", padding: "10px", color: "var(--primary)" }}>
                      <BookOpen size={24} />
                    </div>
                    <div>
                      <p style={{ fontSize: "12px", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.02em" }}>คอร์สที่กำลังเรียน</p>
                      <h3 style={{ fontSize: "20px", color: "var(--text-primary)" }}>{studentStats?.activeCoursesCount || 0}</h3>
                    </div>
                  </div>

                  {/* Card 2: Completed Courses */}
                  <div className="glass-card" style={{ display: "flex", alignItems: "center", gap: "16px", padding: "16px 20px" }}>
                    <div style={{ background: "rgba(16,185,129,0.1)", borderRadius: "1rem", padding: "10px", color: "var(--accent)" }}>
                      <CheckCircle size={24} />
                    </div>
                    <div>
                      <p style={{ fontSize: "12px", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.02em" }}>เรียนจบแล้ว</p>
                      <h3 style={{ fontSize: "20px", color: "var(--text-primary)" }}>{studentStats?.completedCoursesCount || 0}</h3>
                    </div>
                  </div>

                  {/* Card 3: Certificates Claimed */}
                  <div className="glass-card" style={{ display: "flex", alignItems: "center", gap: "16px", padding: "16px 20px" }}>
                    <div style={{ background: "rgba(168,85,247,0.1)", borderRadius: "1rem", padding: "10px", color: "var(--secondary)" }}>
                      <Award size={24} />
                    </div>
                    <div>
                      <p style={{ fontSize: "12px", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.02em" }}>ใบประกาศนียบัตร</p>
                      <h3 style={{ fontSize: "20px", color: "var(--text-primary)" }}>{studentStats?.certificatesCount || 0}</h3>
                    </div>
                  </div>

                  {/* Card 4: Quiz Mastery */}
                  <div className="glass-card" style={{ display: "flex", alignItems: "center", gap: "16px", padding: "16px 20px" }}>
                    <div style={{ 
                      background: studentStats?.quizAveragePercent ? "rgba(229,107,37,0.1)" : "rgba(16,185,129,0.1)", 
                      borderRadius: "1rem", 
                      padding: "10px", 
                      color: studentStats?.quizAveragePercent ? "var(--primary)" : "var(--accent)" 
                    }}>
                      {studentStats?.quizAveragePercent ? <Target size={24} /> : <DollarSign size={24} />}
                    </div>
                    <div>
                      {studentStats?.quizAveragePercent ? (
                        <>
                          <p style={{ fontSize: "12px", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.02em" }}>คะแนนแบบทดสอบเฉลี่ย</p>
                          <h3 style={{ fontSize: "20px", color: "var(--text-primary)" }}>{studentStats.quizAveragePercent}%</h3>
                        </>
                      ) : (
                        <>
                          <p style={{ fontSize: "12px", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.02em" }}>ยอดใช้จ่ายรวม</p>
                          <h3 style={{ fontSize: "20px", color: "var(--text-primary)" }}>฿{(studentStats?.totalSpent || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</h3>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          <div className="dashboard-grid">
          {/* Left Column: Video theater or catalogue details */}
          <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
            
            {/* If a course is selected */}
            <AnimatePresence mode="wait">
              {selectedCourseId && courseDetail ? (
                <motion.div 
                  key="detail"
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -15 }}
                  transition={{ duration: 0.2 }}
                  className="glass-card" 
                  style={{ position: "relative" }}
                >
                  <button 
                    onClick={() => {
                      setSelectedCourseId(null);
                      setCourseDetail(null);
                      setActiveLessonId(null);
                      setVideoData(null);
                    }}
                    className="tech-button-outline"
                    style={{ position: "absolute", top: "24px", right: "24px", padding: "6px 12px", fontSize: "12px", borderRadius: "1rem" }}
                  >
                    กลับไปรายการ
                  </button>

                  <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
                    <span className="badge-gamified">
                      คอร์สที่เลือก
                    </span>
                    {enrollment?.completed_at && (
                      <span className="badge-gamified" style={{ backgroundColor: "rgba(16,185,129,0.1)", color: "var(--accent)", borderColor: "rgba(16,185,129,0.2)", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                        <Award size={12} />
                        เรียนจบแล้ว
                      </span>
                    )}
                  </div>

                  <div style={{ height: "200px", overflow: "hidden", borderRadius: "1.5rem", marginBottom: "20px", position: "relative" }}>
                    <img 
                      src={courseDetail.cover_image_url || getFallbackCover(courseDetail.title)} 
                      alt={courseDetail.title}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                    <div style={{ position: "absolute", bottom: "16px", left: "16px", display: "flex", gap: "8px" }}>
                      <span className="badge-gamified" style={{ background: "rgba(2, 6, 23, 0.8)", backdropFilter: "blur(4px)", color: "#fff", border: "none" }}>
                        {courseDetail.price && courseDetail.price > 0 ? `฿${courseDetail.price.toFixed(2)}` : "ฟรี"}
                      </span>
                      {courseDetail.access_duration_days && (
                        <span className="badge-gamified" style={{ background: "rgba(2, 6, 23, 0.8)", backdropFilter: "blur(4px)", color: "#fff", border: "none", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                          <Clock size={12} />
                          เข้าถึงได้ {courseDetail.access_duration_days} วัน
                        </span>
                      )}
                    </div>
                  </div>

                  <h2 style={{ fontSize: "24px", color: "var(--text-primary)", maxWidth: "80%" }}>{courseDetail.title}</h2>
                  <p style={{ color: "var(--text-secondary)", fontSize: "14px", marginTop: "8px", marginBottom: "24px", lineHeight: "1.6" }}>
                    {courseDetail.description}
                  </p>

                  <CourseAnnouncements courseId={courseDetail.id} compact />
                  {enrollment && <CourseReviewForm key={`${courseDetail.id}-${enrollment.progress_percent}-${enrollment.status}`} courseId={courseDetail.id} tone="console" />}

                  {/* Tab selection menu */}
                  <div className="course-tabs" style={{ display: "flex", flexWrap: "wrap", gap: "6px 8px", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "12px", marginBottom: "24px" }}>
                    <button 
                      onClick={() => setActiveDetailTab("video")}
                      style={{ padding: "6px 12px", borderRadius: "0.5rem", background: activeDetailTab === "video" ? "var(--primary-glow)" : "none", border: "none", color: activeDetailTab === "video" ? "var(--color-brand-primary)" : "var(--text-secondary)", fontWeight: "600", cursor: "pointer" }}
                    >
                      บทเรียน
                    </button>
                    <button 
                      onClick={() => setActiveDetailTab("resources")}
                      style={{ padding: "6px 12px", borderRadius: "0.5rem", background: activeDetailTab === "resources" ? "var(--primary-glow)" : "none", border: "none", color: activeDetailTab === "resources" ? "var(--color-brand-primary)" : "var(--text-secondary)", fontWeight: "600", cursor: "pointer" }}
                    >
                      เอกสารประกอบการเรียน
                    </button>
                    <button 
                      onClick={() => {
                        setActiveDetailTab("quizzes");
                        fetchQuizzes(courseDetail.id);
                      }}
                      style={{ padding: "6px 12px", borderRadius: "0.5rem", background: activeDetailTab === "quizzes" ? "var(--primary-glow)" : "none", border: "none", color: activeDetailTab === "quizzes" ? "var(--color-brand-primary)" : "var(--text-secondary)", fontWeight: "600", cursor: "pointer" }}
                    >
                      แบบทดสอบฝึกหัด
                    </button>
                    <button 
                      onClick={() => {
                        setActiveDetailTab("notes");
                        fetchNotes(courseDetail.id);
                      }}
                      style={{ padding: "6px 12px", borderRadius: "0.5rem", background: activeDetailTab === "notes" ? "var(--primary-glow)" : "none", border: "none", color: activeDetailTab === "notes" ? "var(--color-brand-primary)" : "var(--text-secondary)", fontWeight: "600", cursor: "pointer" }}
                    >
                      บันทึกย่อ
                    </button>
                    <button 
                      onClick={() => {
                        setActiveDetailTab("qa");
                        if (activeLessonId) fetchQaThreads(activeLessonId);
                      }}
                      style={{ padding: "6px 12px", borderRadius: "0.5rem", background: activeDetailTab === "qa" ? "var(--primary-glow)" : "none", border: "none", color: activeDetailTab === "qa" ? "var(--color-brand-primary)" : "var(--text-secondary)", fontWeight: "600", cursor: "pointer" }}
                    >
                      ถามตอบ
                    </button>
                    <button 
                      onClick={() => {
                        setActiveDetailTab("ai");
                      }}
                      style={{ padding: "6px 12px", borderRadius: "0.5rem", background: activeDetailTab === "ai" ? "var(--primary-glow)" : "none", border: "none", color: activeDetailTab === "ai" ? "var(--color-brand-primary)" : "var(--text-secondary)", fontWeight: "600", cursor: "pointer" }}
                    >
                      ผู้ช่วยสอน AI
                    </button>
                    <button 
                      onClick={() => {
                        setActiveDetailTab("sandbox");
                      }}
                      style={{ padding: "6px 12px", borderRadius: "0.5rem", background: activeDetailTab === "sandbox" ? "var(--primary-glow)" : "none", border: "none", color: activeDetailTab === "sandbox" ? "var(--color-brand-primary)" : "var(--text-secondary)", fontWeight: "600", cursor: "pointer" }}
                    >
                      พื้นที่ทดลองโค้ด
                    </button>
                    <button
                      onClick={() => setActiveDetailTab("assessments")}
                      style={{ padding: "6px 12px", borderRadius: "0.5rem", background: activeDetailTab === "assessments" ? "var(--primary-glow)" : "none", border: "none", color: activeDetailTab === "assessments" ? "var(--color-brand-primary)" : "var(--text-secondary)", fontWeight: "600", cursor: "pointer" }}
                    >
                      ข้อสอบและงาน
                    </button>
                  </div>

                  {/* Tab Contents: Exams and assignments (components/assessment) */}
                  {activeDetailTab === "assessments" && (enrollment ? <LearnerAssessments courseId={courseDetail.id} lessonId={activeLessonId} /> : (
                    <div style={{ padding: "24px", textAlign: "center", color: "var(--text-muted)" }}>ลงทะเบียนเรียนคอร์สนี้ก่อนจึงจะทำข้อสอบและส่งงานได้</div>
                  ))}

                  {/* Tab Contents: Video Player */}
                  {activeDetailTab === "video" && (
                    <div>
                      {enrollment ? (
                        <div style={{ marginBottom: "24px" }}>
                          {enrollment.expires_at && new Date(enrollment.expires_at).getTime() < Date.now() ? (
                            // Expired Lock Screen
                            <div style={{ background: "rgba(229,107,37,0.04)", border: "1px dashed var(--danger)", padding: "32px", borderRadius: "1.5rem", textAlign: "center" }}>
                              <Clock size={32} color="var(--danger)" style={{ marginBottom: "16px", marginLeft: "auto", marginRight: "auto" }} />
                              <h3 style={{ color: "var(--text-primary)" }}>ระยะเวลาเข้าถึงหมดอายุแล้ว</h3>
                              <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginTop: "6px", marginBottom: "20px", maxWidth: "400px", marginLeft: "auto", marginRight: "auto" }}>
                                สิทธิ์เข้าถึงคอร์สนี้หมดอายุเมื่อ <strong>{formatDate(enrollment.expires_at)}</strong>
                              </p>
                              <button 
                                onClick={() => startEnrollmentFlow(courseDetail)}
                                className="tech-button-primary"
                                style={{ borderRadius: "1rem" }}
                              >
                                ซื้อ/ต่ออายุสิทธิ์เข้าถึง
                              </button>
                            </div>
                          ) : activeLessonMeta && (activeLessonMeta.locked || (activeLessonMeta.type && activeLessonMeta.type !== "video")) ? (
                            <LessonContentView lesson={activeLessonMeta} onCompleted={() => selectedCourseId && refreshCurriculum(selectedCourseId)} />
                          ) : videoLoading ? (
                            <div style={{ width: "100%", aspectRatio: "16/9", background: "#05070f", border: "1px solid var(--border-subtle)", borderRadius: "1.5rem", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: "12px" }}>
                              <div className="spinner" style={{ border: "2px solid rgba(255,255,255,0.05)", borderTop: "2px solid var(--primary)", borderRadius: "50%", width: "32px", height: "32px", animation: "spin 1s linear infinite" }} />
                              <span style={{ fontSize: "12px", color: "#94a3b8" }}>กำลังสร้างโทเค็นสำหรับสตรีมวิดีโอแบบปลอดภัย...</span>
                            </div>
                          ) : videoData ? (
                            <InteractiveVideo lessonId={videoData.lessonId}>
                            <VideoPlayer
                              lessonId={videoData.lessonId}
                              lessonTitle={videoData.title}
                              signedUrl={videoData.signedUrl}
                              isMock={videoData.isMock}
                              videoProvider={videoData.videoProvider}
                              videoStreamUid={videoData.videoStreamUid}
                              onProgress={handleProgressUpdate}
                              onComplete={handleVideoCompleted}
                              initialTime={playbackResumeSeconds}
                              onTimeUpdate={handleTimeProgressUpdate}
                            />
                            </InteractiveVideo>
                          ) : (
                            <div style={{ width: "100%", aspectRatio: "16/9", background: "#05070f", border: "1px solid var(--border-subtle)", borderRadius: "1.5rem", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", padding: "32px" }}>
                              <PlayCircle size={48} color="#94a3b8" />
                              <h4 style={{ marginTop: "16px", color: "#ffffff" }}>พร้อมเรียนหรือยัง?</h4>
                              <p style={{ fontSize: "12px", color: "#94a3b8", marginTop: "4px", textAlign: "center" }}>
                                เลือกบทเรียนจากสารบัญด้านขวาเพื่อเริ่มดู
                              </p>
                            </div>
                          )}
                        </div>
                      ) : (
                        // Locked/Enrolled Card Block
                        <div style={{ background: "rgba(0,0,0,0.02)", border: "1px dashed var(--border-active)", padding: "32px", borderRadius: "1.5rem", textAlign: "center", marginBottom: "24px" }}>
                          <Lock size={32} color="var(--secondary)" style={{ marginBottom: "16px", marginLeft: "auto", marginRight: "auto" }} />
                          <h3 style={{ color: "var(--text-primary)" }}>คุณยังไม่ได้ลงทะเบียนเรียนคอร์สนี้</h3>
                          <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginTop: "6px", marginBottom: "20px", maxWidth: "400px", marginLeft: "auto", marginRight: "auto" }}>
                            ลงทะเบียนเรียนเพื่อปลดล็อกวิดีโอสตรีมมิงแบบปลอดภัยผ่าน Cloudflare เอกสารประกอบการเรียน และติดตามความคืบหน้าของคุณ
                          </p>
                          <button 
                            onClick={() => startEnrollmentFlow(courseDetail)}
                            disabled={actionLoading}
                            className="tech-button-primary"
                            style={{ borderRadius: "1rem" }}
                          >
                            {actionLoading ? "กำลังลงทะเบียน..." : courseDetail.price && courseDetail.price > 0 && !courseSponsored ? "ซื้อคอร์ส" : "ลงทะเบียนเรียนและปลดล็อกคอร์ส"}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {activeDetailTab === "video" && enrollment && activeLessonId && <LessonAiSummary lessonId={activeLessonId} />}

                  {/* Tab Contents: Resources */}
                  {activeDetailTab === "resources" && (
                    <div style={{ paddingTop: "12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
                        <FileText size={18} color="var(--primary)" />
                        <h4 style={{ fontSize: "16px", color: "var(--text-primary)" }}>ศูนย์เอกสารประกอบการเรียน (Cloudflare R2)</h4>
                      </div>
                      
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                        {lessons.filter(l => l.handout_r2_key || l.has_handout).map((lesson) => {
                          const filename = lesson.handout_name || lesson.handout_r2_key?.split("/").pop() || "Handout.pdf";
                          return (
                            <div key={lesson.id} className="glass-card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", background: "rgba(255,255,255,0.3)", borderRadius: "1rem" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                <Download size={16} color="var(--text-secondary)" />
                                <div>
                                  <p style={{ fontSize: "13px", fontWeight: "500", color: "var(--text-primary)" }}>{filename}</p>
                                  <p style={{ fontSize: "10px", color: "var(--text-muted)" }}>{lesson.title} • พื้นที่จัดเก็บ R2</p>
                                </div>
                              </div>
                              <button 
                                className="tech-button-outline" 
                                style={{ padding: "4px 8px", fontSize: "11px", borderRadius: "1rem", cursor: "pointer" }} 
                                onClick={() => handleDownloadHandout(lesson.id, filename)}
                              >
                                ดาวน์โหลดไฟล์
                              </button>
                            </div>
                          );
                        })}
                        {lessons.filter(l => l.handout_r2_key || l.has_handout).length === 0 && (
                          <div style={{ gridColumn: "span 2", padding: "24px", textAlign: "center", color: "var(--text-muted)", background: "rgba(0,0,0,0.01)", border: "1px dashed var(--border-subtle)", borderRadius: "1rem" }}>
                            ยังไม่มีเอกสารประกอบการเรียนแนบในบทเรียนของคอร์สนี้
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Tab Contents: Quizzes */}
                  {activeDetailTab === "quizzes" && (
                    <div style={{ paddingTop: "12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
                        <FileText size={18} color="var(--primary)" />
                        <h4 style={{ fontSize: "16px", color: "var(--text-primary)" }}>แบบทดสอบฝึกหัด</h4>
                      </div>

                      {!enrollment ? (
                        <div style={{ background: "rgba(0,0,0,0.02)", border: "1px dashed var(--border-active)", padding: "32px", borderRadius: "1.5rem", textAlign: "center" }}>
                          <Lock size={32} color="var(--secondary)" style={{ marginBottom: "16px", marginLeft: "auto", marginRight: "auto" }} />
                          <h3 style={{ color: "var(--text-primary)" }}>แบบทดสอบถูกล็อก</h3>
                          <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginTop: "6px", marginBottom: "20px" }}>
                            คุณต้องลงทะเบียนเรียนคอร์สนี้ก่อนจึงจะทำแบบทดสอบได้
                          </p>
                          <button 
                            onClick={() => startEnrollmentFlow(courseDetail)}
                            disabled={actionLoading}
                            className="tech-button-primary"
                            style={{ borderRadius: "1rem" }}
                          >
                            {actionLoading ? "กำลังลงทะเบียน..." : courseDetail.price && courseDetail.price > 0 && !courseSponsored ? "ซื้อคอร์ส" : "ลงทะเบียนเรียน"}
                          </button>
                        </div>
                      ) : quizzesLoading ? (
                        <div style={{ display: "flex", justifyContent: "center", padding: "32px" }}>
                          <div className="spinner" style={{ border: "2px solid var(--border-subtle)", borderTop: "2px solid var(--primary)", borderRadius: "50%", width: "32px", height: "32px", animation: "spin 1s linear infinite" }} />
                        </div>
                      ) : quizzes.length === 0 ? (
                        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)", background: "rgba(0,0,0,0.01)", border: "1px dashed var(--border-subtle)", borderRadius: "1rem" }}>
                          คอร์สนี้ยังไม่มีแบบทดสอบ
                        </div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                          {quizzes.map((quiz, qIdx) => {
                            const selectedAns = selectedAnswers[quiz.id];
                            const result = quizResults[quiz.id];
                            const isSubmitted = !!result;

                            return (
                              <div 
                                key={quiz.id} 
                                className="glass-card" 
                                style={{ 
                                  padding: "20px", 
                                  borderRadius: "1rem",
                                  borderLeft: isSubmitted 
                                    ? (result.correct ? "4px solid var(--accent)" : "4px solid var(--danger)") 
                                    : "4px solid var(--border-active)",
                                  background: "rgba(255,255,255,0.4)"
                                }}
                              >
                                <p style={{ fontSize: "10px", color: "var(--text-muted)", textTransform: "uppercase", fontWeight: "700" }}>
                                  ข้อที่ {qIdx + 1} • {quiz.lessonTitle}
                                </p>
                                <h4 style={{ fontSize: "14px", color: "var(--text-primary)", marginTop: "6px", marginBottom: "16px", fontWeight: "700" }}>
                                  {quiz.question}
                                </h4>

                                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                  {quiz.options.map((opt: string, optIdx: number) => {
                                    const isSelected = selectedAns === optIdx;
                                    const isCorrectOption = isSubmitted && isSelected && result.correct;
                                    const isIncorrectSelection = isSubmitted && isSelected && !result.correct;

                                    let btnBg = "rgba(255, 255, 255, 0.4)";
                                    let btnBorder = "1px solid var(--border-subtle)";
                                    let btnColor = "var(--text-primary)";

                                    if (isSelected && !isSubmitted) {
                                      btnBg = "var(--primary-glow)";
                                      btnBorder = "1px solid var(--primary)";
                                      btnColor = "var(--color-brand-primary)";
                                    } else if (isSubmitted) {
                                      if (isCorrectOption) {
                                        btnBg = "rgba(16, 185, 129, 0.1)";
                                        btnBorder = "1px solid var(--accent)";
                                        btnColor = "var(--accent)";
                                      } else if (isIncorrectSelection) {
                                        btnBg = "rgba(239, 68, 68, 0.1)";
                                        btnBorder = "1px solid var(--danger)";
                                        btnColor = "var(--danger)";
                                      } else {
                                        btnBg = "rgba(0, 0, 0, 0.01)";
                                        btnBorder = "1px solid var(--border-subtle)";
                                        btnColor = "var(--text-muted)";
                                      }
                                    }

                                    return (
                                      <button
                                        key={optIdx}
                                        type="button"
                                        disabled={isSubmitted}
                                        onClick={() => setSelectedAnswers(prev => ({ ...prev, [quiz.id]: optIdx }))}
                                        style={{
                                          width: "100%",
                                          textAlign: "left",
                                          padding: "10px 14px",
                                          background: btnBg,
                                          border: btnBorder,
                                          borderRadius: "0.75rem",
                                          color: btnColor,
                                          fontSize: "13px",
                                          fontWeight: isSelected || isCorrectOption ? "600" : "500",
                                          cursor: isSubmitted ? "default" : "pointer",
                                          transition: "all 0.15s ease"
                                        }}
                                      >
                                        <div style={{ display: "flex", gap: "8px" }}>
                                          <span style={{ opacity: 0.6 }}>{String.fromCharCode(65 + optIdx)}.</span>
                                          <span>{opt}</span>
                                        </div>
                                      </button>
                                    );
                                  })}
                                </div>

                                <div style={{ marginTop: "14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                  <div>
                                    {isSubmitted && (
                                      <span style={{ 
                                        fontSize: "12px", 
                                        fontWeight: "700", 
                                        color: result.correct ? "var(--accent)" : "var(--danger)",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "4px"
                                      }}>
                                        {result.correct ? "✓ ตอบถูก" : "✗ ตอบไม่ถูก ทบทวนบทเรียนแล้วลองอีกครั้ง"}
                                      </span>
                                    )}
                                  </div>

                                  {!isSubmitted && (
                                    <button
                                      type="button"
                                      disabled={selectedAns === undefined || submittingQuizId === quiz.id}
                                      onClick={() => handleQuizSubmit(quiz.id, selectedAns)}
                                      className="tech-button-primary"
                                      style={{ padding: "6px 12px", fontSize: "11px", borderRadius: "0.75rem" }}
                                    >
                                      {submittingQuizId === quiz.id ? "กำลังตรวจ..." : "ส่งคำตอบ"}
                                    </button>
                                  )}
                                  {isSubmitted && !result.correct && (
                                    <button type="button" className="tech-button-outline"
                                      onClick={() => {
                                        setQuizResults(prev => { const next = { ...prev }; delete next[quiz.id]; return next; });
                                        setSelectedAnswers(prev => { const next = { ...prev }; delete next[quiz.id]; return next; });
                                      }}>
                                      ลองอีกครั้ง
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Quizzes attempts list */}
                      {enrollment && (
                        <div style={{ marginTop: "32px", borderTop: "1px solid var(--border-subtle)", paddingTop: "24px" }}>
                          <h4 style={{ fontSize: "14px", color: "var(--text-primary)", marginBottom: "12px", display: "flex", alignItems: "center", gap: "8px", fontWeight: "700" }}>
                            <Award size={16} color="var(--primary)" />
                            ประวัติการทำแบบทดสอบ
                          </h4>
                          {quizAttempts.length === 0 ? (
                            <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                              ยังไม่มีประวัติการทำแบบทดสอบ ตอบคำถามด้านบนเพื่อติดตามคะแนนของคุณ
                            </p>
                          ) : (
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                              {quizAttempts.map((attempt) => (
                                <div key={attempt.id} className="glass-card" style={{ padding: "12px 16px", background: "rgba(255,255,255,0.2)", borderRadius: "1rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                  <div>
                                    <p style={{ fontSize: "12px", fontWeight: "600", color: "var(--text-primary)" }}>{attempt.lesson_title}</p>
                                    <p style={{ fontSize: "10px", color: "var(--text-muted)", marginTop: "2px" }}>{formatDate(attempt.submitted_at)}</p>
                                  </div>
                                  <div style={{ textAlign: "right" }}>
                                    <span className="badge-gamified" style={{ 
                                      backgroundColor: attempt.score > 0 ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)", 
                                      color: attempt.score > 0 ? "var(--accent)" : "var(--danger)",
                                      borderColor: attempt.score > 0 ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)"
                                    }}>
                                      คะแนน: {attempt.score}/{attempt.total_questions}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Tab Contents: Notes */}
                  {activeDetailTab === "notes" && (
                    <div style={{ paddingTop: "12px" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <BookOpen size={18} color="var(--primary)" />
                          <h4 style={{ fontSize: "16px", color: "var(--text-primary)" }}>บันทึกย่อและบุ๊กมาร์กของฉัน</h4>
                        </div>
                        <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                          เวลาปัจจุบันของวิดีโอ: <span style={{ fontFamily: "monospace", fontWeight: "600", color: "var(--primary)" }}>{formatTime(currentVideoSeconds)}</span>
                        </span>
                      </div>

                      {/* Note creation form */}
                      <form onSubmit={handleSaveNote} style={{ marginBottom: "24px" }}>
                        <div style={{ display: "flex", gap: "12px", alignItems: "end" }}>
                          <div style={{ flexGrow: 1 }}>
                            <textarea
                              className="form-input"
                              placeholder="จดบันทึกช่วงนี้ของบทเรียน... (เช่น 'อธิบายการออกแบบสคีมา D1 ได้ดี')"
                              value={noteContent}
                              onChange={(e) => setNoteContent(e.target.value)}
                              rows={2}
                              style={{ width: "100%", padding: "10px 14px", borderRadius: "0.75rem", fontSize: "13px", resize: "none" }}
                            />
                          </div>
                          <button
                            type="submit"
                            disabled={!noteContent.trim() || !activeLessonId}
                            className="tech-button-primary"
                            style={{ padding: "10px 18px", borderRadius: "0.75rem", height: "fit-content", flexShrink: 0, fontSize: "13px" }}
                          >
                            เพิ่มบันทึกที่ {formatTime(currentVideoSeconds)}
                          </button>
                        </div>
                      </form>

                      {/* Notes list */}
                      {notesLoading ? (
                        <div style={{ display: "flex", justifyContent: "center", padding: "24px" }}>
                          <div className="spinner" style={{ border: "2px solid var(--border-subtle)", borderTop: "2px solid var(--primary)", borderRadius: "50%", width: "24px", height: "24px", animation: "spin 1s linear infinite" }} />
                        </div>
                      ) : notes.length === 0 ? (
                        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)", background: "rgba(0,0,0,0.01)", border: "1px dashed var(--border-subtle)", borderRadius: "1rem" }}>
                          คอร์สนี้ยังไม่มีบันทึกย่อ จดบันทึกตามช่วงเวลาเพื่อสร้างสรุปการเรียนของคุณ
                        </div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                          {notes.map((note) => (
                            <div key={note.id} className="glass-card" style={{ padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "start", background: "rgba(255, 255, 255, 0.4)", borderRadius: "1rem" }}>
                              <div style={{ display: "flex", flexDirection: "column", gap: "6px", flexGrow: 1 }}>
                                <p style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                                  บทเรียน: {note.lesson_title}
                                </p>
                                <p style={{ fontSize: "13px", color: "var(--text-primary)", lineHeight: "1.5" }}>
                                  {note.content}
                                </p>
                                <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "4px" }}>
                                  <button
                                    onClick={() => handleNoteSeek(note.timestamp_seconds)}
                                    className="tech-button-outline"
                                    style={{ padding: "4px 8px", fontSize: "11px", borderRadius: "0.5rem", display: "inline-flex", alignItems: "center", gap: "4px" }}
                                  >
                                    <Clock size={10} />
                                    ข้ามไปที่ {formatTime(note.timestamp_seconds)}
                                  </button>
                                  <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>
                                    สร้างเมื่อ: {formatDate(note.created_at)}
                                  </span>
                                </div>
                              </div>
                              <button
                                onClick={() => handleDeleteNote(note.id)}
                                style={{ background: "none", border: "none", color: "var(--danger)", opacity: 0.6, cursor: "pointer", padding: "4px" }}
                                title="ลบบันทึกย่อ"
                              >
                                <X size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Tab Contents: Q&A Discussion Forum */}
                  {activeDetailTab === "qa" && (
                    <div style={{ paddingTop: "12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
                        <BookOpen size={18} color="var(--primary)" />
                        <h4 style={{ fontSize: "16px", color: "var(--text-primary)" }}>กระดานถามตอบของบทเรียน</h4>
                      </div>

                      {/* Ask new question form */}
                      <form onSubmit={handlePostQuestion} style={{ marginBottom: "24px" }}>
                        <div style={{ display: "flex", gap: "12px", alignItems: "end" }}>
                          <div style={{ flexGrow: 1 }}>
                            <textarea
                              className="form-input"
                              placeholder="ถามคำถามเกี่ยวกับบทเรียนนี้... (ผู้สอนและผู้เรียนคนอื่นสามารถตอบได้)"
                              value={newQuestionContent}
                              onChange={(e) => setNewQuestionContent(e.target.value)}
                              rows={2}
                              style={{ width: "100%", padding: "10px 14px", borderRadius: "0.75rem", fontSize: "13px", resize: "none" }}
                            />
                          </div>
                          <button
                            type="submit"
                            disabled={!newQuestionContent.trim() || !activeLessonId}
                            className="tech-button-primary"
                            style={{ padding: "10px 18px", borderRadius: "0.75rem", height: "fit-content", flexShrink: 0, fontSize: "13px" }}
                          >
                            โพสต์คำถาม
                          </button>
                        </div>
                      </form>

                      {/* Q&A threads list */}
                      {qaLoading ? (
                        <div style={{ display: "flex", justifyContent: "center", padding: "24px" }}>
                          <div className="spinner" style={{ border: "2px solid var(--border-subtle)", borderTop: "2px solid var(--primary)", borderRadius: "50%", width: "24px", height: "24px", animation: "spin 1s linear infinite" }} />
                        </div>
                      ) : qaThreads.length === 0 ? (
                        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)", background: "rgba(0,0,0,0.01)", border: "1px dashed var(--border-subtle)", borderRadius: "1rem" }}>
                          บทเรียนนี้ยังไม่มีคำถาม มาตั้งคำถามเป็นคนแรกกันเลย!
                        </div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                          {qaThreads.map((thread) => (
                            <div key={thread.id} className="glass-card" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px", background: "rgba(255, 255, 255, 0.45)", borderRadius: "1rem", border: "1px solid var(--border-subtle)" }}>
                              
                              {/* Question Author info & Actions */}
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                                  <div style={{ 
                                    width: "36px", 
                                    height: "36px", 
                                    borderRadius: "50%", 
                                    background: thread.user_role === "instructor" || thread.user_role === "admin" ? "var(--primary-glow)" : "rgba(0,0,0,0.05)",
                                    color: thread.user_role === "instructor" || thread.user_role === "admin" ? "var(--primary)" : "var(--text-secondary)",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontWeight: "600",
                                    fontSize: "14px"
                                  }}>
                                    {thread.user_name?.substring(0, 2).toUpperCase()}
                                  </div>
                                  <div>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                      <span style={{ fontSize: "13px", fontWeight: "600", color: "var(--text-primary)" }}>{thread.user_name}</span>
                                      {(thread.user_role === "instructor" || thread.user_role === "admin") && (
                                        <span style={{ fontSize: "9px", background: "var(--primary-glow)", color: "var(--primary)", padding: "2px 6px", borderRadius: "99px", fontWeight: "700" }}>ทีมงาน</span>
                                      )}
                                    </div>
                                    <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>{new Date(thread.created_at).toLocaleString("th-TH")}</span>
                                  </div>
                                </div>

                                {(thread.user_id === api.user?.id || hasRole(api.user, "instructor", "admin")) && (
                                  <button
                                    onClick={() => handleDeleteQaPost(thread.id, null)}
                                    style={{ background: "none", border: "none", color: "var(--danger)", opacity: 0.6, cursor: "pointer", padding: "4px" }}
                                    title="ลบคำถาม"
                                  >
                                    <X size={14} />
                                  </button>
                                )}
                              </div>

                              {/* Question content */}
                              <p style={{ fontSize: "14px", color: "var(--text-primary)", lineHeight: "1.6", whiteSpace: "pre-wrap" }}>
                                {thread.content}
                              </p>

                              {/* Replies section */}
                              <div style={{ borderLeft: "2px solid var(--border-subtle)", paddingLeft: "16px", display: "flex", flexDirection: "column", gap: "12px", marginLeft: "8px" }}>
                                {thread.replies && thread.replies.map((reply: any) => (
                                  <div key={reply.id} style={{ display: "flex", flexDirection: "column", gap: "8px", background: "rgba(255, 255, 255, 0.2)", padding: "12px 16px", borderRadius: "0.75rem" }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
                                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                        <span style={{ fontSize: "12px", fontWeight: "600", color: "var(--text-primary)" }}>{reply.user_name}</span>
                                        {(reply.user_role === "instructor" || reply.user_role === "admin") && (
                                          <span style={{ fontSize: "9px", background: "var(--primary-glow)", color: "var(--primary)", padding: "1px 5px", borderRadius: "99px", fontWeight: "700" }}>ทีมงาน</span>
                                        )}
                                        <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>• {new Date(reply.created_at).toLocaleString("th-TH")}</span>
                                      </div>

                                      {(reply.user_id === api.user?.id || reply.user_role === "instructor" || reply.user_role === "admin") && (
                                        <button
                                          onClick={() => handleDeleteQaPost(reply.id, thread.id)}
                                          style={{ background: "none", border: "none", color: "var(--danger)", opacity: 0.5, cursor: "pointer", padding: "2px" }}
                                          title="ลบการตอบกลับ"
                                        >
                                          <X size={12} />
                                        </button>
                                      )}
                                    </div>
                                    <p style={{ fontSize: "13px", color: "var(--text-primary)", lineHeight: "1.5", whiteSpace: "pre-wrap" }}>
                                      {reply.content}
                                    </p>
                                  </div>
                                ))}

                                {/* Reply composer */}
                                <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
                                  <input
                                    type="text"
                                    placeholder="เขียนตอบกลับ..."
                                    value={replyContents[thread.id] || ""}
                                    onChange={(e) => setReplyContents(prev => ({ ...prev, [thread.id]: e.target.value }))}
                                    style={{
                                      flexGrow: 1,
                                      padding: "8px 12px",
                                      borderRadius: "0.5rem",
                                      border: "1px solid var(--border-subtle)",
                                      fontSize: "12px",
                                      backgroundColor: "rgba(255,255,255,0.7)",
                                      color: "var(--text-primary)"
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" && (replyContents[thread.id] || "").trim()) {
                                        handlePostReply(thread.id);
                                      }
                                    }}
                                  />
                                  <button
                                    onClick={() => handlePostReply(thread.id)}
                                    disabled={!(replyContents[thread.id] || "").trim()}
                                    className="tech-button-outline"
                                    style={{ padding: "6px 12px", borderRadius: "0.5rem", fontSize: "12px" }}
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
                  )}

                  {/* Tab Contents: AI Tutor */}
                  {activeDetailTab === "ai" && (
                    <div style={{ paddingTop: "12px", display: "flex", flexDirection: "column", gap: "16px", height: "450px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Sparkles size={18} color="var(--primary)" />
                        <h4 style={{ fontSize: "16px", color: "var(--text-primary)" }}>ผู้ช่วยสอน AI</h4>
                      </div>

                      {/* Chat Messages Log */}
                      <div style={{ 
                        flexGrow: 1, 
                        overflowY: "auto", 
                        background: "rgba(255,255,255,0.02)", 
                        border: "1px solid var(--border-subtle)", 
                        borderRadius: "1rem", 
                        padding: "16px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "12px"
                      }}>
                        {aiChatHistory.length === 0 ? (
                          <div style={{ margin: "auto", textAlign: "center", color: "var(--text-secondary)", maxWidth: "280px" }}>
                            <p style={{ fontSize: "13px", fontWeight: "bold" }}>สวัสดี! ฉันคือผู้ช่วยสอน AI ของคุณ</p>
                            <p style={{ fontSize: "11px", marginTop: "4px" }}>ถามอะไรก็ได้เกี่ยวกับบทเรียนนี้หรือแนวคิดทั่วไป แล้วฉันจะอธิบายให้ทันที</p>
                          </div>
                        ) : (
                          aiChatHistory.map((msg, idx) => (
                            <div key={idx} style={{
                              alignSelf: msg.sender === "user" ? "flex-end" : "flex-start",
                              background: msg.sender === "user" ? "var(--primary-glow)" : "rgba(255, 255, 255, 0.05)",
                              color: "var(--text-primary)",
                              padding: "10px 14px",
                              borderRadius: msg.sender === "user" ? "1rem 1rem 0 1rem" : "1rem 1rem 1rem 0",
                              maxWidth: "80%",
                              fontSize: "13px",
                              border: msg.sender === "user" ? "1px solid rgba(168,85,247,0.3)" : "1px solid rgba(255,255,255,0.05)",
                              whiteSpace: "pre-wrap"
                            }}>
                              <strong>{msg.sender === "user" ? "คุณ" : "ผู้ช่วยสอน AI"}:</strong>
                              <div style={{ marginTop: "4px" }}>{msg.text}</div>
                            </div>
                          ))
                        )}
                        {aiLoading && (
                          <div style={{ alignSelf: "flex-start", color: "var(--text-secondary)", fontSize: "11px", display: "flex", alignItems: "center", gap: "6px" }}>
                            <div className="spinner" style={{ border: "2px solid var(--border-subtle)", borderTop: "2px solid var(--primary)", borderRadius: "50%", width: "12px", height: "12px", animation: "spin 1s linear infinite" }} />
                            AI กำลังคิด...
                          </div>
                        )}
                      </div>

                      {/* Chat Input form */}
                      <div style={{ display: "flex", gap: "10px" }}>
                        <input
                          type="text"
                          className="form-input"
                          placeholder="พิมพ์คำถาม..."
                          value={aiMessage}
                          onChange={(e) => setAiMessage(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleSendAiMessage();
                          }}
                          style={{ flexGrow: 1, padding: "10px 14px", borderRadius: "0.75rem", fontSize: "13px" }}
                        />
                        <button
                          onClick={handleSendAiMessage}
                          disabled={aiLoading || !aiMessage.trim()}
                          className="tech-button-primary"
                          style={{ padding: "10px 18px", borderRadius: "0.75rem", fontSize: "13px" }}
                        >
                          ส่ง
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Tab Contents: Code Sandbox */}
                  {activeDetailTab === "sandbox" && (
                    <div style={{ paddingTop: "12px", display: "flex", flexDirection: "column", gap: "16px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <Terminal size={18} color="var(--primary)" />
                          <h4 style={{ fontSize: "16px", color: "var(--text-primary)" }}>พื้นที่ทดลองโค้ด Netprime</h4>
                        </div>
                        {sandboxChallengeCompleted ? (
                          <span style={{ fontSize: "11px", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.2)", color: "#22c55e", padding: "4px 12px", borderRadius: "2rem", fontWeight: "700" }}>
                            ผ่านความท้าทายแล้ว! ได้รับ +100 EXP
                          </span>
                        ) : (
                          <span style={{ fontSize: "11px", background: "rgba(229,107,37,0.12)", border: "1px solid rgba(229,107,37,0.2)", color: "var(--primary)", padding: "4px 12px", borderRadius: "2rem", fontWeight: "700" }}>
                            ความท้าทายปัจจุบัน: เขียนฟังก์ชัน calculateExp
                          </span>
                        )}
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: "20px" }} className="internship-grid-responsive">
                        {/* Code Editor Panel */}
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                          <span style={{ fontSize: "11px", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "1px" }}>ตัวแก้ไขโค้ด</span>
                          <textarea
                            value={sandboxCode}
                            onChange={(e) => setSandboxCode(e.target.value)}
                            style={{
                              width: "100%",
                              height: "300px",
                              fontFamily: "monospace",
                              fontSize: "13px",
                              background: "#0d0a1a",
                              color: "#c0caf5",
                              border: "1px solid var(--border-subtle)",
                              borderRadius: "12px",
                              padding: "16px",
                              resize: "none",
                              outline: "none",
                              lineHeight: "1.5"
                            }}
                          />
                          <button
                            onClick={handleRunCode}
                            className="tech-button-primary"
                            style={{ width: "100%", justifyContent: "center", borderRadius: "0.75rem", padding: "12px" }}
                          >
                            <Terminal size={16} /> รันโค้ดและทดสอบความท้าทาย
                          </button>
                        </div>

                        {/* Compiler Console Output Panel */}
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                          <span style={{ fontSize: "11px", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "1px" }}>คอนโซลแสดงผล</span>
                          <div style={{
                            width: "100%",
                            height: "300px",
                            fontFamily: "monospace",
                            fontSize: "12px",
                            background: "#070510",
                            color: "#4ade80",
                            border: "1px solid var(--border-subtle)",
                            borderRadius: "12px",
                            padding: "16px",
                            overflowY: "auto",
                            display: "flex",
                            flexDirection: "column",
                            gap: "6px"
                          }}>
                            {sandboxConsole.length === 0 ? (
                              <span style={{ color: "var(--text-muted)" }}>คอนโซลว่าง รันโค้ดเพื่อดูผลลัพธ์ที่นี่</span>
                            ) : (
                              sandboxConsole.map((line, idx) => (
                                <div key={idx} style={{ 
                                  color: line.startsWith("[ข้อผิดพลาด]") ? "#ef4444" : line.startsWith("[ผ่านความท้าทาย]") ? "#22c55e" : line.startsWith("[ระบบ]") ? "var(--primary)" : "#4ade80",
                                  whiteSpace: "pre-wrap"
                                }}>
                                  {line}
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                </motion.div>
              ) : (
                // Course Catalogue View
                <motion.div
                  key="list"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  {(() => {
                    if (studentSubView === "internships") {
                      return renderInternshipPortal();
                    }
                    if (studentSubView === "freelance") {
                      return renderFreelancePortal();
                    }
                    if (studentSubView === "payments") {
                      return <MyPayments />;
                    }
                    if (studentSubView === "community") {
                      return <CommunityPage initialPostId={new URLSearchParams(window.location.search).get("community") ?? undefined} />;
                    }
                    if (studentSubView === "inbox") {
                      return <Inbox initialThreadId={new URLSearchParams(window.location.search).get("inbox") ?? undefined} />;
                    }
                    const displayedCourses = studentSubView === "my-courses"
                      ? courses.filter(c => c.progress_percent !== null)
                      : courses.filter(c => !catalogCategory || c.category_id === catalogCategory);

                    if (studentSubView === "my-courses" && displayedCourses.length === 0) {
                      return (
                        <div className="glass-card" style={{ 
                          padding: "48px 32px", 
                          textAlign: "center", 
                          display: "flex", 
                          flexDirection: "column", 
                          alignItems: "center", 
                          gap: "16px" 
                        }}>
                          <div style={{ background: "var(--primary-glow)", color: "var(--primary)", padding: "16px", borderRadius: "2rem" }}>
                            <BookOpen size={48} />
                          </div>
                          <div>
                            <h3 style={{ fontSize: "18px", color: "var(--text-primary)", marginBottom: "6px" }}>ยินดีต้อนรับสู่ Netprime LMS!</h3>
                            <p style={{ fontSize: "14px", color: "var(--text-secondary)", maxWidth: "450px", margin: "0 auto", lineHeight: "1.5" }}>
                              คุณยังไม่ได้ลงทะเบียนเรียนคอร์สใด ไปที่แท็บ สำรวจคอร์ส เพื่อค้นพบคอร์สด้านการพัฒนาแบบ serverless เครือข่ายองค์กร และสถาปัตยกรรมคลาวด์
                            </p>
                          </div>
                          <button 
                            onClick={() => setStudentSubView("catalog")}
                            className="tech-button-primary"
                            style={{ borderRadius: "1rem", padding: "10px 24px", display: "inline-flex", alignItems: "center", gap: "8px", cursor: "pointer" }}
                          >
                            <Sparkles size={16} />
                            สำรวจคอร์ส
                            <ChevronRight size={16} />
                          </button>
                        </div>
                      );
                    }

                    return (
                      <>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "20px" }}>
                          {studentSubView === "my-courses" ? (
                            <>
                              <BookOpen size={20} color="var(--primary)" />
                              <h2 style={{ fontSize: "20px", color: "var(--text-primary)" }}>คอร์สที่ลงทะเบียนเรียน</h2>
                            </>
                          ) : (
                            <>
                              <Sparkles size={20} color="var(--primary)" />
                              <h2 style={{ fontSize: "20px", color: "var(--text-primary)" }}>สำรวจคอร์สทั้งหมด</h2>
                            </>
                          )}
                        </div>
                        {studentSubView === "catalog" && <CategoryFilter value={catalogCategory} onChange={setCatalogCategory} />}
                        
                        <div className="courses-grid">
                          {displayedCourses.map((course) => {
                            const isEnrolled = course.progress_percent !== null;
                            const isExpired = course.expires_at ? new Date(course.expires_at).getTime() < Date.now() : false;
                            const cover = course.cover_image_url || getFallbackCover(course.title);
                            
                            return (
                              <div key={course.id} className="glass-card" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                                {/* Course Thumbnail */}
                                <div style={{ height: "160px", margin: "-24px -24px 20px -24px", overflow: "hidden", borderRadius: "1.5rem 1.5rem 0 0", position: "relative" }}>
                                  <img 
                                    src={cover} 
                                    alt={course.title}
                                    style={{ width: "100%", height: "100%", objectFit: "cover", transition: "transform 0.5s" }}
                                  />
                                  {isEnrolled && (
                                    <div className="badge-gamified" style={{ position: "absolute", top: "12px", right: "12px", textTransform: "none", fontSize: "10px", backgroundColor: isExpired ? "rgba(239,68,68,0.9)" : "rgba(229,107,37,0.9)", color: "#fff", borderColor: "transparent" }}>
                                      {isExpired ? "หมดอายุ" : "ลงทะเบียนแล้ว"}
                                    </div>
                                  )}
                                </div>

                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                                  <span className="badge-gamified" style={{ background: "rgba(229,107,37,0.08)", color: "var(--primary)" }}>
                                    {course.price && course.price > 0 ? `฿${course.price.toFixed(2)}` : "ฟรี"}
                                  </span>
                                  {course.access_duration_days && (
                                    <span style={{ fontSize: "11px", color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: "4px" }}>
                                      <Clock size={12} />
                                      เข้าถึงได้ {course.access_duration_days} วัน
                                    </span>
                                  )}
                                </div>

                                <h3 style={{ fontSize: "18px", color: "var(--text-primary)", marginBottom: "8px" }}>{course.title}</h3>
                                
                                <p style={{ color: "var(--text-secondary)", fontSize: "13px", marginBottom: "20px", flexGrow: 1, lineClamp: 3, WebkitLineClamp: 3, display: "-webkit-box", WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                                  {course.description}
                                </p>

                                {isEnrolled && !isExpired ? (
                                  <div style={{ width: "100%" }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "var(--text-secondary)", marginBottom: "6px" }}>
                                      <span>ความคืบหน้า</span>
                                      <span style={{ color: "var(--primary)", fontWeight: "600" }}>{course.progress_percent}%</span>
                                    </div>
                                    <div className="progress-bar-container" style={{ marginBottom: "20px" }}>
                                      <div 
                                        className="progress-bar-fill progress-bar-blue" 
                                        style={{ width: `${course.progress_percent}%` }}
                                      />
                                    </div>
                                    
                                    <button 
                                      onClick={() => selectCourse(course.id)}
                                      className="tech-button-outline"
                                      style={{ width: "100%", borderRadius: "1rem" }}
                                    >
                                      เรียนต่อ
                                      <ChevronRight size={14} />
                                    </button>
                                  </div>
                                ) : (
                                  <button 
                                    onClick={() => {
                                      selectCourse(course.id);
                                      if (isExpired) {
                                        // Auto open checkout for renew
                                        setTimeout(() => startEnrollmentFlow(course), 300);
                                      }
                                    }}
                                    className="tech-button-primary"
                                    style={{ width: "100%", borderRadius: "1rem" }}
                                  >
                                    {isExpired ? "ต่ออายุสิทธิ์เข้าถึง" : "ดูรายละเอียด"}
                                    <ChevronRight size={14} />
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    );
                  })()}
                </motion.div>
              )}
            </AnimatePresence>

          </div>

          {/* Right Column: Course outlines and checklist */}
          <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
            
            {/* Outline Card (displays if course selected) */}
            {selectedCourseId && courseDetail && (
              <div className="glass-card">
                <h3 style={{ fontSize: "18px", color: "var(--text-primary)", marginBottom: "16px", display: "flex", alignItems: "center", gap: "8px" }}>
                  <BookOpen size={18} color="var(--primary)" />
                  เนื้อหาหลักสูตร
                </h3>

                {enrollment ? (
                  <div style={{ marginBottom: "20px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", color: "var(--text-secondary)", marginBottom: "8px" }}>
                      <span>ความคืบหน้าของคอร์ส</span>
                      <span style={{ color: "var(--primary)", fontWeight: "600" }}>{enrollment.progress_percent}%</span>
                    </div>
                    <div className="progress-bar-container">
                      <div 
                        className="progress-bar-fill progress-bar-blue" 
                        style={{ width: `${enrollment.progress_percent}%` }}
                      />
                    </div>
                    {enrollment.completed_at && (
                      <p style={{ fontSize: "11px", color: "var(--accent)", marginTop: "8px", display: "flex", alignItems: "center", gap: "4px", fontWeight: "600" }}>
                        <CheckCircle size={12} />
                        เรียนจบเมื่อ {formatDate(enrollment.completed_at)}
                      </p>
                    )}
                    {enrollment.expires_at && (
                      <p style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "6px", display: "flex", alignItems: "center", gap: "4px" }}>
                        <Clock size={12} />
                        สิทธิ์เข้าถึงหมดอายุ: {formatDate(enrollment.expires_at)}
                      </p>
                    )}

                    {/* Certificate Claim/View Area */}
                    {enrollment.progress_percent >= 95 && (
                      <div style={{
                        marginTop: "16px",
                        background: "linear-gradient(135deg, rgba(245,158,11,0.08) 0%, rgba(229,107,37,0.08) 100%)",
                        border: "1px dashed rgba(245,158,11,0.3)",
                        padding: "12px",
                        borderRadius: "0.75rem"
                      }}>
                        <p style={{ fontSize: "11px", color: "var(--text-secondary)", marginBottom: "8px", lineHeight: "1.4" }}>
                          🏆 <strong>เรียนครบทุกบทเรียนแล้ว</strong> ใบประกาศนียบัตรต้องเรียนครบทุกบทเรียนและตอบแบบทดสอบถูกอย่างน้อย 80%
                        </p>
                        {certificate ? (
                          <button
                            onClick={() => setShowCertificateModal(true)}
                            className="tech-button-primary"
                            style={{ 
                              width: "100%", 
                              padding: "6px 12px", 
                              fontSize: "11px", 
                              borderRadius: "0.5rem",
                              background: "linear-gradient(to right, #f59e0b, var(--primary))",
                              border: "none",
                              color: "#fff",
                              cursor: "pointer"
                            }}
                          >
                            {certificate.revoked_at ? "ใบประกาศถูกเพิกถอน" : "ดูใบประกาศนียบัตรดิจิทัล"}
                          </button>
                        ) : (
                          <button
                            onClick={handleClaimCertificate}
                            disabled={isClaimingCertificate}
                            className="tech-button-primary"
                            style={{ 
                              width: "100%", 
                              padding: "6px 12px", 
                              fontSize: "11px", 
                              borderRadius: "0.5rem",
                              background: "linear-gradient(to right, #f59e0b, var(--primary))",
                              border: "none",
                              color: "#fff",
                              cursor: "pointer"
                            }}
                          >
                            {isClaimingCertificate ? "กำลังสร้าง..." : "รับใบประกาศนียบัตร"}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ padding: "12px", background: "rgba(0,0,0,0.02)", border: "1px solid var(--border-subtle)", borderRadius: "1rem", marginBottom: "20px", display: "flex", gap: "10px", alignItems: "start" }}>
                    <Lock size={16} color="var(--text-muted)" style={{ marginTop: "2px", flexShrink: 0 }} />
                    <p style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                      ลงทะเบียนเรียนคอร์สนี้เพื่อติดตามความคืบหน้า ปลดล็อกวิดีโอ และเรียนบทเรียนให้จบ
                    </p>
                  </div>
                )}

                {/* Lessons grouped by chapter with completion and locks (components/course/CurriculumOutline.tsx) */}
                <CurriculumOutline lessons={lessons} sections={sections} activeLessonId={activeLessonId} enrolled={!!enrollment}
                  onSelect={lesson => loadVideo(lesson.id, lesson as Lesson)} />
              </div>
            )}

            {/* Quick stats / info card */}
            <div className="glass-card">
              <h3 style={{ fontSize: "16px", color: "var(--text-primary)", marginBottom: "12px", display: "flex", alignItems: "center", gap: "8px" }}>
                <TrendingUp size={16} color="var(--accent)" />
                ข้อมูลการเรียนของ LMS
              </h3>
              <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: "1.5" }}>
                ระบบ edge ของเราบันทึกความคืบหน้าของวิดีโอแบบเรียลไทม์ เมื่อดูวิดีโอถึง 95% ระบบจะซิงก์ข้อมูลไปยังฐานข้อมูล Cloudflare D1 ทันทีและบันทึกเวลาที่เรียนจบให้อัตโนมัติ
              </p>
            </div>

            {/* Fallback cover image generator */}
            <div style={{ display: "none" }}></div>

          </div>
        </div>
      </div>
      )}


      {/* Course purchase: bank-transfer order */}
      {checkoutCourse && (
        <CourseOrderModal
          course={checkoutCourse}
          onClose={() => setCheckoutCourse(null)}
          onEnrolled={() => { selectCourse(checkoutCourse.id); fetchCourses(); }}
          onShowPayments={() => {
            setStudentSubView("payments");
            setSelectedCourseId(null);
            setCourseDetail(null);
            setActiveLessonId(null);
            setVideoData(null);
          }}
        />
      )}

      {/* Certificate Claim Dialog Modal */}
      <dialog 
        ref={certDialogRef}
        closedby="any"
        aria-labelledby="certTitle"
        onClose={() => setShowCertificateModal(false)}
        style={{
          width: "100%",
          maxWidth: "680px",
          background: "rgba(10, 15, 30, 0.95)",
          backdropFilter: "blur(20px)",
          borderRadius: "2rem",
          boxShadow: "0 25px 50px -12px rgba(245, 158, 11, 0.25)",
          border: "2px solid rgba(245, 158, 11, 0.4)",
          padding: 0,
          color: "#fff",
          overflow: "hidden"
        }}
      >
        <div style={{ position: "relative", padding: "40px" }}>
          {/* Close button */}
          <button
            onClick={() => setShowCertificateModal(false)}
            style={{
              position: "absolute",
              top: "20px",
              right: "20px",
              background: "rgba(255,255,255,0.08)",
              border: "none",
              color: "#ffffff",
              borderRadius: "50%",
              width: "32px",
              height: "32px",
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              cursor: "pointer"
            }}
          >
            <X size={16} />
          </button>

          {/* Certificate Board Border Layout */}
          <div style={{
            border: "2px dashed rgba(245, 158, 11, 0.3)",
            borderRadius: "1rem",
            padding: "36px",
            textAlign: "center",
            background: "radial-gradient(circle at center, rgba(15,23,42,0.6) 0%, rgba(2,6,23,0.95) 100%)",
            position: "relative"
          }}>
            {/* Watermark Logo */}
            <div style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              opacity: 0.03,
              fontSize: "120px",
              fontWeight: "900",
              pointerEvents: "none",
              letterSpacing: "0.1em"
            }}>
              NETPRIME
            </div>

            <div style={{ display: "flex", justifyContent: "center", marginBottom: "16px" }}>
              <Award size={48} color="#f59e0b" style={{ filter: "drop-shadow(0 0 10px rgba(245, 158, 11, 0.5))" }} />
            </div>

            <h1 id="certTitle" style={{
              fontFamily: "Outfit, Inter, sans-serif",
              fontSize: "26px",
              fontWeight: "800",
              letterSpacing: "0.05em",
              color: "#f59e0b",
              textTransform: "uppercase",
              marginBottom: "4px"
            }}>
              ใบประกาศนียบัตรการเรียนจบหลักสูตร
            </h1>
            <p style={{ fontSize: "11px", color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: "24px" }}>
              Netprime Global Learning Authority
            </p>

            <p style={{ fontSize: "13px", color: "#cbd5e1", fontStyle: "italic", marginBottom: "12px" }}>
              ขอรับรองว่า
            </p>

            <h2 style={{
              fontSize: "28px",
              fontWeight: "800",
              color: "#ffffff",
              textShadow: "0 2px 10px rgba(255,255,255,0.1)",
              marginBottom: "12px",
              borderBottom: "1px solid rgba(245, 158, 11, 0.2)",
              display: "inline-block",
              paddingBottom: "8px",
              paddingLeft: "24px",
              paddingRight: "24px"
            }}>
              {api.user?.name}
            </h2>

            <p style={{ fontSize: "13px", color: "#cbd5e1", fontStyle: "italic", marginTop: "12px", marginBottom: "12px" }}>
              ได้เรียนจบบทเรียนและผ่านการประเมินครบถ้วนของคอร์ส
            </p>

            <h3 style={{
              fontSize: "20px",
              fontWeight: "700",
              color: "#f59e0b",
              lineHeight: "1.4",
              marginBottom: "32px"
            }}>
              {courseDetail?.title}
            </h3>

            {/* Footer Signatures Area */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr 1fr", gap: "20px", alignItems: "end", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "24px" }}>
              <div style={{ textAlign: "left" }}>
                <p style={{ fontSize: "11px", color: "#94a3b8", textTransform: "uppercase" }}>วันที่ออก</p>
                <p style={{ fontSize: "12px", fontWeight: "600", color: "#fff", marginTop: "2px" }}>
                  {certificate ? formatDate(certificate.issued_at) : new Date().toLocaleDateString("th-TH")}
                </p>
              </div>

              <div>
                <p style={{ fontSize: "10px", color: "#94a3b8", textTransform: "uppercase" }}>รหัสตรวจสอบ</p>
                <p style={{ fontSize: "11px", fontFamily: "monospace", fontWeight: "700", color: "#cbd5e1", marginTop: "2px", background: "rgba(255,255,255,0.05)", padding: "4px 8px", borderRadius: "6px", display: "inline-block" }}>
                  {certificate?.certificate_code}
                </p>
              </div>

              <div style={{ textAlign: "right" }}>
                <p style={{ fontSize: "11px", color: "#94a3b8", textTransform: "uppercase" }}>ลายเซ็น</p>
                <span style={{ fontSize: "15px", fontFamily: "'Brush Script MT', cursive, sans-serif", color: "#f59e0b", display: "block", marginTop: "2px" }}>
                  คณะกรรมการ Netprime
                </span>
              </div>
            </div>
          </div>

          <div style={{ marginTop: "24px", textAlign: "center" }}>
            {certificate?.revoked_at ? (
              <p role="alert" style={{ fontSize: "13px", color: "#f87171", fontWeight: 700, marginBottom: "16px" }}>
                ใบประกาศนี้เพิกถอนแล้วเมื่อ {formatDate(certificate.revoked_at)} ใช้อ้างอิงไม่ได้ กรุณาติดต่อเจ้าหน้าที่
              </p>
            ) : (
              <p style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "16px" }}>
                นายจ้างสามารถตรวจสอบใบประกาศนียบัตรนี้ได้ทันทีผ่านลิงก์ตรวจสอบสาธารณะ
              </p>
            )}
            <div style={{ display: "flex", gap: "12px", justifyContent: "center", flexWrap: "wrap" }}>
              {certificate && !certificate.revoked_at && (
                <button
                  type="button"
                  onClick={() => setPrintingCertificate(true)}
                  className="tech-button-outline"
                  style={{ display: "inline-flex", alignItems: "center", gap: "8px", borderColor: "#f59e0b", color: "#f59e0b", borderRadius: "1rem", padding: "8px 20px", cursor: "pointer" }}
                >
                  <Printer size={16} /> พิมพ์ / บันทึกเป็น PDF
                </button>
              )}
              <a
                href={`/verify-certificates?code=${certificate?.certificate_code}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigator.clipboard.writeText(`${window.location.origin}/verify-certificates?code=${certificate?.certificate_code}`);
                  alert("คัดลอกลิงก์ตรวจสอบแล้ว");
                }}
                className="tech-button-outline"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  borderColor: "#f59e0b",
                  color: "#f59e0b",
                  borderRadius: "1rem",
                  padding: "8px 20px",
                  cursor: "pointer"
                }}
              >
                คัดลอก URL ตรวจสอบ
              </a>
              {certificate && !certificate.revoked_at && (
                <a
                  href={`https://www.linkedin.com/profile/add?startTask=CERTIFICATION_NAME&name=${encodeURIComponent(courseDetail?.title || "Netprime LMS Certification")}&organizationName=Netprime%20Academy&certUrl=${encodeURIComponent(`${window.location.origin}/verify-certificates?code=${certificate.certificate_code}`)}&certId=${certificate.certificate_code}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="tech-button-primary"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    borderRadius: "1rem",
                    padding: "8px 20px",
                    cursor: "pointer",
                    background: "#0a66c2",
                    border: "none",
                    color: "#fff"
                  }}
                >
                  <Linkedin size={16} /> เพิ่มใน LinkedIn
                </a>
              )}
            </div>
          </div>
        </div>
      </dialog>
      {/* Cert Dialog Ends */}
      {printingCertificate && certificate && (
        <CertificatePrint
            courseId={selectedCourseId}
            onDone={() => setPrintingCertificate(false)}
            cert={{
              certificate_code: certificate.certificate_code,
              issued_at: certificate.issued_at,
              student_name: certificate.student_name || api.user?.name || "",
              course_title: certificate.course_title || courseDetail?.title || "",
              revoked_at: certificate.revoked_at
            }}
            verifyUrl={`${window.location.origin}/verify-certificates?code=${certificate.certificate_code}`}
          />
      )}
      {showConfetti && <Confetti recycle={false} numberOfPieces={500} onConfettiComplete={() => setShowConfetti(false)} style={{ zIndex: 9999 }} />}
    </div>
  );
};

// Global fallback cover image generator helper
const getFallbackCover = (title: string) => {
  const titleLower = title.toLowerCase();
  if (titleLower.includes("cisco")) return "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&auto=format&fit=crop&q=60";
  if (titleLower.includes("aws") || titleLower.includes("cloud")) return "https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=600&auto=format&fit=crop&q=60";
  if (titleLower.includes("juniper") || titleLower.includes("arista") || titleLower.includes("aruba")) return "https://images.unsplash.com/photo-1544197150-b99a580bb7a8?w=600&auto=format&fit=crop&q=60";
  if (titleLower.includes("security") || titleLower.includes("cyber")) return "https://images.unsplash.com/photo-1563986768609-322da13575f3?w=600&auto=format&fit=crop&q=60";
  return "https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=600&auto=format&fit=crop&q=60";
};

export default Dashboard;
