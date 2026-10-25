import React, { useState, useEffect } from "react";
import { useApi, hasRole } from "../hooks/useApi";
import { Chip } from "../components/site-admin/ui";
import { COURSE_STATUS, CourseStatus } from "./CoursesAdminPage";
import { MetricsCard } from "../components/MetricsCard";
import { CourseAssessments } from "../components/assessment/CourseAssessments";
import { CourseLiveClassesPanel } from "../components/settings/CourseLiveClasses";
import { CourseAnnouncements } from "../components/communication/CourseAnnouncements";
import { CourseBuilder } from "../components/course/CourseBuilder";
import { AiInstructorTools } from "../components/ai/AiInstructorTools";
import { motion, AnimatePresence } from "framer-motion";
import { 
  BookOpen, 
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

interface InstructorCourse {
  id: string;
  title: string;
  description: string;
  thumbnail_url: string;
  cover_image_url?: string | null;
  access_duration_days?: number | null;
  price?: number;
  created_at: string;
  student_count: number;
  avg_progress: number | null;
  status: CourseStatus;
  submitted_at?: string | null;
  published_at?: string | null;
  /** Reviewer's note when the course was sent back. */
  review_note?: string | null;
}

/** Workers reject request bodies above 100 MB; bigger videos upload straight to Cloudflare Stream. */
const WORKER_UPLOAD_LIMIT = 100 * 1024 * 1024;
/** tus chunk size for Stream uploads (multiple of 256 KiB, at least 5 MB). */
const STREAM_CHUNK = 50 * 1024 * 1024;

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
  cloudflare: "Cloudflare Stream",
  youtube: "YouTube",
  vimeo: "Vimeo",
};

const ENROLLMENT_STATUS_LABELS: Record<string, string> = {
  active: "ใช้งานอยู่",
  completed: "เรียนจบ",
  expired: "หมดอายุ",
  suspended: "ระงับ",
  pending: "รอดำเนินการ",
};

type ConsoleView = 
  | "dashboard"
  | "create-course"
  | "edit-course"
  | "curriculum"
  | "create-lesson"
  | "edit-lesson"
  | "quizzes"
  | "vouchers"
  | "groups"
  | "access-control"
  | "telemetry"
  | "qa";

export const InstructorConsole: React.FC = () => {
  const api = useApi();
  const isAdmin = hasRole(api.user, "admin");
  const [data, setData] = useState<InstructorAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Navigation View State
  const [view, setView] = useState<ConsoleView>("dashboard");
  const [actionLoading, setActionLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Add Course state
  const [courseTitle, setCourseTitle] = useState("");
  const [courseDesc, setCourseDesc] = useState("");
  const [courseThumb, setCourseThumb] = useState("");

  // Add Lesson state
  const [lessonCourseId, setLessonCourseId] = useState("");
  const [lessonTitle, setLessonTitle] = useState("");
  const [lessonStreamUid, setLessonStreamUid] = useState("");
  const [lessonSortOrder, setLessonSortOrder] = useState(1);
  const [lessonProvider, setLessonProvider] = useState("cloudflare");
  const [lessonHandoutKey, setLessonHandoutKey] = useState("");

  // Course CRUD state
  const [editingCourse, setEditingCourse] = useState<InstructorCourse | null>(null);
  const [editCourseTitle, setEditCourseTitle] = useState("");
  const [editCourseDesc, setEditCourseDesc] = useState("");
  const [editCourseThumb, setEditCourseThumb] = useState("");

  // Curriculum State
  const [selectedCourseForCurriculum, setSelectedCourseForCurriculum] = useState<InstructorCourse | null>(null);
  const [curriculumLessons, setCurriculumLessons] = useState<any[]>([]);
  const [curriculumLoading, setCurriculumLoading] = useState(false);

  // Lesson CRUD/Edit state
  const [editingLesson, setEditingLesson] = useState<any | null>(null);
  const [editLessonTitle, setEditLessonTitle] = useState("");
  const [editLessonStreamUid, setEditLessonStreamUid] = useState("");
  const [editLessonProvider, setEditLessonProvider] = useState("cloudflare");
  const [editLessonHandoutKey, setEditLessonHandoutKey] = useState("");
  const [editLessonSortOrder, setEditLessonSortOrder] = useState(1);

  // Quiz Management State
  const [selectedLessonForQuizzes, setSelectedLessonForQuizzes] = useState<any | null>(null);
  const [lessonQuizzes, setLessonQuizzes] = useState<any[]>([]);
  const [quizzesLoading, setQuizzesLoading] = useState(false);
  const [newQuizQuestion, setNewQuizQuestion] = useState("");
  const [newQuizOptions, setNewQuizOptions] = useState(["", "", "", ""]);
  const [newQuizCorrectIndex, setNewQuizCorrectIndex] = useState(0);

  // Extended course metadata
  const [coursePrice, setCoursePrice] = useState<number>(0);
  const [courseCover, setCourseCover] = useState<string>("");
  const [courseDuration, setCourseDuration] = useState<string>("");

  const [editCoursePrice, setEditCoursePrice] = useState<number>(0);
  const [editCourseCover, setEditCourseCover] = useState<string>("");
  const [editCourseDuration, setEditCourseDuration] = useState<string>("");

  // Access Control states
  const [courseEnrollments, setCourseEnrollments] = useState<any[]>([]);
  const [assignTargetType, setAssignTargetType] = useState<"student" | "partner" | "group">("student");
  const [assignTargetId, setAssignTargetId] = useState<string>("");
  const [allPartners, setAllPartners] = useState<any[]>([]);

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

  // Uploader states
  const [uploadingHandout, setUploadingHandout] = useState(false);
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

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
  const uploadFile = async (file: File, type: "handout" | "video"): Promise<string> => {
    if (type === "video" && file.size > WORKER_UPLOAD_LIMIT) return uploadToStream(file);

    // 1. Reserve the upload; the server picks the key and remembers type and size
    const presignRes = await api.post<{ key: string; uploadUrl: string; contentType: string }>("/instructor/upload/presign", {
      filename: file.name,
      type,
      size: file.size,
      mimeType: file.type
    });

    // 2. Upload the raw binary file stream directly to R2 target
    await api.request<any>(presignRes.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": presignRes.contentType
      },
      body: file
    });

    return presignRes.key;
  };

  const uploadToStream = async (file: File): Promise<string> => {
    const { uploadURL, uid } = await api.post<{ uploadURL: string; uid: string }>("/instructor/stream/direct-upload", {
      size: file.size,
      filename: file.name
    });
    let offset = 0;
    setUploadProgress(0);
    try {
      while (offset < file.size) {
        const chunk = file.slice(offset, offset + STREAM_CHUNK);
        const res = await fetch(uploadURL, {
          method: "PATCH",
          headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" },
          body: chunk
        });
        if (!res.ok) throw new Error(`Cloudflare Stream ตอบกลับ ${res.status}`);
        offset = Number(res.headers.get("Upload-Offset")) || offset + chunk.size;
        setUploadProgress(Math.round((offset / file.size) * 100));
      }
    } finally {
      setUploadProgress(null);
    }
    return uid;
  };

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
      
      // Select first course by default in the dropdown if courses exist
      if (res.courses.length > 0 && !lessonCourseId) {
        setLessonCourseId(res.courses[0].id);
      }
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

  const loadAccessControl = async (courseId: string) => {
    try {
      setActionLoading(true);
      setModalError(null);
      
      const enrolls = await api.get<any[]>(`/instructor/courses/${courseId}/enrollments`);
      setCourseEnrollments(enrolls);
      
      const students = await api.get<any[]>("/instructor/students");
      setAllStudents(students);
      
      const partners = await api.get<any[]>("/business/partners");
      setAllPartners(partners);

      const grps = await api.get<any[]>("/instructor/groups");
      setGroups(grps);

      if (students.length > 0) {
        setAssignTargetId(students[0].id);
      }
    } catch (err: any) {
      console.error(err);
      setModalError(err.message || "โหลดข้อมูลสิทธิ์การเข้าถึงไม่สำเร็จ");
    } finally {
      setActionLoading(false);
    }
  };

  useEffect(() => {
    if (hasRole(api.user, "instructor", "admin")) {
      fetchAnalytics();
      setView("dashboard"); // Reset to main dashboard upon auth node refreshes
    }
  }, [api.token]);

  const handleAddCourse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!courseTitle || !courseDesc) {
      setModalError("กรุณากรอกชื่อคอร์สและคำอธิบาย");
      return;
    }

    try {
      setActionLoading(true);
      setModalError(null);
      
      await api.post("/instructor/courses", {
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
      setView("dashboard");

      await fetchAnalytics();
    } catch (err: any) {
      console.error(err);
      setModalError(err.message || "บันทึกคอร์สใหม่ไม่สำเร็จ");
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddLesson = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lessonCourseId || !lessonTitle || !lessonStreamUid) {
      setModalError("กรุณากรอกข้อมูลบทเรียนให้ครบทุกช่อง");
      return;
    }

    try {
      setActionLoading(true);
      setModalError(null);

      await api.post("/instructor/lessons", {
        course_id: lessonCourseId,
        title: lessonTitle,
        video_stream_uid: lessonStreamUid,
        video_provider: lessonProvider,
        handout_r2_key: lessonHandoutKey || undefined,
        sort_order: Number(lessonSortOrder)
      });

      // Reset fields and return to curriculum page
      setLessonTitle("");
      setLessonStreamUid("");
      setLessonSortOrder(1);
      setLessonProvider("cloudflare");
      setLessonHandoutKey("");
      setView("curriculum");

      await fetchAnalytics();
      if (selectedCourseForCurriculum) {
        await loadCurriculum(selectedCourseForCurriculum.id);
      }
    } catch (err: any) {
      console.error(err);
      setModalError(err.message || "บันทึกบทเรียนใหม่ไม่สำเร็จ");
    } finally {
      setActionLoading(false);
    }
  };

  // Course Operations
  const handleDeleteCourse = async (courseId: string) => {
    if (!window.confirm("คุณแน่ใจหรือไม่ว่าต้องการลบคอร์สนี้และบทเรียนทั้งหมด? การดำเนินการนี้ไม่สามารถย้อนกลับได้")) return;
    try {
      setActionLoading(true);
      setError(null);
      await api.request(`/instructor/courses/${courseId}`, { method: "DELETE" });
      await fetchAnalytics();
      if (selectedCourseForCurriculum?.id === courseId) {
        setSelectedCourseForCurriculum(null);
        setView("dashboard");
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "ลบคอร์สไม่สำเร็จ");
    } finally {
      setActionLoading(false);
    }
  };

  const handleEditCourseClick = (course: InstructorCourse) => {
    setEditingCourse(course);
    setEditCourseTitle(course.title);
    setEditCourseDesc(course.description);
    setEditCourseThumb(course.thumbnail_url || "");
    setEditCoursePrice(course.price || 0);
    setEditCourseCover(course.cover_image_url || "");
    setEditCourseDuration(course.access_duration_days ? String(course.access_duration_days) : "");
    setModalError(null);
    setView("edit-course");
  };

  const handleUpdateCourse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCourse) return;
    if (!editCourseTitle || !editCourseDesc) {
      setModalError("กรุณากรอกชื่อคอร์สและคำอธิบาย");
      return;
    }
    try {
      setActionLoading(true);
      setModalError(null);
      await api.patch(`/instructor/courses/${editingCourse.id}`, {
        title: editCourseTitle,
        description: editCourseDesc,
        thumbnail_url: editCourseThumb || undefined,
        price: Number(editCoursePrice),
        cover_image_url: editCourseCover || undefined,
        access_duration_days: editCourseDuration ? Number(editCourseDuration) : null
      });
      setEditingCourse(null);
      setView("dashboard");
      await fetchAnalytics();
    } catch (err: any) {
      console.error(err);
      setModalError(err.message || "อัปเดตคอร์สไม่สำเร็จ");
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

  const handleManageCurriculumClick = async (course: InstructorCourse) => {
    setSelectedCourseForCurriculum(course);
    setView("curriculum");
    await loadCurriculum(course.id);
  };

  // Lesson Operations
  const handleDeleteLesson = async (lessonId: string) => {
    if (!window.confirm("คุณแน่ใจหรือไม่ว่าต้องการลบบทเรียนนี้?")) return;
    try {
      setActionLoading(true);
      await api.request(`/instructor/lessons/${lessonId}`, { method: "DELETE" });
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

  const handleEditLessonClick = (lesson: any) => {
    setEditingLesson(lesson);
    setEditLessonTitle(lesson.title);
    setEditLessonStreamUid(lesson.video_stream_uid || "");
    setEditLessonProvider(lesson.video_provider || "cloudflare");
    setEditLessonHandoutKey(lesson.handout_r2_key || "");
    setEditLessonSortOrder(lesson.sort_order || 1);
    setModalError(null);
    setView("edit-lesson");
  };

  const handleUpdateLesson = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingLesson) return;
    if (!editLessonTitle || !editLessonStreamUid) {
      setModalError("กรุณากรอกชื่อบทเรียนและรหัสวิดีโอ (UID)");
      return;
    }
    try {
      setActionLoading(true);
      setModalError(null);
      await api.patch(`/instructor/lessons/${editingLesson.id}`, {
        title: editLessonTitle,
        video_stream_uid: editLessonStreamUid,
        video_provider: editLessonProvider,
        handout_r2_key: editLessonHandoutKey || null,
        sort_order: Number(editLessonSortOrder)
      });
      setEditingLesson(null);
      setView("curriculum");
      if (selectedCourseForCurriculum) {
        await loadCurriculum(selectedCourseForCurriculum.id);
      }
      await fetchAnalytics();
    } catch (err: any) {
      console.error(err);
      setModalError(err.message || "อัปเดตบทเรียนไม่สำเร็จ");
    } finally {
      setActionLoading(false);
    }
  };

  // Quiz Operations
  const loadQuizzes = async (lessonId: string) => {
    try {
      setQuizzesLoading(true);
      const res = await api.get<any[]>(`/instructor/lessons/${lessonId}/quizzes`);
      setLessonQuizzes(res);
    } catch (err: any) {
      console.error(err);
      alert("โหลดแบบทดสอบของบทเรียนไม่สำเร็จ");
    } finally {
      setQuizzesLoading(false);
    }
  };

  const handleManageQuizzesClick = async (lesson: any) => {
    setSelectedLessonForQuizzes(lesson);
    setNewQuizQuestion("");
    setNewQuizOptions(["", "", "", ""]);
    setNewQuizCorrectIndex(0);
    setView("quizzes");
    await loadQuizzes(lesson.id);
  };

  const handleDeleteQuiz = async (quizId: string) => {
    if (!window.confirm("คุณแน่ใจหรือไม่ว่าต้องการลบคำถามแบบทดสอบข้อนี้?")) return;
    try {
      setActionLoading(true);
      await api.request(`/instructor/quizzes/${quizId}`, { method: "DELETE" });
      if (selectedLessonForQuizzes) {
        await loadQuizzes(selectedLessonForQuizzes.id);
      }
    } catch (err: any) {
      console.error(err);
      alert(err.message || "ลบคำถามแบบทดสอบไม่สำเร็จ");
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddQuiz = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedLessonForQuizzes) return;
    if (!newQuizQuestion || newQuizOptions.some(opt => !opt.trim())) {
      alert("กรุณากรอกคำถามและตัวเลือกทั้งสี่ข้อ");
      return;
    }
    try {
      setActionLoading(true);
      await api.post("/instructor/quizzes", {
        lesson_id: selectedLessonForQuizzes.id,
        question: newQuizQuestion,
        options_json: newQuizOptions,
        correct_option_index: newQuizCorrectIndex
      });
      setNewQuizQuestion("");
      setNewQuizOptions(["", "", "", ""]);
      setNewQuizCorrectIndex(0);
      await loadQuizzes(selectedLessonForQuizzes.id);
    } catch (err: any) {
      console.error(err);
      alert(err.message || "เพิ่มคำถามแบบทดสอบไม่สำเร็จ");
    } finally {
      setActionLoading(false);
    }
  };

  if (!hasRole(api.user, "instructor", "admin")) {
    return (
      <div className="glass-card animate-fade-in" style={{ padding: "40px", textAlign: "center", borderLeft: "4px solid var(--danger)" }}>
        <h2 style={{ color: "var(--danger)" }}>ต้องมีสิทธิ์ผู้สอน</h2>
        <p style={{ color: "var(--text-secondary)", marginTop: "8px" }}>
          คอนโซลนี้สำหรับผู้สอนเท่านั้น กรุณาเข้าสู่ระบบด้วยบัญชีที่ได้รับอนุญาตเพื่อดำเนินการต่อ
        </p>
      </div>
    );
  }

  // ==========================================
  // VIEW RENDER HELPER FUNCTIONS (Dedicated Pages)
  // ==========================================

  const renderDashboard = () => {
    return (
      <div>
        <div className="header-row">
          <div>
            <h1 className="header-title">คอนโซลผู้สอน</h1>
            <p className="header-desc">
              สวัสดี อาจารย์{api.user?.name || "ผู้สอน"} • จัดการคอร์สและเผยแพร่บทเรียนบน Cloudflare CDN
            </p>
          </div>

          <div style={{ display: "flex", gap: "12px" }}>
            <button 
              onClick={() => {
                fetchVouchers();
                setView("vouchers");
              }}
              className="tech-button-outline"
              style={{ borderRadius: "1rem", display: "flex", alignItems: "center", gap: "6px" }}
            >
              <Ticket size={16} />
              โค้ดส่วนลด
            </button>
            <button 
              onClick={() => {
                fetchGroups();
                setView("groups");
              }}
              className="tech-button-outline"
              style={{ borderRadius: "1rem", display: "flex", alignItems: "center", gap: "6px" }}
            >
              <Users size={16} />
              กลุ่มเรียน
            </button>
            <button 
              onClick={() => {
                fetchTelemetry();
                setView("telemetry");
              }}
              className="tech-button-outline"
              style={{ borderRadius: "1rem", display: "flex", alignItems: "center", gap: "6px" }}
            >
              <TrendingUp size={16} />
              ตรวจสอบข้อมูลการใช้งาน
            </button>
            <button 
              onClick={() => {
                fetchInstructorQuestions();
                setView("qa");
              }}
              className="tech-button-outline"
              style={{ borderRadius: "1rem", display: "flex", alignItems: "center", gap: "6px" }}
            >
              <ClipboardList size={16} />
              ถามตอบ
            </button>
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
                subValue="หลักสูตรที่เปิดใช้งานบน Edge"
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
                  รายการคอร์สทั้งหมด
                </h3>

                {data.courses.length === 0 ? (
                  <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
                    ยังไม่มีคอร์สในระบบ กด "สร้างคอร์ส" เพื่อเพิ่มคอร์สใหม่
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                    {data.courses.map((course) => (
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
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", width: "100%" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "16px", flexGrow: 1 }}>
                            <img 
                              src={course.thumbnail_url} 
                              alt={course.title} 
                              style={{ width: "64px", height: "48px", borderRadius: "0.5rem", objectFit: "cover", border: "1px solid var(--border-active)" }} 
                            />
                            <div>
                              <h4 style={{ fontSize: "15px", fontWeight: "700", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                {course.title}
                                {COURSE_STATUS[course.status] && <Chip {...COURSE_STATUS[course.status]} />}
                              </h4>
                              <p style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>
                                สร้างเมื่อ: {new Date(course.created_at).toLocaleDateString("th-TH")} • ID: {course.id.substring(0, 8)}
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
                            onClick={() => handleManageCurriculumClick(course)}
                            className="tech-button-outline"
                            style={{ padding: "6px 12px", fontSize: "12px", borderRadius: "0.5rem" }}
                          >
                            จัดการเนื้อหา
                          </button>
                          <button 
                            onClick={() => {
                              setSelectedCourseForCurriculum(course);
                              loadAccessControl(course.id);
                              setView("access-control");
                            }}
                            className="tech-button-outline"
                            style={{ padding: "6px 12px", fontSize: "12px", borderRadius: "0.5rem", borderColor: "var(--border-active)" }}
                          >
                            จัดการสิทธิ์เข้าถึง
                          </button>
                          <button 
                            onClick={() => handleEditCourseClick(course)}
                            className="tech-button-outline"
                            style={{ padding: "6px 12px", fontSize: "12px", borderRadius: "0.5rem", borderColor: "var(--border-active)" }}
                          >
                            แก้ไขคอร์ส
                          </button>
                          <button 
                            onClick={() => handleDeleteCourse(course.id)}
                            className="tech-button-outline"
                            style={{ padding: "6px 12px", fontSize: "12px", borderRadius: "0.5rem", color: "var(--danger)", borderColor: "rgba(239, 68, 68, 0.2)" }}
                          >
                            ลบคอร์ส
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
              placeholder="เช่น TypeScript ขั้นสูงและการออกแบบ Edge API"
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

  const renderEditCourse = () => {
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
          <Edit size={24} color="var(--primary)" />
          แก้ไขคอร์ส
        </h3>
        <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginBottom: "24px" }}>
          แก้ไขชื่อ รายละเอียด และข้อมูลของคอร์ส
        </p>

        {modalError && (
          <div style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", color: "var(--danger)", padding: "12px", borderRadius: "1rem", fontSize: "13px", marginBottom: "20px" }}>
            <strong>ข้อผิดพลาด:</strong> {modalError}
          </div>
        )}

        <form onSubmit={handleUpdateCourse} style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div className="form-group">
            <label className="form-label">ชื่อคอร์ส</label>
            <input
              type="text"
              value={editCourseTitle}
              onChange={(e) => setEditCourseTitle(e.target.value)}
              className="form-input"
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label">คำอธิบาย</label>
            <textarea
              rows={6}
              value={editCourseDesc}
              onChange={(e) => setEditCourseDesc(e.target.value)}
              className="form-input"
              style={{ resize: "none", fontFamily: "inherit", borderRadius: "1rem" }}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label">URL รูปปก (ไม่บังคับ)</label>
            <input
              type="url"
              value={editCourseThumb}
              onChange={(e) => setEditCourseThumb(e.target.value)}
              className="form-input"
            />
          </div>

          <div className="form-group">
            <label className="form-label">URL แบนเนอร์หน้าปก (ไม่บังคับ)</label>
            <input
              type="url"
              placeholder="https://images.unsplash.com/... (URL รูปแบนเนอร์ขนาดใหญ่)"
              value={editCourseCover}
              onChange={(e) => setEditCourseCover(e.target.value)}
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
                value={editCoursePrice}
                onChange={(e) => setEditCoursePrice(Number(e.target.value))}
                className="form-input"
              />
            </div>

            <div className="form-group">
              <label className="form-label">ระยะเวลาเข้าถึง (วัน)</label>
              <input
                type="number"
                min="1"
                placeholder="เว้นว่าง = เข้าถึงตลอดชีพ"
                value={editCourseDuration}
                onChange={(e) => setEditCourseDuration(e.target.value)}
                className="form-input"
              />
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "12px" }}>
            <button type="button" onClick={() => setView("dashboard")} className="tech-button-outline" style={{ borderRadius: "1rem" }}>ยกเลิก</button>
            <button type="submit" disabled={actionLoading} className="tech-button-primary" style={{ borderRadius: "1rem" }}>
              {actionLoading ? "กำลังอัปเดต..." : "บันทึกการเปลี่ยนแปลง"}
            </button>
          </div>
        </form>
      </div>
    );
  };

  const renderCurriculum = () => {
    if (!selectedCourseForCurriculum) return null;

    return (
      <div className="glass-card animate-fade-in" style={{ padding: "32px", border: "1px solid var(--border-subtle)", borderRadius: "1.5rem" }}>
        <button 
          onClick={() => setView("dashboard")} 
          style={{ display: "flex", alignItems: "center", gap: "8px", background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: "14px", fontWeight: "600", marginBottom: "24px" }}
        >
          <ArrowLeft size={16} />
          กลับไปแดชบอร์ด
        </button>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "24px", gap: "16px" }}>
          <div>
            <h3 style={{ fontSize: "24px", display: "flex", alignItems: "center", gap: "8px", color: "var(--text-primary)" }}>
              <LayoutGrid size={24} color="var(--primary)" />
              จัดการเนื้อหาหลักสูตร
            </h3>
            <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginTop: "4px" }}>
              จัดการบทเรียน แหล่งวิดีโอ และเอกสารประกอบการเรียนของ: <strong style={{ color: "var(--text-primary)" }}>{selectedCourseForCurriculum.title}</strong>
            </p>
          </div>

          <div style={{ display: "flex", gap: "12px", flexShrink: 0 }}>
          <AiInstructorTools courses={data?.courses ?? []} course={selectedCourseForCurriculum} lessons={curriculumLessons}
            onChanged={() => loadCurriculum(selectedCourseForCurriculum.id)} />
          <button 
            type="button" 
            onClick={() => {
              setLessonCourseId(selectedCourseForCurriculum.id);
              setLessonTitle("");
              setLessonStreamUid("");
              setLessonSortOrder(curriculumLessons.length + 1);
              setLessonProvider("cloudflare");
              setLessonHandoutKey("");
              setModalError(null);
              setView("create-lesson");
            }}
            className="tech-button-primary"
            style={{ borderRadius: "1rem", flexShrink: 0 }}
          >
            <Plus size={16} /> เพิ่มบทเรียน
          </button>
          </div>
        </div>

        {/* Chapters, typed lessons, drip, sales page and prerequisites: components/course/CourseBuilder.tsx */}
        <CourseBuilder
          courseId={selectedCourseForCurriculum.id}
          refreshToken={curriculumLessons}
          onAddVideoLesson={() => {
            setLessonCourseId(selectedCourseForCurriculum.id);
            setLessonTitle("");
            setLessonStreamUid("");
            setLessonSortOrder(curriculumLessons.length + 1);
            setLessonProvider("cloudflare");
            setLessonHandoutKey("");
            setModalError(null);
            setView("create-lesson");
          }}
          onEditVideoLesson={lesson => handleEditLessonClick(lesson)}
          onManageQuizzes={lesson => handleManageQuizzesClick(lesson)}
          onDeleteLesson={lessonId => handleDeleteLesson(lessonId)}
        />
        {/* Question bank, exams, assignments, video questions and grading: components/assessment */}
        <CourseAssessments courseId={selectedCourseForCurriculum.id} />
        <CourseLiveClassesPanel courseId={selectedCourseForCurriculum.id} />
        <CourseAnnouncements courseId={selectedCourseForCurriculum.id} />
      </div>
    );
  };

  const renderCreateLesson = () => {
    if (!selectedCourseForCurriculum) return null;

    return (
      <div className="glass-card animate-fade-in" style={{ padding: "32px", border: "1px solid var(--border-subtle)", borderRadius: "1.5rem" }}>
        <button 
          onClick={() => setView("curriculum")} 
          style={{ display: "flex", alignItems: "center", gap: "8px", background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: "14px", fontWeight: "600", marginBottom: "24px" }}
        >
          <ArrowLeft size={16} />
          กลับไปเนื้อหาหลักสูตร
        </button>

        <h3 style={{ fontSize: "24px", display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px", color: "var(--text-primary)" }}>
          <Film size={24} color="var(--primary)" />
          เพิ่มบทเรียน
        </h3>
        <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginBottom: "24px" }}>
          เพิ่มบทเรียนใหม่ในคอร์ส: <strong style={{ color: "var(--text-primary)" }}>{selectedCourseForCurriculum.title}</strong>
        </p>

        {modalError && (
          <div style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", color: "var(--danger)", padding: "12px", borderRadius: "1rem", fontSize: "13px", marginBottom: "20px" }}>
            <strong>ข้อผิดพลาด:</strong> {modalError}
          </div>
        )}

        <form onSubmit={handleAddLesson} style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div className="form-group">
            <label className="form-label">ชื่อบทเรียน</label>
            <input
              type="text"
              placeholder="เช่น แนะนำ Workers CLI"
              value={lessonTitle}
              onChange={(e) => setLessonTitle(e.target.value)}
              className="form-input"
              required
            />
          </div>

          <div className="form-group" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div>
              <label className="form-label">แหล่งวิดีโอ</label>
              <select
                value={lessonProvider}
                onChange={(e) => setLessonProvider(e.target.value)}
                className="form-input"
                style={{ cursor: "pointer", borderRadius: "1rem" }}
                required
              >
                <option value="cloudflare">Cloudflare Stream</option>
                <option value="youtube">YouTube (ฝังวิดีโอ)</option>
                <option value="vimeo">Vimeo (ฝังวิดีโอ)</option>
              </select>
            </div>

            <div>
              <label className="form-label">ลำดับบทเรียน</label>
              <input
                type="number"
                min={1}
                value={lessonSortOrder}
                onChange={(e) => setLessonSortOrder(Number(e.target.value))}
                className="form-input"
                required
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">รหัสวิดีโอ (Stream UID / Embed ID)</label>
            <div style={{ display: "flex", gap: "10px" }}>
              <input
                type="text"
                placeholder="เช่น cf-stream-uid หรือ youtube-video-id"
                value={lessonStreamUid}
                onChange={(e) => setLessonStreamUid(e.target.value)}
                className="form-input"
                style={{ flexGrow: 1 }}
                required
              />
              <label className="tech-button-outline" style={{ borderRadius: "0.5rem", padding: "8px 16px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px", height: "fit-content", flexShrink: 0 }}>
                {uploadingVideo ? (uploadProgress !== null ? `กำลังอัปโหลด ${uploadProgress}%` : "กำลังอัปโหลด...") : "อัปโหลดวิดีโอ"}
                <input
                  type="file"
                  accept="video/*"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      setUploadingVideo(true);
                      setUploadError(null);
                      const key = await uploadFile(file, "video");
                      setLessonStreamUid(key);
                      setLessonProvider("cloudflare");
                    } catch (err: any) {
                      setUploadError("อัปโหลดวิดีโอไม่สำเร็จ: " + err.message);
                    } finally {
                      setUploadingVideo(false);
                    }
                  }}
                />
              </label>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">คีย์ไฟล์เอกสารบน R2 (ไม่บังคับ)</label>
            <div style={{ display: "flex", gap: "10px" }}>
              <input
                type="text"
                placeholder="เช่น handouts/introduction-sheet.pdf"
                value={lessonHandoutKey}
                onChange={(e) => setLessonHandoutKey(e.target.value)}
                className="form-input"
                style={{ flexGrow: 1 }}
              />
              <label className="tech-button-outline" style={{ borderRadius: "0.5rem", padding: "8px 16px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px", height: "fit-content", flexShrink: 0 }}>
                {uploadingHandout ? "กำลังอัปโหลด..." : "อัปโหลด PDF"}
                <input
                  type="file"
                  accept="application/pdf,.zip,.doc,.docx"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      setUploadingHandout(true);
                      setUploadError(null);
                      const key = await uploadFile(file, "handout");
                      setLessonHandoutKey(key);
                    } catch (err: any) {
                      setUploadError("อัปโหลดเอกสารไม่สำเร็จ: " + err.message);
                    } finally {
                      setUploadingHandout(false);
                    }
                  }}
                />
              </label>
            </div>
            <small style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px", display: "block" }}>
              ผู้เรียนจะดาวน์โหลดไฟล์นี้ได้จาก Cloudflare R2
            </small>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "12px" }}>
            <button type="button" onClick={() => setView("curriculum")} className="tech-button-outline" style={{ borderRadius: "1rem" }}>ยกเลิก</button>
            <button type="submit" disabled={actionLoading} className="tech-button-primary" style={{ borderRadius: "1rem" }}>
              {actionLoading ? "กำลังบันทึก..." : "เพิ่มบทเรียน"}
            </button>
          </div>
        </form>
      </div>
    );
  };

  const renderEditLesson = () => {
    if (!editingLesson) return null;

    return (
      <div className="glass-card animate-fade-in" style={{ padding: "32px", border: "1px solid var(--border-subtle)", borderRadius: "1.5rem" }}>
        <button 
          onClick={() => setView("curriculum")} 
          style={{ display: "flex", alignItems: "center", gap: "8px", background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: "14px", fontWeight: "600", marginBottom: "24px" }}
        >
          <ArrowLeft size={16} />
          กลับไปเนื้อหาหลักสูตร
        </button>

        <h3 style={{ fontSize: "24px", display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px", color: "var(--text-primary)" }}>
          <Edit size={24} color="var(--primary)" />
          แก้ไขบทเรียน
        </h3>
        <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginBottom: "24px" }}>
          แก้ไขข้อมูลบทเรียนและไฟล์ที่เกี่ยวข้อง
        </p>

        {modalError && (
          <div style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", color: "var(--danger)", padding: "12px", borderRadius: "1rem", fontSize: "13px", marginBottom: "20px" }}>
            <strong>ข้อผิดพลาด:</strong> {modalError}
          </div>
        )}

        <form onSubmit={handleUpdateLesson} style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div className="form-group">
            <label className="form-label">ชื่อบทเรียน</label>
            <input
              type="text"
              value={editLessonTitle}
              onChange={(e) => setEditLessonTitle(e.target.value)}
              className="form-input"
              required
            />
          </div>

          <div className="form-group" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div>
              <label className="form-label">แหล่งวิดีโอ</label>
              <select
                value={editLessonProvider}
                onChange={(e) => setEditLessonProvider(e.target.value)}
                className="form-input"
                style={{ cursor: "pointer", borderRadius: "1rem" }}
                required
              >
                <option value="cloudflare">Cloudflare Stream</option>
                <option value="youtube">YouTube (ฝังวิดีโอ)</option>
                <option value="vimeo">Vimeo (ฝังวิดีโอ)</option>
              </select>
            </div>

            <div>
              <label className="form-label">ลำดับบทเรียน</label>
              <input
                type="number"
                min={1}
                value={editLessonSortOrder}
                onChange={(e) => setEditLessonSortOrder(Number(e.target.value))}
                className="form-input"
                required
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">รหัสวิดีโอ (Stream UID / Embed ID)</label>
            <div style={{ display: "flex", gap: "10px" }}>
              <input
                type="text"
                value={editLessonStreamUid}
                onChange={(e) => setEditLessonStreamUid(e.target.value)}
                className="form-input"
                style={{ flexGrow: 1 }}
                required
              />
              <label className="tech-button-outline" style={{ borderRadius: "0.5rem", padding: "8px 16px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px", height: "fit-content", flexShrink: 0 }}>
                {uploadingVideo ? (uploadProgress !== null ? `กำลังอัปโหลด ${uploadProgress}%` : "กำลังอัปโหลด...") : "อัปโหลดวิดีโอ"}
                <input
                  type="file"
                  accept="video/*"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      setUploadingVideo(true);
                      setUploadError(null);
                      const key = await uploadFile(file, "video");
                      setEditLessonStreamUid(key);
                      setEditLessonProvider("cloudflare");
                    } catch (err: any) {
                      setUploadError("อัปโหลดวิดีโอไม่สำเร็จ: " + err.message);
                    } finally {
                      setUploadingVideo(false);
                    }
                  }}
                />
              </label>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">คีย์ไฟล์เอกสารบน R2 (ไม่บังคับ)</label>
            <div style={{ display: "flex", gap: "10px" }}>
              <input
                type="text"
                placeholder="เช่น handouts/introduction-sheet.pdf"
                value={editLessonHandoutKey}
                onChange={(e) => setEditLessonHandoutKey(e.target.value)}
                className="form-input"
                style={{ flexGrow: 1 }}
              />
              <label className="tech-button-outline" style={{ borderRadius: "0.5rem", padding: "8px 16px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px", height: "fit-content", flexShrink: 0 }}>
                {uploadingHandout ? "กำลังอัปโหลด..." : "อัปโหลด PDF"}
                <input
                  type="file"
                  accept="application/pdf,.zip,.doc,.docx"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      setUploadingHandout(true);
                      setUploadError(null);
                      const key = await uploadFile(file, "handout");
                      setEditLessonHandoutKey(key);
                    } catch (err: any) {
                      setUploadError("อัปโหลดเอกสารไม่สำเร็จ: " + err.message);
                    } finally {
                      setUploadingHandout(false);
                    }
                  }}
                />
              </label>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "12px" }}>
            <button type="button" onClick={() => setView("curriculum")} className="tech-button-outline" style={{ borderRadius: "1rem" }}>ยกเลิก</button>
            <button type="submit" disabled={actionLoading} className="tech-button-primary" style={{ borderRadius: "1rem" }}>
              {actionLoading ? "กำลังบันทึก..." : "บันทึกการเปลี่ยนแปลง"}
            </button>
          </div>
        </form>
      </div>
    );
  };

  const renderQuizzes = () => {
    if (!selectedLessonForQuizzes) return null;

    return (
      <div className="glass-card animate-fade-in" style={{ padding: "32px", border: "1px solid var(--border-subtle)", borderRadius: "1.5rem" }}>
        <button 
          onClick={() => setView("curriculum")} 
          style={{ display: "flex", alignItems: "center", gap: "8px", background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: "14px", fontWeight: "600", marginBottom: "24px" }}
        >
          <ArrowLeft size={16} />
          กลับไปเนื้อหาหลักสูตร
        </button>

        <h3 style={{ fontSize: "24px", display: "flex", alignItems: "center", gap: "8px", color: "var(--text-primary)", marginBottom: "6px" }}>
          <ClipboardList size={24} color="var(--primary)" />
          สร้างแบบทดสอบฝึกหัด
        </h3>
        <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginBottom: "24px" }}>
          จัดการคำถามแบบเลือกตอบของบทเรียน: <strong style={{ color: "var(--text-primary)" }}>{selectedLessonForQuizzes.title}</strong>
        </p>

        <div className="dashboard-grid">
          
          {/* Left Panel: Existing questions */}
          <div className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "20px", background: "rgba(255,255,255,0.2)" }}>
            <h4 style={{ fontSize: "16px", fontWeight: "700", color: "var(--text-primary)", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "10px" }}>
              แบบทดสอบของบทเรียน ({lessonQuizzes.length})
            </h4>

            {quizzesLoading ? (
              <div style={{ display: "flex", justifyContent: "center", padding: "32px" }}>
                <div className="spinner" style={{ border: "2px solid var(--border-subtle)", borderTop: "2px solid var(--primary)", borderRadius: "50%", width: "28px", height: "28px", animation: "spin 1s linear infinite" }} />
              </div>
            ) : lessonQuizzes.length === 0 ? (
              <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px", border: "1px dashed var(--border-subtle)", borderRadius: "1rem" }}>
                ยังไม่มีคำถามแบบทดสอบในบทเรียนนี้
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                {lessonQuizzes.map((quiz, idx) => {
                  let options = [];
                  try {
                    options = JSON.parse(quiz.options_json);
                  } catch (e) {
                    options = [];
                  }
                  return (
                    <div key={quiz.id} className="glass-card" style={{ padding: "16px", background: "rgba(255, 255, 255, 0.4)", border: "1px solid var(--border-subtle)", borderRadius: "1rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px" }}>
                        <span style={{ fontWeight: "700", color: "var(--text-primary)", fontSize: "14px", lineHeight: "1.4" }}>
                          ข้อ {idx + 1}: {quiz.question}
                        </span>
                        <button 
                          onClick={() => handleDeleteQuiz(quiz.id)}
                          className="tech-button-outline"
                          style={{ padding: "4px 8px", fontSize: "11px", color: "var(--danger)", borderColor: "rgba(239, 68, 68, 0.2)", borderRadius: "0.5rem", flexShrink: 0 }}
                        >
                          ลบ
                        </button>
                      </div>
                      
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "12px" }}>
                        {options.map((opt: string, optIdx: number) => {
                          const isCorrect = optIdx === quiz.correct_option_index;
                          return (
                            <div 
                              key={optIdx} 
                              style={{ 
                                padding: "8px 12px", 
                                background: isCorrect ? "rgba(16, 185, 129, 0.08)" : "rgba(255,255,255,0.4)",
                                border: isCorrect ? "1px solid rgba(16, 185, 129, 0.3)" : "1px solid var(--border-subtle)",
                                color: isCorrect ? "var(--accent)" : "var(--text-secondary)",
                                borderRadius: "8px",
                                fontSize: "12px",
                                display: "flex",
                                alignItems: "center",
                                gap: "6px"
                              }}
                            >
                              <span style={{ fontWeight: "700" }}>{String.fromCharCode(65 + optIdx)}.</span>
                              <span>{opt}</span>
                              {isCorrect && <span style={{ marginLeft: "auto", fontSize: "9px", fontWeight: "800", background: "rgba(16, 185, 129, 0.1)", padding: "2px 4px", borderRadius: "4px" }}>คำตอบที่ถูก</span>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right Panel: Add Form */}
          <div className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <h4 style={{ fontSize: "16px", fontWeight: "700", color: "var(--color-brand-primary)", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "10px" }}>
              เพิ่มคำถามแบบทดสอบใหม่
            </h4>

            <form onSubmit={handleAddQuiz} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div className="form-group">
                <label className="form-label" style={{ fontSize: "12px" }}>คำถาม</label>
                <input
                  type="text"
                  placeholder="เช่น คำสั่งใดใช้เริ่มต้นฐานข้อมูลภายในเครื่องของ wrangler?"
                  value={newQuizQuestion}
                  onChange={(e) => setNewQuizQuestion(e.target.value)}
                  className="form-input"
                  style={{ fontSize: "13px" }}
                  required
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                {newQuizOptions.map((opt, idx) => (
                  <div key={idx} className="form-group">
                    <label className="form-label" style={{ fontSize: "11px" }}>ตัวเลือก {String.fromCharCode(65 + idx)}</label>
                    <input
                      type="text"
                      placeholder={`ตัวเลือก ${String.fromCharCode(65 + idx)}`}
                      value={opt}
                      onChange={(e) => {
                        const updated = [...newQuizOptions];
                        updated[idx] = e.target.value;
                        setNewQuizOptions(updated);
                      }}
                      className="form-input"
                      style={{ fontSize: "12px" }}
                      required
                    />
                  </div>
                ))}
              </div>

              <div className="form-group">
                <label className="form-label" style={{ fontSize: "12px" }}>เลือกคำตอบที่ถูกต้อง</label>
                <select
                  value={newQuizCorrectIndex}
                  onChange={(e) => setNewQuizCorrectIndex(Number(e.target.value))}
                  className="form-input"
                  style={{ fontSize: "13px", cursor: "pointer", borderRadius: "1rem" }}
                  required
                >
                  <option value={0}>ตัวเลือก A</option>
                  <option value={1}>ตัวเลือก B</option>
                  <option value={2}>ตัวเลือก C</option>
                  <option value={3}>ตัวเลือก D</option>
                </select>
              </div>

              <button 
                type="submit" 
                disabled={actionLoading} 
                className="tech-button-primary" 
                style={{ width: "100%", padding: "12px", borderRadius: "1rem", fontSize: "13px", marginTop: "8px" }}
              >
                {actionLoading ? "กำลังเพิ่ม..." : "เพิ่มคำถามในบทเรียน"}
              </button>
            </form>
          </div>

        </div>
      </div>
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

  const renderAccessControl = () => {
    if (!selectedCourseForCurriculum) return null;

    return (
      <div className="glass-card animate-fade-in" style={{ padding: "32px", border: "1px solid var(--border-subtle)", borderRadius: "1.5rem" }}>
        <button 
          onClick={() => {
            setSelectedCourseForCurriculum(null);
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
              <Key size={24} color="var(--primary)" />
              สิทธิ์เข้าถึงและการลงทะเบียนเรียน
            </h3>
            <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginTop: "4px" }}>
              คอร์ส: <strong style={{ color: "var(--text-primary)" }}>{selectedCourseForCurriculum.title}</strong> • กำหนดสิทธิ์เข้าถึงและมอบหมายคอร์สให้ผู้เรียน องค์กร หรือกลุ่มเรียน
            </p>
          </div>
        </div>

        {modalError && (
          <div style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", color: "var(--danger)", padding: "12px", borderRadius: "1rem", fontSize: "13px", marginBottom: "20px" }}>
            <strong>ข้อผิดพลาด:</strong> {modalError}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "32px" }}>
          
          {/* Assignment Section */}
          <div className="glass-card" style={{ padding: "24px", background: "rgba(255, 255, 255, 0.45)", borderRadius: "1.25rem", border: "1px solid var(--border-subtle)" }}>
            <h4 style={{ fontSize: "16px", fontWeight: "700", marginBottom: "16px", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "6px" }}>
              <PlusCircle size={18} color="var(--primary)" />
              มอบสิทธิ์เข้าถึงคอร์ส / จัดสรรที่นั่ง
            </h4>
            
            <form onSubmit={async (e) => {
              e.preventDefault();
              if (!assignTargetId) {
                alert("กรุณาเลือกผู้เรียน พาร์ตเนอร์องค์กร หรือกลุ่มเรียน");
                return;
              }
              try {
                setActionLoading(true);
                setModalError(null);
                
                const res = await api.post<any>(`/instructor/courses/${selectedCourseForCurriculum.id}/assign`, {
                  target_type: assignTargetType,
                  target_id: assignTargetId
                });

                alert(res.message || "มอบสิทธิ์เข้าถึงสำเร็จ");
                await loadAccessControl(selectedCourseForCurriculum.id);
              } catch (err: any) {
                console.error(err);
                setModalError(err.message || "มอบสิทธิ์เข้าถึงคอร์สไม่สำเร็จ");
              } finally {
                setActionLoading(false);
              }
            }} style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
              
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: "20px" }}>
                
                <div className="form-group">
                  <label className="form-label">รูปแบบการมอบหมาย</label>
                  <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "var(--text-primary)", cursor: "pointer" }}>
                      <input
                        type="radio"
                        name="assignTargetType"
                        value="student"
                        checked={assignTargetType === "student"}
                        onChange={() => {
                          setAssignTargetType("student");
                          if (allStudents.length > 0) setAssignTargetId(allStudents[0].id);
                        }}
                      />
                      ผู้เรียนรายบุคคล
                    </label>

                    <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "var(--text-primary)", cursor: "pointer" }}>
                      <input
                        type="radio"
                        name="assignTargetType"
                        value="partner"
                        checked={assignTargetType === "partner"}
                        onChange={() => {
                          setAssignTargetType("partner");
                          if (allPartners.length > 0) setAssignTargetId(allPartners[0].id);
                          else setAssignTargetId("");
                        }}
                      />
                      องค์กร (B2B)
                    </label>

                    <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "var(--text-primary)", cursor: "pointer" }}>
                      <input
                        type="radio"
                        name="assignTargetType"
                        value="group"
                        checked={assignTargetType === "group"}
                        onChange={() => {
                          setAssignTargetType("group");
                          if (groups.length > 0) setAssignTargetId(groups[0].id);
                          else setAssignTargetId("");
                        }}
                      />
                      กลุ่มเรียน
                    </label>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">เลือกผู้รับสิทธิ์</label>
                  {assignTargetType === "student" && (<>
                    <select
                      value={assignTargetId}
                      onChange={(e) => setAssignTargetId(e.target.value)}
                      className="form-input"
                      style={{ borderRadius: "1rem", fontSize: "13px" }}
                      required
                    >
                      {allStudents.map((st) => (
                        <option key={st.id} value={st.id}>{st.name} ({st.email})</option>
                      ))}
                    </select>
                    <StudentEmailLookup onFound={st => { setAllStudents(prev => prev.some(p => p.id === st.id) ? prev : [...prev, st]); setAssignTargetId(st.id); }} />
                  </>)}

                  {assignTargetType === "partner" && (
                    <select
                      value={assignTargetId}
                      onChange={(e) => setAssignTargetId(e.target.value)}
                      className="form-input"
                      style={{ borderRadius: "1rem", fontSize: "13px" }}
                      required
                    >
                      {allPartners.length === 0 ? (
                        <option value="">ยังไม่มีพาร์ตเนอร์องค์กร</option>
                      ) : (
                        allPartners.map((pt) => (
                          <option key={pt.id} value={pt.id}>{pt.company_name} (จัดสรรแล้ว {pt.allocated_seats}/{pt.total_seats} ที่นั่ง)</option>
                        ))
                      )}
                    </select>
                  )}

                  {assignTargetType === "group" && (
                    <select
                      value={assignTargetId}
                      onChange={(e) => setAssignTargetId(e.target.value)}
                      className="form-input"
                      style={{ borderRadius: "1rem", fontSize: "13px" }}
                      required
                    >
                      {groups.length === 0 ? (
                        <option value="">ยังไม่มีกลุ่มเรียน</option>
                      ) : (
                        groups.map((g) => (
                          <option key={g.id} value={g.id}>{g.name} ({g.member_count} คน)</option>
                        ))
                      )}
                    </select>
                  )}
                </div>

              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--border-subtle)", paddingTop: "16px" }}>
                <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                  {selectedCourseForCurriculum.access_duration_days ? (
                    <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <Calendar size={14} /> จะให้สิทธิ์เข้าถึง {selectedCourseForCurriculum.access_duration_days} วัน
                    </span>
                  ) : "จะให้สิทธิ์เข้าถึงตลอดชีพ"}
                </span>
                
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="tech-button-primary"
                  style={{ padding: "10px 24px", borderRadius: "1rem", fontSize: "13px" }}
                >
                  {actionLoading ? "กำลังมอบสิทธิ์..." : "มอบสิทธิ์ / จัดสรรที่นั่ง"}
                </button>
              </div>
            </form>
          </div>

          {/* Active enrollments list */}
          <div className="glass-card" style={{ padding: "24px", background: "rgba(255, 255, 255, 0.45)", borderRadius: "1.25rem", border: "1px solid var(--border-subtle)" }}>
            <h4 style={{ fontSize: "16px", fontWeight: "700", marginBottom: "16px", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "6px" }}>
              <Users size={18} color="var(--primary)" />
              ผู้เรียนที่ลงทะเบียนอยู่
            </h4>
            
            {courseEnrollments.length === 0 ? (
              <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
                ยังไม่มีผู้เรียนลงทะเบียนในคอร์สนี้
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid var(--border-subtle)" }}>
                      <th style={{ padding: "12px", color: "var(--text-secondary)" }}>ชื่อผู้เรียน</th>
                      <th style={{ padding: "12px", color: "var(--text-secondary)" }}>อีเมล</th>
                      <th style={{ padding: "12px", color: "var(--text-secondary)" }}>วันที่ลงทะเบียน</th>
                      <th style={{ padding: "12px", color: "var(--text-secondary)" }}>ความคืบหน้า</th>
                      <th style={{ padding: "12px", color: "var(--text-secondary)" }}>สถานะ</th>
                      <th style={{ padding: "12px", color: "var(--text-secondary)" }}>วันหมดอายุการเข้าถึง</th>
                    </tr>
                  </thead>
                  <tbody>
                    {courseEnrollments.map((enr) => {
                      const isExpired = enr.expires_at ? new Date(enr.expires_at).getTime() < Date.now() : false;
                      return (
                        <tr key={enr.id} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                          <td style={{ padding: "12px", fontWeight: "600" }}>{enr.student_name}</td>
                          <td style={{ padding: "12px", color: "var(--text-secondary)" }}>{enr.student_email}</td>
                          <td style={{ padding: "12px", color: "var(--text-secondary)" }}>
                            {new Date(enr.enrolled_at).toLocaleDateString("th-TH")}
                          </td>
                          <td style={{ padding: "12px", fontWeight: "700", color: "var(--color-brand-primary)" }}>
                            {enr.progress_percent}%
                          </td>
                          <td style={{ padding: "12px" }}>
                            <span className="badge-gamified" style={{
                              backgroundColor: isExpired ? "rgba(239, 68, 68, 0.1)" : "rgba(16, 185, 129, 0.1)",
                              color: isExpired ? "var(--danger)" : "var(--accent)",
                              borderColor: isExpired ? "rgba(239, 68, 68, 0.2)" : "rgba(16, 185, 129, 0.2)",
                              textTransform: "none",
                              fontSize: "11px"
                            }}>
                              {isExpired ? "หมดอายุ" : (ENROLLMENT_STATUS_LABELS[enr.status] || enr.status)}
                            </span>
                          </td>
                          <td style={{ padding: "12px", color: isExpired ? "var(--danger)" : "var(--text-secondary)" }}>
                            {enr.expires_at ? (
                              <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                                {isExpired ? <ShieldAlert size={14} /> : <Calendar size={14} />}
                                {new Date(enr.expires_at).toLocaleDateString("th-TH")}
                              </span>
                            ) : "ตลอดชีพ"}
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

        {uploadError && (
          <div className="alert alert-danger" style={{ marginBottom: "20px", display: "flex", alignItems: "center", gap: "8px", color: "var(--danger)", background: "rgba(239, 68, 68, 0.08)", padding: "12px 16px", borderRadius: "0.75rem" }}>
            <ShieldAlert size={16} />
            <span>{uploadError}</span>
          </div>
        )}

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
      <AnimatePresence mode="wait">
        {view === "dashboard" && (
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
        {view === "edit-course" && (
          <motion.div 
            key="edit-course"
            initial={{ opacity: 0, x: 15 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -15 }}
            transition={{ duration: 0.2 }}
          >
            {renderEditCourse()}
          </motion.div>
        )}
        {view === "curriculum" && (
          <motion.div 
            key="curriculum"
            initial={{ opacity: 0, x: 15 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -15 }}
            transition={{ duration: 0.2 }}
          >
            {renderCurriculum()}
          </motion.div>
        )}
        {view === "create-lesson" && (
          <motion.div 
            key="create-lesson"
            initial={{ opacity: 0, x: 15 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -15 }}
            transition={{ duration: 0.2 }}
          >
            {renderCreateLesson()}
          </motion.div>
        )}
        {view === "edit-lesson" && (
          <motion.div 
            key="edit-lesson"
            initial={{ opacity: 0, x: 15 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -15 }}
            transition={{ duration: 0.2 }}
          >
            {renderEditLesson()}
          </motion.div>
        )}
        {view === "quizzes" && (
          <motion.div 
            key="quizzes"
            initial={{ opacity: 0, x: 15 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -15 }}
            transition={{ duration: 0.2 }}
          >
            {renderQuizzes()}
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
        {view === "access-control" && (
          <motion.div 
            key="access-control"
            initial={{ opacity: 0, x: 15 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -15 }}
            transition={{ duration: 0.2 }}
          >
            {renderAccessControl()}
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

/**
 * Instructors only see learners of their own courses and groups; anyone else is found by exact email.
 */
const StudentEmailLookup: React.FC<{ onFound: (student: { id: string; name: string; email: string }) => void }> = ({ onFound }) => {
  const api = useApi();
  const [email, setEmail] = React.useState("");
  const [message, setMessage] = React.useState<string | null>(null);
  const lookup = async () => {
    if (!email.trim()) return;
    try {
      setMessage(null);
      const found = await api.get<Array<{ id: string; name: string; email: string }>>(`/instructor/students?email=${encodeURIComponent(email.trim())}`);
      if (found.length) { onFound(found[0]); setEmail(""); setMessage(`เลือก ${found[0].name} แล้ว`); }
      else setMessage("ไม่พบผู้เรียนที่ใช้อีเมลนี้");
    } catch (err: any) { setMessage(err.message); }
  };
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
      <input type="email" className="form-input" value={email} onChange={e => setEmail(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); lookup(); } }}
        placeholder="ไม่อยู่ในรายการ? ค้นหาด้วยอีเมล" aria-label="ค้นหาผู้เรียนด้วยอีเมล"
        style={{ flex: "1 1 200px", borderRadius: "1rem", fontSize: "13px" }} />
      <button type="button" className="tech-button-outline" onClick={lookup} style={{ padding: "8px 14px", fontSize: "12px", borderRadius: "1rem" }}>ค้นหา</button>
      {message && <span role="status" style={{ fontSize: 12, color: "var(--text-secondary)" }}>{message}</span>}
    </div>
  );
};
