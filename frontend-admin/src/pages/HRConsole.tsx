import React, { useState, useEffect } from "react";
import { useApi, hasRole } from "../hooks/useApi";
import { MetricsCard } from "../components/MetricsCard";
import { Modal, downloadWithAuth } from "../components/site-admin/ui";
import { motion, AnimatePresence } from "framer-motion";
import { useInterval } from "react-use";
import Confetti from "react-confetti";
import { 
  Users, 
  UserPlus, 
  TrendingUp, 
  Building, 
  HelpCircle,
  AlertTriangle,
  Download,
  UserMinus,
  Mail,
  User,
  PlusCircle,
  FileCheck,
  Briefcase,
  Clock,
  CheckCircle,
  XCircle,
  Send,
  Edit,
  Trash2,
  AlertCircle,
  BookOpen,
  Zap,
  Terminal,
  Flame
} from "lucide-react";

const STATUS_TH: Record<string, string> = {
  open: "เปิดรับสมัคร",
  closed: "ปิดรับสมัคร",
  in_progress: "กำลังดำเนินการ",
  completed: "เสร็จสิ้น",
  cancelled: "ยกเลิก",
  draft: "ฉบับร่าง",
  pending: "รอดำเนินการ",
  applied: "สมัครแล้ว",
  under_review: "กำลังพิจารณา",
  accepted: "รับแล้ว",
  rejected: "ปฏิเสธแล้ว",
  submitted: "ส่งงานแล้ว",
  approved: "อนุมัติแล้ว",
  active: "ใช้งานอยู่",
};
const statusLabel = (v?: string) => (v ? STATUS_TH[v] ?? v : "");
const BUDGET_TYPE_TH: Record<string, string> = { fixed: "เหมาจ่าย", hourly: "รายชั่วโมง" };
const budgetTypeLabel = (v?: string) => (v ? BUDGET_TYPE_TH[v] ?? v : "");
const RISK_TH: Record<string, string> = { Low: "ต่ำ", Medium: "ปานกลาง", High: "สูง" };
const riskLabel = (v?: string) => (v ? RISK_TH[v] ?? v : "");

interface RosterStudent {
  id: string;
  email: string;
  name: string;
  created_at: string;
  status?: "active" | "suspended";
  last_login_at?: string | null;
  courses_enrolled: number;
  avg_progress: number | null;
}

interface AnalyticsData {
  partnerId?: string;
  companyName: string;
  totalSeats: number;
  usedSeats: number;
  activeLearners: number;
  averageCompletionRate: number;
  partnerType?: string;
  roster: RosterStudent[];
}

export const HRConsole: React.FC = () => {
  const api = useApi();
  const [data, setData] = useState<AnalyticsData | null>(null);
  
  // Invite form state
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  // Default: email a set-password link; otherwise HR sets an initial password (12+ characters).
  const [inviteMode, setInviteMode] = useState<"invite" | "password">("invite");
  const [invitePassword, setInvitePassword] = useState("");
  const [rosterNotice, setRosterNotice] = useState<string | null>(null);

  // Remove-from-organization confirmation
  const [removeTarget, setRemoveTarget] = useState<RosterStudent | null>(null);
  const [removeLoading, setRemoveLoading] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  
  // Loading & error
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Tab and Course Assignment states
  const [activeTab, setActiveTab] = useState<"roster" | "courses" | "internships" | "outsource">("roster");

  // Internship states
  const [internshipOpenings, setInternshipOpenings] = useState<any[]>([]);
  const [receivedApplications, setReceivedApplications] = useState<any[]>([]);
  const [universityApplications, setUniversityApplications] = useState<any[]>([]);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [applicationLogs, setApplicationLogs] = useState<any[]>([]);
  const [allCoursesList, setAllCoursesList] = useState<any[]>([]);
  
  // Create opening form
  const [newOpeningTitle, setNewOpeningTitle] = useState("");
  const [newOpeningDesc, setNewOpeningDesc] = useState("");
  const [newOpeningCourseId, setNewOpeningCourseId] = useState("");
  
  // Evaluation state
  const [evalScore, setEvalScore] = useState<string>("85");
  const [evalFeedback, setEvalFeedback] = useState("");
  
  // Coordinator feedback state
  const [univFeedback, setUnivFeedback] = useState("");

  const [internshipLoading, setInternshipLoading] = useState(false);
  const [internshipSuccess, setInternshipSuccess] = useState<string | null>(null);
  const [internshipError, setInternshipError] = useState<string | null>(null);

  // Outsource states
  const [outsourceProjects, setOutsourceProjects] = useState<any[]>([]);
  const [selectedProjId, setSelectedProjId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<any | null>(null);
  const [milestones, setMilestones] = useState<any[]>([]);
  const [outsourceLoading, setOutsourceLoading] = useState(false);
  const [outsourceSuccess, setOutsourceSuccess] = useState<string | null>(null);
  const [outsourceError, setOutsourceError] = useState<string | null>(null);

  // Create project form states
  const [newProjTitle, setNewProjTitle] = useState("");
  const [newProjDesc, setNewProjDesc] = useState("");
  const [newProjSOW, setNewProjSOW] = useState("");
  const [newProjBudgetType, setNewProjBudgetType] = useState<"fixed" | "hourly">("fixed");
  const [newProjBudgetRange, setNewProjBudgetRange] = useState("");
  const [newProjRequiredCourseId, setNewProjRequiredCourseId] = useState("");
  const [newProjMinLevel, setNewProjMinLevel] = useState("1");

  // AI Wizard / Questionnaire states
  const [isAiWizardOpen, setIsAiWizardOpen] = useState(false);
  const [aiWizardStep, setAiWizardStep] = useState(0); // 0: inactive, 1: goal, 2: scope, 3: tech, 4: duration, 5: budget
  const [wizardGoal, setWizardGoal] = useState("");
  const [wizardScope, setWizardScope] = useState("");
  const [wizardTechStack, setWizardTechStack] = useState("");
  const [wizardDuration, setWizardDuration] = useState("");
  const [wizardBudgetType, setWizardBudgetType] = useState<"fixed" | "hourly">("fixed");
  const [wizardBudgetRange, setWizardBudgetRange] = useState("");
  const [aiGeneratingScope, setAiGeneratingScope] = useState(false);
  const [tempDraftTitle, setTempDraftTitle] = useState("");
  const [tempDraftDesc, setTempDraftDesc] = useState("");
  const [tempDraftSOW, setTempDraftSOW] = useState("");
  const [tempDraftBudget, setTempDraftBudget] = useState("");
  const [tempDraftPrereq, setTempDraftPrereq] = useState("");
  const [tempDraftMinLevel, setTempDraftMinLevel] = useState("2");

  // AI PM Audit states
  const [aiAuditLoading, setAiAuditLoading] = useState<{[milestoneId: string]: boolean}>({});
  const [aiAuditResults, setAiAuditResults] = useState<{[milestoneId: string]: any}>({});

  const [loadingPhraseIdx, setLoadingPhraseIdx] = useState(0);
  const loadingPhrases = [
    "AI กำลังวิเคราะห์ขอบเขตโปรเจกต์…",
    "กำลังเลือกทักษะ Edge Agent ที่เหมาะสม…",
    "กำลังร่างขอบเขตงาน (SOW) ฉบับสมบูรณ์…",
    "กำลังปรับงบประมาณให้เหมาะสม…"
  ];

  useInterval(
    () => {
      setLoadingPhraseIdx((idx) => (idx + 1) % loadingPhrases.length);
    },
    aiGeneratingScope ? 2000 : null
  );

  const [showConfetti, setShowConfetti] = useState(false);

  const fetchAppLogsHR = async (appId: string) => {
    try {
      const logs = await api.get<any[]>(`/internships/applications/${appId}/logs`);
      setApplicationLogs(logs);
      
      const app = receivedApplications.find(a => a.id === appId) || universityApplications.find(a => a.id === appId);
      if (app) {
        setUnivFeedback(app.university_feedback || "");
        setEvalScore(app.evaluation_score !== null ? String(app.evaluation_score) : "85");
        setEvalFeedback(app.evaluation_feedback || "");
      }
    } catch (err: any) {
      console.error("Failed to fetch logs:", err);
    }
  };

  const fetchInternshipRecruiterData = async () => {
    try {
      setInternshipLoading(true);
      setInternshipError(null);

      const coursesRes = await api.get<any[]>("/courses");
      setAllCoursesList(coursesRes);
      if (coursesRes.length > 0 && !newOpeningCourseId) {
        setNewOpeningCourseId(coursesRes[0].id);
      }

      if (data?.partnerType === "company") {
        const [openings, apps] = await Promise.all([
          api.get<any[]>("/internships/openings/my"),
          api.get<any[]>("/internships/applications/company")
        ]);
        setInternshipOpenings(openings);
        setReceivedApplications(apps);
        
        if (selectedAppId) {
          await fetchAppLogsHR(selectedAppId);
        } else if (apps.length > 0) {
          setSelectedAppId(apps[0].id);
          const logs = await api.get<any[]>(`/internships/applications/${apps[0].id}/logs`);
          setApplicationLogs(logs);
          setUnivFeedback(apps[0].university_feedback || "");
          setEvalScore(apps[0].evaluation_score !== null ? String(apps[0].evaluation_score) : "85");
          setEvalFeedback(apps[0].evaluation_feedback || "");
        }
      } else if (data?.partnerType === "university") {
        const apps = await api.get<any[]>("/internships/applications/university");
        setUniversityApplications(apps);

        if (selectedAppId) {
          await fetchAppLogsHR(selectedAppId);
        } else if (apps.length > 0) {
          setSelectedAppId(apps[0].id);
          const logs = await api.get<any[]>(`/internships/applications/${apps[0].id}/logs`);
          setApplicationLogs(logs);
          setUnivFeedback(apps[0].university_feedback || "");
          setEvalScore(apps[0].evaluation_score !== null ? String(apps[0].evaluation_score) : "85");
          setEvalFeedback(apps[0].evaluation_feedback || "");
        }
      }
    } catch (err: any) {
      console.error("Failed to fetch HR internship data:", err);
      setInternshipError("โหลดข้อมูลการฝึกงานไม่สำเร็จ: " + err.message);
    } finally {
      setInternshipLoading(false);
    }
  };

  const handleCreateOpening = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newOpeningTitle || !newOpeningDesc || !newOpeningCourseId) {
      setInternshipError("กรุณากรอกข้อมูลตำแหน่งฝึกงานให้ครบถ้วน");
      return;
    }

    try {
      setInternshipLoading(true);
      setInternshipError(null);
      setInternshipSuccess(null);

      await api.post("/internships/openings", {
        title: newOpeningTitle,
        description: newOpeningDesc,
        requiredCourseId: newOpeningCourseId
      });

      setInternshipSuccess("สร้างตำแหน่งฝึกงานเรียบร้อยแล้ว");
      setNewOpeningTitle("");
      setNewOpeningDesc("");
      const [openings, apps] = await Promise.all([
        api.get<any[]>("/internships/openings/my"),
        api.get<any[]>("/internships/applications/company")
      ]);
      setInternshipOpenings(openings);
      setReceivedApplications(apps);
    } catch (err: any) {
      console.error(err);
      setInternshipError(err.error || err.message || "สร้างตำแหน่งฝึกงานไม่สำเร็จ");
    } finally {
      setInternshipLoading(false);
    }
  };

  const handleUpdateAppStatus = async (appId: string, status: string) => {
    try {
      setInternshipLoading(true);
      setInternshipError(null);
      setInternshipSuccess(null);

      const payload: any = { status };
      if (status === "completed") {
        payload.evaluationScore = parseInt(evalScore);
        payload.evaluationFeedback = evalFeedback;
      }

      await api.patch(`/internships/applications/${appId}/status`, payload);
      setInternshipSuccess(`อัปเดตสถานะใบสมัครเป็น "${statusLabel(status)}" แล้ว`);
      await fetchInternshipRecruiterData();
    } catch (err: any) {
      console.error(err);
      setInternshipError(err.error || err.message || "อัปเดตสถานะใบสมัครไม่สำเร็จ");
    } finally {
      setInternshipLoading(false);
    }
  };

  const handleUpdateUnivFeedback = async (appId: string) => {
    try {
      setInternshipLoading(true);
      setInternshipError(null);
      setInternshipSuccess(null);

      await api.patch(`/internships/applications/${appId}/university-feedback`, {
        universityFeedback: univFeedback
      });

      setInternshipSuccess("อัปเดตความเห็นของอาจารย์ผู้ประสานงานเรียบร้อยแล้ว");
      await fetchInternshipRecruiterData();
    } catch (err: any) {
      console.error(err);
      setInternshipError(err.error || err.message || "อัปเดตความเห็นของมหาวิทยาลัยไม่สำเร็จ");
    } finally {
      setInternshipLoading(false);
    }
  };

  const handleApproveLog = async (logId: string, party: "company" | "university", approved: number) => {
    try {
      setInternshipError(null);
      setInternshipSuccess(null);

      const endpoint = party === "company" 
        ? `/internships/logs/${logId}/approve-company`
        : `/internships/logs/${logId}/approve-university`;

      await api.patch(endpoint, { approved });
      setInternshipSuccess(`${approved === 1 ? "อนุมัติ" : "ปฏิเสธ"}บันทึกประจำวันเรียบร้อยแล้ว`);
      
      if (selectedAppId) {
        await fetchAppLogsHR(selectedAppId);
      }
    } catch (err: any) {
      console.error(err);
      setInternshipError(err.error || err.message || "อนุมัติ/ปฏิเสธบันทึกไม่สำเร็จ");
    }
  };
  const [b2bCourses, setB2bCourses] = useState<any[]>([]);
  const [b2bCoursesLoading, setB2bCoursesLoading] = useState(false);
  const [assignStudentId, setAssignStudentId] = useState("");
  const [assignCourseId, setAssignCourseId] = useState("");
  const [assignSuccess, setAssignSuccess] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignLoading, setAssignLoading] = useState(false);

  const fetchB2bCourses = async () => {
    try {
      setB2bCoursesLoading(true);
      const res = await api.get<any[]>("/business/courses");
      setB2bCourses(res);
    } catch (err) {
      console.error("Failed to fetch B2B courses:", err);
    } finally {
      setB2bCoursesLoading(false);
    }
  };

  const handleAssignCourse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assignStudentId || !assignCourseId) {
      setAssignError("กรุณาเลือกทั้งผู้เรียนและคอร์ส");
      return;
    }

    try {
      setAssignLoading(true);
      setAssignError(null);
      setAssignSuccess(null);
      
      const res = await api.post<any>("/business/courses/assign", {
        student_id: assignStudentId,
        course_id: assignCourseId
      });

      setAssignSuccess(res.message || "มอบหมายคอร์สให้ผู้เรียนเรียบร้อยแล้ว");
      setAssignStudentId("");
      setAssignCourseId("");
      
      // Refresh roster data
      await fetchAnalytics();
    } catch (err: any) {
      console.error(err);
      setAssignError(err.message || "มอบหมายคอร์สให้ผู้เรียนไม่สำเร็จ");
    } finally {
      setAssignLoading(false);
    }
  };

  // AI PM Audit execution function
  const handleRunAiPmAudit = async (milestone: any, project: any) => {
    try {
      setAiAuditLoading(prev => ({ ...prev, [milestone.id]: true }));
      const result = await api.post<any>("/outsource/ai-pm-audit", {
        projectTitle: project.title,
        projectDescription: project.description,
        scopeOfWork: project.scope_of_work,
        milestoneTitle: milestone.title,
        milestoneDescription: milestone.description,
        deliverables: milestone.deliverables
      });
      setAiAuditResults(prev => ({ ...prev, [milestone.id]: result }));
    } catch (err: any) {
      console.error("AI PM Audit execution failed:", err);
      alert("เรียกใช้การตรวจสอบโดย AI PM ไม่สำเร็จ: " + err.message);
    } finally {
      setAiAuditLoading(prev => ({ ...prev, [milestone.id]: false }));
    }
  };

  // AI Scope Generator questionnaire runner
  const handleRunAiScopeGenerator = async () => {
    try {
      setAiGeneratingScope(true);
      setOutsourceError(null);
      setOutsourceSuccess(null);

      const draft = await api.post<any>("/outsource/ai-scope-generator", {
        goal: wizardGoal,
        scope: wizardScope,
        techStack: wizardTechStack,
        duration: wizardDuration,
        budgetType: wizardBudgetType,
        budgetRange: wizardBudgetRange
      });

      // Set temporary draft variables for step 6 editing
      setTempDraftTitle(draft.title || `พัฒนาโปรเจกต์ ${wizardTechStack}`);
      setTempDraftDesc(draft.description || `ดำเนินการ: ${wizardGoal}`);
      setTempDraftSOW(draft.scopeOfWork || "");
      setTempDraftBudget(draft.suggestedBudget || wizardBudgetRange || "");
      setTempDraftPrereq(draft.recommendedCourseId || "");
      setTempDraftMinLevel(String(draft.minLevel || 2));

      setAiWizardStep(6); // Go to step 6 (Edit & Confirm)
    } catch (err: any) {
      console.error("AI Scope Generation failed:", err);
      setOutsourceError("AI สร้างขอบเขตงานไม่สำเร็จ: " + err.message);
      setAiWizardStep(5);
    } finally {
      setAiGeneratingScope(false);
    }
  };

  const handleConfirmAiDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Temporarily overwrite newProj states to sync with main form
    setNewProjTitle(tempDraftTitle);
    setNewProjDesc(tempDraftDesc);
    setNewProjSOW(tempDraftSOW);
    setNewProjBudgetType(wizardBudgetType);
    setNewProjBudgetRange(tempDraftBudget);
    setNewProjRequiredCourseId(tempDraftPrereq);
    setNewProjMinLevel(tempDraftMinLevel);
    
    try {
      setOutsourceLoading(true);
      setOutsourceError(null);
      setOutsourceSuccess(null);

      await api.post("/outsource/projects", {
        title: tempDraftTitle,
        description: tempDraftDesc,
        scopeOfWork: tempDraftSOW,
        budgetType: wizardBudgetType,
        budgetRange: tempDraftBudget,
        requiredCourseId: tempDraftPrereq || null,
        minLevel: parseInt(tempDraftMinLevel) || 1
      });

      setOutsourceSuccess("ประกาศโปรเจกต์ IT Outsource ผ่าน AI เรียบร้อยแล้ว");
      setShowConfetti(true);
      fetchOutsourceData();
      setIsAiWizardOpen(false);
      setAiWizardStep(0);
      
      // Clear AI wizard state
      setWizardGoal("");
      setWizardScope("");
      setWizardTechStack("");
      setWizardDuration("");
      setWizardBudgetRange("");
      
      await fetchOutsourceData();
    } catch (err: any) {
      console.error(err);
      setOutsourceError(err.error || err.message || "สร้างโปรเจกต์ไม่สำเร็จ");
    } finally {
      setOutsourceLoading(false);
    }
  };

  const fetchProjectCandidates = async (projectId: string) => {
    try {
      const candidatesRes = await api.get<any[]>(`/outsource/projects/${projectId}/candidates`);
      setCandidates(candidatesRes);

      // If we have a selected candidate or accepted bid, refresh their milestones
      const activeCandidate = candidatesRes.find(c => c.status === "accepted");
      if (activeCandidate) {
        const milestonesRes = await api.get<any[]>(`/outsource/applications/${activeCandidate.id}/milestones`);
        setMilestones(milestonesRes);
      } else {
        setMilestones([]);
      }
    } catch (err: any) {
      console.error("Failed to fetch project candidates:", err);
    }
  };

  const fetchOutsourceData = async () => {
    try {
      setOutsourceLoading(true);
      setOutsourceError(null);

      // Fetch all projects
      const projList = await api.get<any[]>("/outsource/projects");
      
      // Filter projects that belong to this partner or show all if admin
      const filtered = projList.filter((p: any) => p.companyName === data?.companyName || api.user?.role === "admin");
      setOutsourceProjects(filtered);

      // Fetch courses list if not already fetched
      if (allCoursesList.length === 0) {
        const coursesRes = await api.get<any[]>("/courses");
        setAllCoursesList(coursesRes);
        if (coursesRes.length > 0 && !newProjRequiredCourseId) {
          setNewProjRequiredCourseId(coursesRes[0].id);
        }
      }

      if (selectedProjId) {
        await fetchProjectCandidates(selectedProjId);
      }
    } catch (err: any) {
      console.error("Failed to fetch outsource projects:", err);
      setOutsourceError("โหลดรายการโปรเจกต์ไม่สำเร็จ: " + err.message);
    } finally {
      setOutsourceLoading(false);
    }
  };

  const handleSelectProject = async (projectId: string) => {
    setSelectedProjId(projectId);
    setSelectedCandidate(null);
    setMilestones([]);
    
    try {
      setOutsourceLoading(true);
      await fetchProjectCandidates(projectId);
    } finally {
      setOutsourceLoading(false);
    }
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjTitle || !newProjDesc || !newProjSOW || !newProjBudgetRange) {
      setOutsourceError("กรุณากรอกข้อมูลโปรเจกต์ให้ครบถ้วน");
      return;
    }

    try {
      setOutsourceLoading(true);
      setOutsourceError(null);
      setOutsourceSuccess(null);

      await api.post("/outsource/projects", {
        title: newProjTitle,
        description: newProjDesc,
        scopeOfWork: newProjSOW,
        budgetType: newProjBudgetType,
        budgetRange: newProjBudgetRange,
        requiredCourseId: newProjRequiredCourseId || null,
        minLevel: parseInt(newProjMinLevel) || 1
      });

      setOutsourceSuccess("ประกาศโปรเจกต์ IT Outsource เรียบร้อยแล้ว");
      setNewProjTitle("");
      setNewProjDesc("");
      setNewProjSOW("");
      setNewProjBudgetRange("");
      setNewProjMinLevel("1");

      await fetchOutsourceData();
    } catch (err: any) {
      console.error(err);
      setOutsourceError(err.error || err.message || "สร้างโปรเจกต์ไม่สำเร็จ");
    } finally {
      setOutsourceLoading(false);
    }
  };

  const handleAcceptBid = async (appId: string) => {
    if (!window.confirm("คุณแน่ใจหรือไม่ว่าต้องการรับผู้สมัครรายนี้? ข้อเสนอรายอื่นจะถูกปฏิเสธโดยอัตโนมัติ และโปรเจกต์จะเริ่มดำเนินการ")) {
      return;
    }

    try {
      setOutsourceLoading(true);
      setOutsourceError(null);
      setOutsourceSuccess(null);

      await api.post(`/outsource/applications/${appId}/accept`, {});
      setOutsourceSuccess("รับผู้สมัครเรียบร้อยแล้ว โปรเจกต์เริ่มดำเนินการ");
      
      if (selectedProjId) {
        await fetchProjectCandidates(selectedProjId);
        await fetchOutsourceData();
      }
    } catch (err: any) {
      console.error(err);
      setOutsourceError(err.error || err.message || "รับผู้สมัครไม่สำเร็จ");
    } finally {
      setOutsourceLoading(false);
    }
  };

  const handleApproveMilestone = async (milestoneId: string) => {
    try {
      setOutsourceLoading(true);
      setOutsourceError(null);
      setOutsourceSuccess(null);

      await api.post(`/outsource/milestones/${milestoneId}/approve`, {});
      setOutsourceSuccess("อนุมัติงวดงานแล้ว ผู้เรียนได้รับรางวัล +200 EXP");
      
      if (selectedProjId) {
        await fetchProjectCandidates(selectedProjId);
      }
    } catch (err: any) {
      console.error(err);
      setOutsourceError(err.error || err.message || "อนุมัติงวดงานไม่สำเร็จ");
    } finally {
      setOutsourceLoading(false);
    }
  };

  const fetchAnalytics = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.get<AnalyticsData>("/corporate/analytics");
      setData(res);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "โหลดข้อมูลวิเคราะห์ขององค์กรไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (hasRole(api.user, "hr", "partner", "admin")) {
      fetchAnalytics();
      fetchB2bCourses();
    }
  }, [api.token]); // Re-fetch on token/login changes

  useEffect(() => {
    if (activeTab === "internships" && data) {
      fetchInternshipRecruiterData();
    }
    if (activeTab === "outsource" && data) {
      fetchOutsourceData();
    }
  }, [activeTab, data?.partnerType, data?.companyName]);

  const handleInviteStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteName || !inviteEmail) {
      setInviteError("กรุณากรอกชื่อและอีเมล");
      return;
    }
    if (inviteMode === "password" && invitePassword.length < 12) {
      setInviteError("รหัสผ่านเริ่มต้นต้องยาวอย่างน้อย 12 ตัวอักษร");
      return;
    }

    try {
      setActionLoading(true);
      setInviteError(null);
      
      const res = await api.post<{ message: string }>("/corporate/roster", {
        name: inviteName,
        email: inviteEmail,
        // Admins viewing an organization add to that organization; partners are always bound to their own.
        partner_id: data?.partnerId,
        ...(inviteMode === "invite" ? { invite: true } : { password: invitePassword })
      });

      // Clear fields and modal
      setInviteName("");
      setInviteEmail("");
      setInvitePassword("");
      setShowInviteModal(false);
      setRosterNotice(res.message);

      // Re-fetch analytics immediately
      await fetchAnalytics();
    } catch (err: any) {
      console.error(err);
      setInviteError(err.message || "ส่งคำเชิญไม่สำเร็จ กรุณาตรวจสอบจำนวนที่นั่งคงเหลือ");
    } finally {
      setActionLoading(false);
    }
  };

  const handleRemoveEmployee = async () => {
    if (!removeTarget) return;
    try {
      setRemoveLoading(true);
      setRemoveError(null);
      const res = await api.post<{ message: string; suspended_enrollments: number }>(`/business/employees/${removeTarget.id}/remove`, {});
      setRosterNotice(`${removeTarget.name}: ${res.message}` +
        (res.suspended_enrollments ? ` (ระงับคอร์สที่องค์กรสนับสนุน ${res.suspended_enrollments} คอร์ส)` : ""));
      setRemoveTarget(null);
      await fetchAnalytics();
    } catch (err: any) {
      setRemoveError(err.message || "นำพนักงานออกจากองค์กรไม่สำเร็จ");
    } finally {
      setRemoveLoading(false);
    }
  };

  const handleExportRoster = async () => {
    try {
      setExportLoading(true);
      setError(null);
      const query = api.user?.role === "admin" && data?.partnerId ? `?partner_id=${encodeURIComponent(data.partnerId)}` : "";
      await downloadWithAuth(`/business/export.csv${query}`, api.token, `employees-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err: any) {
      setError(err.message || "ส่งออกรายชื่อไม่สำเร็จ");
    } finally {
      setExportLoading(false);
    }
  };

  if (!hasRole(api.user, "hr", "partner", "admin")) {
    return (
      <div className="glass-card animate-fade-in" style={{ padding: "40px", textAlign: "center", borderLeft: "4px solid var(--danger)" }}>
        <AlertTriangle size={48} color="var(--danger)" style={{ marginBottom: "16px", marginLeft: "auto", marginRight: "auto" }} />
        <h2 style={{ color: "var(--text-primary)" }}>ไม่มีสิทธิ์เข้าถึง</h2>
        <p style={{ color: "var(--text-secondary)", marginTop: "8px", maxWidth: "500px", marginLeft: "auto", marginRight: "auto" }}>
          หน้านี้สำหรับบัญชีพาร์ตเนอร์และผู้ดูแลระบบเท่านั้น กรุณาเข้าสู่ระบบด้วยบัญชีที่ได้รับอนุญาตเพื่อดำเนินการต่อ
        </p>
      </div>
    );
  }

  // Radial Ring SVG Calculations
  const radius = 50;
  const strokeWidth = 10;
  const circumference = 2 * Math.PI * radius;
  const usedSeats = data?.usedSeats || 0;
  const totalSeats = data?.totalSeats || 1;
  const seatFraction = usedSeats / totalSeats;
  const strokeDashoffset = circumference * (1 - seatFraction);

  return (
    <div>
      <div className="header-row">
        <div>
          <h1 className="header-title">คอนโซลผู้ดูแลองค์กร</h1>
          <p className="header-desc">
            <Building size={14} style={{ display: "inline", marginRight: "6px", verticalAlign: "middle" }} />
            องค์กร: {data?.companyName || "กำลังโหลด…"}
          </p>
        </div>

        <div style={{ display: "flex", gap: "12px" }}>
          <button 
            onClick={fetchAnalytics}
            className="tech-button-outline"
            style={{ padding: "8px 16px", borderRadius: "1rem" }}
          >
            ซิงก์ข้อมูล
          </button>

          <button
            onClick={handleExportRoster}
            disabled={exportLoading || !data}
            className="tech-button-outline"
            style={{ padding: "8px 16px", borderRadius: "1rem" }}
            title="รายชื่อพนักงานและความคืบหน้ารายคอร์ส (เปิดด้วย Excel ได้)"
          >
            <Download size={16} />
            {exportLoading ? "กำลังส่งออก…" : "ส่งออก CSV"}
          </button>
          
          <button
            onClick={() => {
              setInviteError(null);
              setShowInviteModal(true);
            }}
            className="tech-button-primary"
            style={{ borderRadius: "1rem" }}
          >
            <UserPlus size={18} />
            เพิ่มที่นั่งใหม่
          </button>
        </div>
      </div>

      {error && (
        <div className="glass-card" style={{ borderLeft: "4px solid var(--danger)", background: "rgba(239, 68, 68, 0.08)", color: "var(--danger)", padding: "16px", marginBottom: "24px" }}>
          <strong>ระบบขัดข้อง:</strong> {error}
        </div>
      )}

      {rosterNotice && (
        <div role="status" className="glass-card" style={{ borderLeft: "4px solid var(--accent)", background: "rgba(16, 185, 129, 0.08)", color: "var(--accent)", padding: "16px", marginBottom: "24px", display: "flex", justifyContent: "space-between", gap: "12px" }}>
          <span>{rosterNotice}</span>
          <button onClick={() => setRosterNotice(null)} aria-label="ปิด" style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>
            <XCircle size={16} />
          </button>
        </div>
      )}

      {loading && !data ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "64px" }}>
          <div className="spinner" style={{ border: "3px solid var(--border-subtle)", borderTop: "3px solid var(--primary)", borderRadius: "50%", width: "40px", height: "40px", animation: "spin 1s linear infinite" }} />
        </div>
      ) : data ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
          
          {/* Sub-view Navigation Menu */}
          <div style={{ display: "flex", gap: "12px", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "12px" }}>
            <button
              onClick={() => setActiveTab("roster")}
              className={activeTab === "roster" ? "tech-button-primary" : "tech-button-outline"}
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
              รายชื่อผู้เรียน
            </button>
            <button
              onClick={() => {
                setActiveTab("courses");
                fetchB2bCourses();
              }}
              className={activeTab === "courses" ? "tech-button-primary" : "tech-button-outline"}
              style={{
                borderRadius: "1rem",
                padding: "8px 16px",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                cursor: "pointer"
              }}
            >
              <FileCheck size={16} />
              การมอบหมายคอร์ส
            </button>
            <button
              onClick={() => {
                setActiveTab("internships");
                fetchInternshipRecruiterData();
              }}
              className={activeTab === "internships" ? "tech-button-primary" : "tech-button-outline"}
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
              จัดการฝึกงาน
            </button>
            <button
              onClick={() => {
                setActiveTab("outsource");
                fetchOutsourceData();
              }}
              className={activeTab === "outsource" ? "tech-button-primary" : "tech-button-outline"}
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
              จับคู่งาน IT Outsource
            </button>
          </div>

          {activeTab === "roster" ? (
            <>
              {/* Top Row: KPI widgets */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "24px" }}>
                <MetricsCard
                  title="การใช้ที่นั่ง"
                  value={`${data.usedSeats} / ${data.totalSeats}`}
                  subValue={`เหลือที่นั่งว่าง ${data.totalSeats - data.usedSeats} ที่นั่ง`}
                  icon="Users"
                  color="blue"
                  progress={{ current: data.usedSeats, total: data.totalSeats }}
                />
                
                <MetricsCard
                  title="ผู้เรียนที่ใช้งานอยู่"
                  value={data.activeLearners}
                  subValue="ผู้เรียนที่มีข้อมูลการใช้งาน"
                  icon="TrendingUp"
                  color="accent"
                />

                <MetricsCard
                  title="ความคืบหน้าเฉลี่ยของกลุ่มเรียน"
                  value={`${data.averageCompletionRate}%`}
                  subValue="ความคืบหน้าเนื้อหาหลักสูตรรวม"
                  icon="FileCheck"
                  color="purple"
                />
              </div>

              {/* Middle Section: Radial Chart & Course bar charts */}
              <div className="dashboard-grid">
                
                {/* Left Box: SVG visualizer charts */}
                <div className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
                  <h3 style={{ fontSize: "18px", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
                    <TrendingUp size={18} color="var(--primary)" />
                    สถิติผลการเรียนของกลุ่มเรียน
                  </h3>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px", alignItems: "center" }}>
                    
                    {/* SVG Radial seat utilization ring */}
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "16px", background: "rgba(0,0,0,0.02)", borderRadius: "1.5rem", border: "1px solid var(--border-subtle)" }}>
                      <span style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: "600", textTransform: "uppercase", marginBottom: "16px" }}>
                        สัดส่วนการจัดสรรที่นั่ง
                      </span>
                      
                      <div style={{ position: "relative", width: "140px", height: "140px" }}>
                        <svg width="100%" height="100%" viewBox="0 0 120 120" style={{ transform: "rotate(-90deg)" }}>
                          {/* Background circle */}
                          <circle
                            cx="60"
                            cy="60"
                            r={radius}
                            fill="transparent"
                            stroke="rgba(0, 0, 0, 0.05)"
                            strokeWidth={strokeWidth}
                          />
                          {/* Foreground indicator path */}
                          <circle
                            cx="60"
                            cy="60"
                            r={radius}
                            fill="transparent"
                            stroke="url(#brandGradient)"
                            strokeWidth={strokeWidth}
                            strokeDasharray={circumference}
                            strokeDashoffset={strokeDashoffset}
                            strokeLinecap="round"
                            style={{ transition: "stroke-dashoffset 0.8s ease-out" }}
                          />
                          <defs>
                            <linearGradient id="brandGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                              <stop offset="0%" stopColor="var(--primary)" />
                              <stop offset="100%" stopColor="var(--secondary)" />
                            </linearGradient>
                          </defs>
                        </svg>

                        {/* Centered metrics HUD */}
                        <div style={{ position: "absolute", inset: "0", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center" }}>
                          <span style={{ fontSize: "20px", fontWeight: "800", color: "var(--text-primary)", fontFamily: "Anuphan, sans-serif" }}>
                            {data.usedSeats}/{data.totalSeats}
                          </span>
                          <span style={{ fontSize: "9px", color: "var(--text-secondary)", fontWeight: "600", textTransform: "uppercase" }}>
                            ที่นั่งที่ใช้แล้ว
                          </span>
                        </div>
                      </div>

                      <p style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "16px", textAlign: "center" }}>
                        ลงทะเบียนแล้ว {Math.round(seatFraction * 100)}% ของสิทธิ์การใช้งานองค์กรที่ซื้อไว้
                      </p>
                    </div>

                    {/* SVG Course completion progress bars */}
                    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                      <span style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: "600", textTransform: "uppercase" }}>
                        การกระจายความเชี่ยวชาญเนื้อหาหลักสูตร
                      </span>

                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "6px" }}>
                          <span style={{ color: "var(--text-primary)", fontWeight: "500" }}>Cloudflare Workers</span>
                          <span style={{ color: "var(--primary)", fontWeight: "600" }}>49.5%</span>
                        </div>
                        <div className="progress-bar-container">
                          <div className="progress-bar-fill progress-bar-blue" style={{ width: "49.5%" }} />
                        </div>
                      </div>

                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "6px" }}>
                          <span style={{ color: "var(--text-primary)", fontWeight: "500" }}>D1 & R2 Datastores</span>
                          <span style={{ color: "var(--accent)", fontWeight: "600" }}>100%</span>
                        </div>
                        <div className="progress-bar-container">
                          <div className="progress-bar-fill progress-bar-accent" style={{ width: "100%" }} />
                        </div>
                      </div>

                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "6px" }}>
                          <span style={{ color: "var(--text-primary)", fontWeight: "500" }}>CF Stream Security</span>
                          <span style={{ color: "var(--secondary)", fontWeight: "600" }}>0%</span>
                        </div>
                        <div className="progress-bar-container">
                          <div className="progress-bar-fill progress-bar-purple" style={{ width: "0%" }} />
                        </div>
                      </div>
                    </div>

                  </div>
                </div>

                {/* Right Box: Quick seat facts */}
                <div className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <h3 style={{ fontSize: "16px", color: "var(--text-primary)" }}>การตรวจสอบขอบเขตสิทธิ์การใช้งาน</h3>
                  <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: "1.6" }}>
                    การเพิ่มรายชื่อพนักงานจำกัดตามโควตาที่นั่งที่สั่งซื้อ ระบบฐานข้อมูล D1 จะตรวจสอบจำนวนที่นั่งก่อนเพิ่มผู้ใช้ทุกครั้ง และส่งรหัสข้อผิดพลาดกลับทันทีเพื่อป้องกันการเพิ่มเกินโควตา
                  </p>
                  
                  <div style={{ background: "rgba(229,107,37,0.06)", border: "1px solid rgba(229,107,37,0.2)", borderRadius: "1rem", padding: "12px", display: "flex", gap: "10px", alignItems: "start" }}>
                    <AlertTriangle size={18} color="var(--primary)" style={{ flexShrink: 0, marginTop: "2px" }} />
                    <div>
                      <h5 style={{ fontSize: "13px", color: "var(--primary)", fontWeight: "600" }}>การป้องกันเกินโควตาอัตโนมัติ</h5>
                      <p style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "2px" }}>
                        เมื่อที่นั่งที่ลงทะเบียนครบ {data.totalSeats}/{data.totalSeats} ระบบจะปฏิเสธการเพิ่มรายชื่อด้วยรหัส 400
                      </p>
                    </div>
                  </div>
                </div>

              </div>

              {/* Bottom Roster List */}
              <div className="glass-card">
                <h3 style={{ fontSize: "18px", color: "var(--text-primary)", marginBottom: "20px", display: "flex", alignItems: "center", gap: "8px" }}>
                  <Users size={20} color="var(--primary)" />
                  รายชื่อผู้เรียนที่ลงทะเบียน
                </h3>

                {data.roster.length === 0 ? (
                  <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)" }}>
                    ยังไม่มีผู้เรียนในรายชื่อองค์กรของคุณ คลิก "เพิ่มที่นั่งใหม่" เพื่อเชิญ
                  </div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "14px" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--border-subtle)", color: "var(--text-muted)", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                          <th style={{ padding: "12px 16px" }}>ชื่อ</th>
                          <th style={{ padding: "12px 16px" }}>อีเมล</th>
                          <th style={{ padding: "12px 16px" }}>คอร์สที่ลงทะเบียน</th>
                          <th style={{ padding: "12px 16px" }}>ความคืบหน้าเฉลี่ย</th>
                          <th style={{ padding: "12px 16px" }}>วันที่ลงทะเบียน</th>
                          <th style={{ padding: "12px 16px" }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.roster.map((student) => (
                          <tr 
                            key={student.id} 
                            style={{ borderBottom: "1px solid var(--border-subtle)", transition: "var(--transition-fast)" }}
                            className="table-row-hover"
                          >
                            <td style={{ padding: "16px", fontWeight: "600", color: "var(--text-primary)" }}>{student.name}</td>
                            <td style={{ padding: "16px", color: "var(--text-secondary)" }}>{student.email}</td>
                            <td style={{ padding: "16px", color: "var(--text-primary)" }}>
                              <span className="badge-gamified" style={{ textTransform: "none", fontSize: "12px" }}>
                                {student.courses_enrolled} คอร์ส
                              </span>
                            </td>
                            <td style={{ padding: "16px" }}>
                              {student.avg_progress !== null ? (
                                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                  <div className="progress-bar-container" style={{ width: "80px", height: "4px" }}>
                                    <div 
                                      className="progress-bar-fill progress-bar-blue" 
                                      style={{ width: `${student.avg_progress}%` }}
                                    />
                                  </div>
                                  <span style={{ fontWeight: "600", fontSize: "12px", color: "var(--primary)" }}>
                                    {Math.round(student.avg_progress)}%
                                  </span>
                                </div>
                              ) : (
                                <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>ยังไม่มีกิจกรรม</span>
                              )}
                            </td>
                            <td style={{ padding: "16px", color: "var(--text-muted)", fontSize: "12px" }}>
                              {new Date(student.created_at).toLocaleDateString("th-TH")}
                            </td>
                            <td style={{ padding: "16px", textAlign: "right" }}>
                              <button
                                onClick={() => { setRemoveError(null); setRemoveTarget(student); }}
                                className="tech-button-outline"
                                style={{ padding: "6px 12px", borderRadius: "1rem", fontSize: "12px", color: "var(--danger)", whiteSpace: "nowrap" }}
                              >
                                <UserMinus size={14} />
                                นำออกจากองค์กร
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          ) : activeTab === "courses" ? (
            /* Course Allocations panel code */
            <div className="dashboard-grid">
              {/* Left Column: Course Assignment Form */}
              <div className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                <h3 style={{ fontSize: "18px", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
                  <FileCheck size={20} color="var(--primary)" />
                  มอบหมายคอร์สให้ผู้เรียน
                </h3>
                <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: "1.5" }}>
                  เลือกผู้เรียนจากรายชื่อที่ลงทะเบียนและมอบหมายคอร์สที่องค์กรสนับสนุน คอร์สนี้จะแสดงในแดชบอร์ดของผู้เรียนภายใต้ "การเรียนของฉัน" ทันที
                </p>

                {assignSuccess && (
                  <div style={{ 
                    background: "rgba(16, 185, 129, 0.08)", 
                    border: "1px solid rgba(16, 185, 129, 0.2)", 
                    color: "var(--accent)", 
                    padding: "12px", 
                    borderRadius: "1rem", 
                    fontSize: "13px" 
                  }}>
                    <strong>สำเร็จ:</strong> {assignSuccess}
                  </div>
                )}

                {assignError && (
                  <div style={{ 
                    background: "rgba(239, 68, 68, 0.08)", 
                    border: "1px solid rgba(239, 68, 68, 0.2)", 
                    color: "var(--danger)", 
                    padding: "12px", 
                    borderRadius: "1rem", 
                    fontSize: "13px" 
                  }}>
                    <strong>ข้อผิดพลาด:</strong> {assignError}
                  </div>
                )}

                <form onSubmit={handleAssignCourse} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <div className="form-group">
                    <label className="form-label" style={{ fontWeight: "600", fontSize: "13px", color: "var(--text-primary)", display: "block", marginBottom: "6px" }}>
                      เลือกผู้เรียน
                    </label>
                    <select
                      value={assignStudentId}
                      onChange={(e) => setAssignStudentId(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "10px 14px",
                        borderRadius: "1rem",
                        border: "1px solid var(--border-subtle)",
                        backgroundColor: "#fff",
                        color: "var(--text-primary)",
                        fontSize: "14px",
                        outline: "none"
                      }}
                    >
                      <option value="">-- เลือกผู้เรียนจากรายชื่อ --</option>
                      {data.roster.map(s => (
                        <option key={s.id} value={s.id}>{s.name} ({s.email})</option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label className="form-label" style={{ fontWeight: "600", fontSize: "13px", color: "var(--text-primary)", display: "block", marginBottom: "6px" }}>
                      เลือกคอร์สที่องค์กรสนับสนุน
                    </label>
                    <select
                      value={assignCourseId}
                      onChange={(e) => setAssignCourseId(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "10px 14px",
                        borderRadius: "1rem",
                        border: "1px solid var(--border-subtle)",
                        backgroundColor: "#fff",
                        color: "var(--text-primary)",
                        fontSize: "14px",
                        outline: "none"
                      }}
                    >
                      <option value="">-- เลือกคอร์สที่องค์กรสนับสนุน --</option>
                      {b2bCourses.filter(c => c.is_sponsored === 1).map(c => (
                        <option key={c.id} value={c.id}>{c.title}</option>
                      ))}
                    </select>
                  </div>

                  <button
                    type="submit"
                    disabled={assignLoading || b2bCoursesLoading}
                    className="tech-button-primary"
                    style={{ borderRadius: "1rem", padding: "12px", width: "100%", justifyContent: "center", cursor: "pointer" }}
                  >
                    {assignLoading ? "กำลังมอบหมายสิทธิ์…" : "มอบหมายสิทธิ์เข้าเรียน"}
                  </button>
                </form>
              </div>

              {/* Right Column: Sponsored Catalogue Overview */}
              <div className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                <h3 style={{ fontSize: "18px", color: "var(--text-primary)" }}>
                  แคตตาล็อกคอร์สที่องค์กรสนับสนุน
                </h3>
                <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: "1.5" }}>
                  ด้านล่างคือสถานะคอร์สที่องค์กรของคุณซื้อไว้ ผู้เรียนลงทะเบียนได้เฉพาะคอร์สที่ระบุว่า <strong style={{ color: "var(--primary)" }}>องค์กรสนับสนุน</strong> เท่านั้น
                </p>

                {b2bCoursesLoading ? (
                  <div style={{ display: "flex", justifyContent: "center", padding: "32px" }}>
                    <div className="spinner" style={{ border: "3px solid var(--border-subtle)", borderTop: "3px solid var(--primary)", borderRadius: "50%", width: "24px", height: "24px", animation: "spin 1s linear infinite" }} />
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxHeight: "400px", overflowY: "auto", paddingRight: "4px" }}>
                    {b2bCourses.map((course) => (
                      <div 
                        key={course.id} 
                        style={{ 
                          padding: "14px 18px", 
                          background: course.is_sponsored ? "linear-gradient(135deg, rgba(229,107,37,0.03) 0%, rgba(168,85,247,0.03) 100%)" : "rgba(0,0,0,0.02)", 
                          border: `1px solid ${course.is_sponsored ? "rgba(229,107,37,0.2)" : "var(--border-subtle)"}`, 
                          borderRadius: "1rem",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center"
                        }}
                      >
                        <div>
                          <h4 style={{ fontSize: "14px", color: "var(--text-primary)" }}>{course.title}</h4>
                          <p style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "2px" }}>ราคาในแคตตาล็อก: ฿{Number(course.price).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                        </div>
                        {course.is_sponsored ? (
                          <span className="badge-gamified" style={{ backgroundColor: "var(--primary-glow)", color: "var(--primary)", borderColor: "rgba(229,107,37,0.3)", padding: "4px 10px" }}>
                            องค์กรสนับสนุน
                          </span>
                        ) : (
                          <span className="badge-gamified" style={{ backgroundColor: "rgba(0,0,0,0.05)", color: "var(--text-muted)", borderColor: "transparent", padding: "4px 10px" }}>
                            ยังไม่ได้ซื้อ
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {activeTab === "outsource" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: "32px", alignItems: "start" }} className="outsource-grid-responsive">
              <style>{`
                @media (max-width: 1024px) {
                  .outsource-grid-responsive {
                    grid-template-columns: 1fr !important;
                  }
                }
              `}</style>

              {/* Left Column: Post project and Project list */}
              <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
                
                {/* Post Project Form */}
                <div className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
                    <h3 style={{ fontSize: "18px", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "8px", margin: 0 }}>
                      <PlusCircle size={20} color="var(--primary)" />
                      ประกาศความต้องการโปรเจกต์ IT
                    </h3>
                    <button
                      type="button"
                      onClick={() => {
                        setIsAiWizardOpen(true);
                        setAiWizardStep(1);
                      }}
                      className="tech-button-outline"
                      style={{ padding: "6px 12px", borderRadius: "1rem", display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px" }}
                    >
                      <Zap size={12} color="var(--accent)" />
                      แบบสอบถาม AI PM
                    </button>
                  </div>
                  <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: "1.5" }}>
                    ประกาศขอบเขตและความต้องการของโปรเจกต์เพื่อจับคู่กับผู้เรียนที่มีความสามารถสูงในคอมมิวนิตี้
                  </p>

                  {outsourceSuccess && (
                    <div style={{ 
                      background: "rgba(16, 185, 129, 0.08)", 
                      border: "1px solid rgba(16, 185, 129, 0.2)", 
                      color: "var(--accent)", 
                      padding: "12px", 
                      borderRadius: "1rem", 
                      fontSize: "13px" 
                    }}>
                      <strong>สำเร็จ:</strong> {outsourceSuccess}
                    </div>
                  )}

                  {outsourceError && (
                    <div style={{ 
                      background: "rgba(239, 68, 68, 0.08)", 
                      border: "1px solid rgba(239, 68, 68, 0.2)", 
                      color: "var(--danger)", 
                      padding: "12px", 
                      borderRadius: "1rem", 
                      fontSize: "13px" 
                    }}>
                      <strong>ข้อผิดพลาด:</strong> {outsourceError}
                    </div>
                  )}

                  <form onSubmit={handleCreateProject} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                    <div className="form-group">
                      <label className="form-label" style={{ fontWeight: "600", fontSize: "13px", color: "var(--text-primary)", display: "block", marginBottom: "6px" }}>
                        ชื่อโปรเจกต์
                      </label>
                      <input
                        type="text"
                        placeholder="เช่น พัฒนา API Gateway บน Cloudflare Workers"
                        value={newProjTitle}
                        onChange={(e) => setNewProjTitle(e.target.value)}
                        className="form-input"
                        required
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label" style={{ fontWeight: "600", fontSize: "13px", color: "var(--text-primary)", display: "block", marginBottom: "6px" }}>
                        คำอธิบายโดยย่อ
                      </label>
                      <textarea
                        placeholder="อธิบายเป้าหมายโดยรวมของโปรเจกต์…"
                        value={newProjDesc}
                        onChange={(e) => setNewProjDesc(e.target.value)}
                        className="form-input"
                        rows={2}
                        required
                        style={{ resize: "vertical", fontFamily: "inherit" }}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label" style={{ fontWeight: "600", fontSize: "13px", color: "var(--text-primary)", display: "block", marginBottom: "6px" }}>
                        ขอบเขตงานโดยละเอียด (SOW)
                      </label>
                      <textarea
                        placeholder="ระบุงวดงาน สิ่งที่ต้องส่งมอบ เทคโนโลยีที่ใช้…"
                        value={newProjSOW}
                        onChange={(e) => setNewProjSOW(e.target.value)}
                        className="form-input"
                        rows={4}
                        required
                        style={{ resize: "vertical", fontFamily: "inherit" }}
                      />
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: "12px" }}>
                      <div className="form-group">
                        <label className="form-label" style={{ fontWeight: "600", fontSize: "13px", color: "var(--text-primary)", display: "block", marginBottom: "6px" }}>
                          ประเภทงบประมาณ
                        </label>
                        <select
                          value={newProjBudgetType}
                          onChange={(e) => setNewProjBudgetType(e.target.value as "fixed" | "hourly")}
                          style={{
                            width: "100%",
                            padding: "10px 14px",
                            borderRadius: "1rem",
                            border: "1px solid var(--border-subtle)",
                            backgroundColor: "#fff",
                            color: "var(--text-primary)",
                            fontSize: "14px",
                            outline: "none"
                          }}
                        >
                          <option value="fixed">ราคาเหมาจ่าย</option>
                          <option value="hourly">คิดรายชั่วโมง</option>
                        </select>
                      </div>

                      <div className="form-group">
                        <label className="form-label" style={{ fontWeight: "600", fontSize: "13px", color: "var(--text-primary)", display: "block", marginBottom: "6px" }}>
                          ช่วงงบประมาณ
                        </label>
                        <input
                          type="text"
                          placeholder={newProjBudgetType === "fixed" ? "เช่น ฿15,000 - ฿25,000" : "เช่น ฿400 - ฿600 / ชม."}
                          value={newProjBudgetRange}
                          onChange={(e) => setNewProjBudgetRange(e.target.value)}
                          className="form-input"
                          required
                        />
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                      <div className="form-group">
                        <label className="form-label" style={{ fontWeight: "600", fontSize: "13px", color: "var(--text-primary)", display: "block", marginBottom: "6px" }}>
                          คอร์สพื้นฐานที่ต้องผ่าน
                        </label>
                        <select
                          value={newProjRequiredCourseId}
                          onChange={(e) => setNewProjRequiredCourseId(e.target.value)}
                          style={{
                            width: "100%",
                            padding: "10px 14px",
                            borderRadius: "1rem",
                            border: "1px solid var(--border-subtle)",
                            backgroundColor: "#fff",
                            color: "var(--text-primary)",
                            fontSize: "14px",
                            outline: "none"
                          }}
                        >
                          <option value="">-- ไม่กำหนดคอร์สพื้นฐาน --</option>
                          {allCoursesList.map(c => (
                            <option key={c.id} value={c.id}>{c.title}</option>
                          ))}
                        </select>
                      </div>

                      <div className="form-group">
                        <label className="form-label" style={{ fontWeight: "600", fontSize: "13px", color: "var(--text-primary)", display: "block", marginBottom: "6px" }}>
                          เลเวลผู้เรียนขั้นต่ำ
                        </label>
                        <select
                          value={newProjMinLevel}
                          onChange={(e) => setNewProjMinLevel(e.target.value)}
                          style={{
                            width: "100%",
                            padding: "10px 14px",
                            borderRadius: "1rem",
                            border: "1px solid var(--border-subtle)",
                            backgroundColor: "#fff",
                            color: "var(--text-primary)",
                            fontSize: "14px",
                            outline: "none"
                          }}
                        >
                          <option value="1">เลเวล 1+</option>
                          <option value="2">เลเวล 2+</option>
                          <option value="3">เลเวล 3+</option>
                          <option value="4">เลเวล 4+</option>
                          <option value="5">เลเวล 5+</option>
                        </select>
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={outsourceLoading}
                      className="tech-button-primary"
                      style={{ borderRadius: "1rem", padding: "12px", width: "100%", justifyContent: "center", cursor: "pointer" }}
                    >
                      {outsourceLoading ? "กำลังประกาศโปรเจกต์…" : "ประกาศความต้องการโปรเจกต์"}
                    </button>
                  </form>
                </div>

                {/* Posted Projects List */}
                <div className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <h3 style={{ fontSize: "18px", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
                    <Briefcase size={20} color="var(--primary)" />
                    โปรเจกต์ที่คุณประกาศ
                  </h3>
                  
                  {outsourceLoading && outsourceProjects.length === 0 ? (
                    <div style={{ display: "flex", justifyContent: "center", padding: "32px" }}>
                      <div className="spinner" style={{ border: "3px solid var(--border-subtle)", borderTop: "3px solid var(--primary)", borderRadius: "50%", width: "24px", height: "24px", animation: "spin 1s linear infinite" }} />
                    </div>
                  ) : outsourceProjects.length === 0 ? (
                    <div style={{ padding: "24px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
                      คุณยังไม่ได้ประกาศความต้องการโปรเจกต์ IT
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                      {outsourceProjects.map((proj) => {
                        const isSelected = selectedProjId === proj.id;
                        return (
                          <div
                            key={proj.id}
                            onClick={() => handleSelectProject(proj.id)}
                            style={{
                              padding: "16px",
                              borderRadius: "1rem",
                              background: isSelected 
                                ? "linear-gradient(135deg, rgba(229,107,37,0.08) 0%, rgba(168,85,247,0.08) 100%)" 
                                : "rgba(255, 255, 255, 0.02)",
                              border: `1px solid ${isSelected ? "var(--primary)" : "var(--border-subtle)"}`,
                              cursor: "pointer",
                              transition: "all 0.2s ease"
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
                              <h4 style={{ fontSize: "14px", fontWeight: "600", color: isSelected ? "var(--primary)" : "var(--text-primary)" }}>
                                {proj.title}
                              </h4>
                              <span style={{
                                fontSize: "10px",
                                fontWeight: "700",
                                padding: "4px 8px",
                                borderRadius: "0.5rem",
                                background: proj.status === "open" ? "rgba(229,107,37,0.1)" : "rgba(34,197,94,0.1)",
                                color: proj.status === "open" ? "var(--primary)" : "#22c55e"
                              }}>
                                {statusLabel(proj.status)}
                              </span>
                            </div>
                            <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "6px", lineClamp: 2, WebkitLineClamp: 2, display: "-webkit-box", WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                              {proj.description}
                            </p>
                            <div style={{ display: "flex", gap: "12px", marginTop: "12px", fontSize: "11px", color: "var(--text-muted)" }}>
                              <span>💰 {proj.budget_range} ({budgetTypeLabel(proj.budget_type)})</span>
                              <span>⭐ เลเวลขั้นต่ำ: {proj.min_level}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

              </div>

              {/* Right Column: Candidates & Milestones */}
              <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
                {(() => {
                  const selectedProj = outsourceProjects.find(p => p.id === selectedProjId);
                  if (!selectedProj) {
                    return (
                      <div className="glass-card" style={{ padding: "40px", textAlign: "center", color: "var(--text-secondary)" }}>
                        <Briefcase size={48} color="var(--text-muted)" style={{ marginBottom: "16px", marginLeft: "auto", marginRight: "auto" }} />
                        <h4 style={{ color: "var(--text-primary)" }}>ยังไม่ได้เลือกโปรเจกต์</h4>
                        <p style={{ fontSize: "13px", marginTop: "8px" }}>
                          เลือกโปรเจกต์ที่คุณประกาศทางด้านซ้ายเพื่อดูข้อเสนอราคา ตรวจสอบคะแนนความเหมาะสม และอนุมัติงานที่ส่งมอบแต่ละงวด
                        </p>
                      </div>
                    );
                  }

                  const acceptedCandidate = candidates.find(c => c.status === "accepted");

                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
                      
                      {/* Project Specs Summary */}
                      <div className="glass-card" style={{ padding: "20px" }}>
                        <h4 style={{ fontSize: "16px", fontWeight: "600", color: "var(--text-primary)", marginBottom: "8px" }}>
                          {selectedProj.title}
                        </h4>
                        <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "16px" }}>
                          {selectedProj.description}
                        </p>
                        <div style={{ padding: "12px", background: "rgba(0,0,0,0.02)", borderRadius: "0.5rem", border: "1px solid var(--border-subtle)", fontSize: "13px" }}>
                          <strong style={{ color: "var(--text-primary)" }}>ขอบเขตงานโดยละเอียด (SOW):</strong>
                          <p style={{ color: "var(--text-secondary)", marginTop: "6px", whiteSpace: "pre-line", margin: 0 }}>
                            {selectedProj.scope_of_work}
                          </p>
                        </div>
                      </div>

                      {/* Candidate Proposals / Applications list (Only if project is open or we want to view candidates) */}
                      {selectedProj.status === "open" && (
                        <div className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                          <h4 style={{ fontSize: "15px", fontWeight: "600", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
                            <Users size={18} color="var(--primary)" />
                            ข้อเสนอราคาและคะแนนความเหมาะสม
                          </h4>

                          {candidates.length === 0 ? (
                            <div style={{ padding: "24px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
                              ยังไม่มีข้อเสนอราคาจากคอมมิวนิตี้สำหรับโปรเจกต์นี้
                            </div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                              {candidates
                                .sort((a, b) => (b.matchingScore || 0) - (a.matchingScore || 0))
                                .map((cand) => {
                                  const isMatchedHigher = (cand.matchingScore || 0) >= 70;
                                  return (
                                    <div
                                      key={cand.id}
                                      style={{
                                        padding: "16px",
                                        borderRadius: "1rem",
                                        background: "rgba(255, 255, 255, 0.02)",
                                        border: "1px solid var(--border-subtle)",
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: "10px"
                                      }}
                                    >
                                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                        <div>
                                          <h5 style={{ fontSize: "14px", fontWeight: "600", color: "var(--text-primary)" }}>
                                            {cand.studentName}
                                          </h5>
                                          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                                            เลเวล {cand.studentLevel} • {cand.studentTitle || "มือใหม่"}
                                          </span>
                                          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "8px" }}>
                                            <span className="badge-gamified" style={{ fontSize: "10px", padding: "2px 6px", background: "rgba(168,85,247,0.06)", borderColor: "rgba(168,85,247,0.2)", color: "var(--primary)" }}>
                                              🤖 รหัส Agent: {cand.student_id.substring(0, 8)}
                                            </span>
                                            {cand.matchingScore >= 80 ? (
                                              <span className="badge-gamified" style={{ fontSize: "10px", padding: "2px 6px", background: "rgba(34,197,94,0.06)", borderColor: "rgba(34,197,94,0.2)", color: "#22c55e" }}>
                                                ✓ มีทักษะพื้นฐานตามที่กำหนด
                                              </span>
                                            ) : (
                                              <span className="badge-gamified" style={{ fontSize: "10px", padding: "2px 6px", background: "rgba(239,68,68,0.06)", borderColor: "rgba(239,68,68,0.2)", color: "#ef4444" }}>
                                                ✗ ขาดทักษะพื้นฐานที่กำหนด
                                              </span>
                                            )}
                                            {cand.studentLevel >= (selectedProj.min_level || 1) && (
                                              <span className="badge-gamified" style={{ fontSize: "10px", padding: "2px 6px", background: "rgba(59,130,246,0.06)", borderColor: "rgba(59,130,246,0.2)", color: "#3b82f6" }}>
                                                ✓ เลเวลผ่านเกณฑ์
                                              </span>
                                            )}
                                          </div>
                                        </div>

                                        <div style={{
                                          padding: "6px 12px",
                                          borderRadius: "1rem",
                                          background: isMatchedHigher ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                                          border: `1px solid ${isMatchedHigher ? "#22c55e" : "#ef4444"}`,
                                          color: isMatchedHigher ? "#22c55e" : "#ef4444",
                                          fontSize: "12px",
                                          fontWeight: "700"
                                        }}>
                                          เหมาะสม {cand.matchingScore}%
                                        </div>
                                      </div>

                                      <div style={{ fontSize: "13px", color: "var(--text-secondary)", background: "rgba(0,0,0,0.01)", padding: "10px", borderRadius: "0.5rem" }}>
                                        <div style={{ fontWeight: "600", color: "var(--text-primary)", marginBottom: "4px" }}>ข้อเสนองาน:</div>
                                        <p style={{ margin: 0, whiteSpace: "pre-line" }}>{cand.proposal}</p>
                                      </div>

                                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "4px" }}>
                                        <span style={{ fontSize: "13px", fontWeight: "700", color: "var(--primary)" }}>
                                          ราคาที่เสนอ: {cand.bid_amount}
                                        </span>

                                        <button
                                          onClick={() => handleAcceptBid(cand.id)}
                                          className="tech-button-primary"
                                          style={{ padding: "6px 16px", borderRadius: "0.5rem", fontSize: "12px", cursor: "pointer" }}
                                        >
                                          รับและว่าจ้าง
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Milestones & Deliverables Panel (Only if project is active/completed and candidate is hired) */}
                      {selectedProj.status !== "open" && acceptedCandidate && (
                        <div className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                          <div style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "12px" }}>
                            <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>นักพัฒนา Outsource ที่ว่าจ้าง:</span>
                            <h4 style={{ fontSize: "15px", fontWeight: "600", color: "var(--text-primary)" }}>
                              {acceptedCandidate.studentName} ({acceptedCandidate.studentEmail})
                            </h4>
                            <span style={{ fontSize: "13px", fontWeight: "700", color: "var(--accent)", marginTop: "4px", display: "inline-block" }}>
                              ราคาที่ตกลง: {acceptedCandidate.bid_amount}
                            </span>
                          </div>

                          <h4 style={{ fontSize: "15px", fontWeight: "600", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
                            <Clock size={18} color="var(--primary)" />
                            งานที่ส่งมอบตามงวดงาน (Milestone)
                          </h4>

                          {milestones.length === 0 ? (
                            <div style={{ padding: "20px", textAlign: "center", color: "var(--text-secondary)", fontSize: "13px" }}>
                              ยังไม่มีงวดงาน
                            </div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                              {milestones.map((ms) => {
                                const isSubmitted = ms.status === "submitted";
                                const isApproved = ms.status === "approved";
                                return (
                                  <div
                                    key={ms.id}
                                    style={{
                                      padding: "16px",
                                      borderRadius: "1rem",
                                      background: "rgba(255,255,255,0.02)",
                                      border: `1px solid ${isApproved ? "rgba(34,197,94,0.3)" : "var(--border-subtle)"}`,
                                      display: "flex",
                                      flexDirection: "column",
                                      gap: "8px"
                                    }}
                                  >
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                      <span style={{ fontSize: "13px", fontWeight: "700", color: "var(--text-primary)" }}>
                                        {ms.title}
                                      </span>
                                      <span style={{
                                        fontSize: "11px",
                                        padding: "2px 8px",
                                        borderRadius: "0.5rem",
                                        background: isApproved ? "rgba(34,197,94,0.1)" : isSubmitted ? "rgba(229,107,37,0.1)" : "rgba(255,255,255,0.05)",
                                        color: isApproved ? "#22c55e" : isSubmitted ? "var(--primary)" : "var(--text-muted)",
                                        fontWeight: "700"
                                      }}>
                                        {statusLabel(ms.status)}
                                      </span>
                                    </div>

                                    <p style={{ fontSize: "12px", color: "var(--text-secondary)", margin: 0 }}>
                                      {ms.description}
                                    </p>

                                    {ms.deliverables && (
                                      <div style={{ fontSize: "13px", color: "var(--text-secondary)", background: "rgba(0,0,0,0.01)", padding: "10px", borderRadius: "0.5rem", marginTop: "6px" }}>
                                        <strong style={{ color: "var(--text-primary)", display: "block", marginBottom: "4px" }}>งานที่ส่งมอบ:</strong>
                                        <p style={{ margin: 0, whiteSpace: "pre-line" }}>{ms.deliverables}</p>
                                      </div>
                                    )}

                                    {isSubmitted && (
                                       <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "8px" }}>
                                         {/* AI PM Assistant Trigger */}
                                         {aiAuditResults[ms.id] ? (
                                           <div style={{ 
                                             background: "rgba(168,85,247,0.05)", 
                                             border: "1px solid rgba(168,85,247,0.2)", 
                                             borderRadius: "0.75rem", 
                                             padding: "12px",
                                             fontSize: "12px",
                                             display: "flex",
                                             flexDirection: "column",
                                             gap: "8px"
                                           }}>
                                             <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                               <span style={{ fontWeight: "700", color: "var(--primary)", display: "flex", alignItems: "center", gap: "4px" }}>
                                                 <Zap size={12} /> รายงานคุณภาพจาก AI PM
                                               </span>
                                               <motion.span 
                                                 initial={{ scale: 0.5, opacity: 0 }}
                                                 animate={{ scale: 1, opacity: 1 }}
                                                 transition={{ type: "spring", stiffness: 200, damping: 10 }}
                                                 style={{ 
                                                 fontWeight: "800", 
                                                 padding: "2px 8px", 
                                                 borderRadius: "0.5rem",
                                                 background: aiAuditResults[ms.id].qualityScore >= 80 ? "rgba(34,197,94,0.12)" : "rgba(245,158,11,0.12)",
                                                 color: aiAuditResults[ms.id].qualityScore >= 80 ? "#22c55e" : "#f59e0b"
                                               }}>
                                                 คะแนน: {aiAuditResults[ms.id].qualityScore}/100
                                               </motion.span>
                                             </div>
                                             
                                             <div style={{ display: "flex", gap: "10px" }}>
                                               <span>ความเสี่ยงด้านกำหนดเวลา:</span>
                                               <strong style={{ 
                                                 color: aiAuditResults[ms.id].timelineRisk === "Low" ? "#22c55e" : aiAuditResults[ms.id].timelineRisk === "Medium" ? "#f59e0b" : "#ef4444" 
                                               }}>
                                                 {riskLabel(aiAuditResults[ms.id].timelineRisk)}
                                               </strong>
                                             </div>
 
                                             <div style={{ color: "var(--text-secondary)", fontStyle: "italic", fontSize: "11px" }}>
                                               {aiAuditResults[ms.id].timelineFeedback}
                                             </div>
 
                                             <div style={{ borderTop: "1px dashed rgba(168,85,247,0.15)", paddingTop: "8px", color: "var(--text-secondary)", whiteSpace: "pre-line", maxHeight: "150px", overflowY: "auto", paddingRight: "4px" }}>
                                               {aiAuditResults[ms.id].auditReport}
                                             </div>
                                           </div>
                                         ) : aiAuditLoading[ms.id] ? (
                                            <motion.div
                                              initial={{ opacity: 0, height: 0 }}
                                              animate={{ opacity: 1, height: "auto" }}
                                              className="tech-button-outline"
                                              style={{ 
                                                borderRadius: "0.5rem", padding: "12px", width: "100%",
                                                display: "flex", flexDirection: "column", alignItems: "center", gap: "8px",
                                                position: "relative", overflow: "hidden", border: "1px solid rgba(168,85,247,0.3)"
                                              }}
                                            >
                                              <motion.div 
                                                animate={{ y: ["-100%", "200%"] }} 
                                                transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
                                                style={{ position: "absolute", top: 0, left: 0, right: 0, height: "50%", background: "linear-gradient(transparent, rgba(168,85,247,0.3), transparent)", zIndex: 0 }}
                                              />
                                              <Zap size={16} color="var(--accent)" style={{ zIndex: 1 }} />
                                              <span style={{ fontSize: "12px", zIndex: 1, color: "var(--accent)" }}>AI กำลังตรวจสอบซอร์สโค้ดและงานที่ส่งมอบ…</span>
                                            </motion.div>
                                          ) : (
                                           <button
                                             type="button"
                                             onClick={() => handleRunAiPmAudit(ms, selectedProj)}
                                             className="tech-button-outline"
                                             style={{ 
                                               borderRadius: "0.5rem", 
                                               padding: "8px", 
                                               width: "100%", 
                                               justifyContent: "center", 
                                               fontSize: "12px", 
                                               cursor: "pointer",
                                               display: "flex",
                                               alignItems: "center",
                                               gap: "6px"
                                             }}
                                           >
                                              <Zap size={12} color="var(--accent)" />
                                              ตรวจสอบคุณภาพด้วย AI PM
                                           </button>
                                         )}
 
                                         <button
                                           onClick={() => handleApproveMilestone(ms.id)}
                                           className="tech-button-primary"
                                           style={{ 
                                             borderRadius: "0.5rem", 
                                             padding: "8px", 
                                             width: "100%", 
                                             justifyContent: "center", 
                                             fontSize: "12px", 
                                             cursor: "pointer" 
                                           }}
                                         >
                                           ตรวจสอบและมอบรางวัล EXP (+200 EXP)
                                         </button>
                                       </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}

                    </div>
                  );
                })()}
              </div>

            </div>
          )}

          {activeTab === "internships" && data?.partnerType === "company" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: "32px", alignItems: "start" }} className="internship-grid-responsive">
              <style>{`
                @media (max-width: 1024px) {
                  .internship-grid-responsive {
                    grid-template-columns: 1fr !important;
                  }
                }
              `}</style>

              {/* Left Column: Manage Openings & Post Job Form */}
              <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
                {/* Create opening form */}
                <div className="glass-card" style={{ padding: "24px" }}>
                  <h3 style={{ fontSize: "18px", color: "var(--text-primary)", marginBottom: "16px", display: "flex", alignItems: "center", gap: "8px" }}>
                    <PlusCircle size={20} color="var(--primary)" /> ประกาศตำแหน่งฝึกงานใหม่
                  </h3>
                  
                  {internshipSuccess && (
                    <div style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)", color: "#22c55e", padding: "12px", borderRadius: "0.75rem", fontSize: "13px", marginBottom: "16px" }}>
                      {internshipSuccess}
                    </div>
                  )}

                  {internshipError && (
                    <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#ef4444", padding: "12px", borderRadius: "0.75rem", fontSize: "13px", marginBottom: "16px" }}>
                      {internshipError}
                    </div>
                  )}

                  <form onSubmit={handleCreateOpening} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    <div className="form-group">
                      <label style={{ fontSize: "13px", color: "var(--text-secondary)", fontWeight: 600, display: "block", marginBottom: "6px" }}>ชื่อตำแหน่ง</label>
                      <input
                        type="text"
                        value={newOpeningTitle}
                        onChange={(e) => setNewOpeningTitle(e.target.value)}
                        placeholder="เช่น นักศึกษาฝึกงานด้านโครงสร้างพื้นฐานคลาวด์"
                        required
                        className="form-input"
                      />
                    </div>
                    
                    <div className="form-group">
                      <label style={{ fontSize: "13px", color: "var(--text-secondary)", fontWeight: 600, display: "block", marginBottom: "6px" }}>รายละเอียดตำแหน่ง</label>
                      <textarea
                        value={newOpeningDesc}
                        onChange={(e) => setNewOpeningDesc(e.target.value)}
                        placeholder="อธิบายหน้าที่ ขอบเขตงาน และโอกาสในการเรียนรู้ของผู้ฝึกงาน…"
                        required
                        rows={4}
                        className="form-input"
                        style={{ fontFamily: "inherit", resize: "vertical" }}
                      />
                    </div>

                    <div className="form-group">
                      <label style={{ fontSize: "13px", color: "var(--text-secondary)", fontWeight: 600, display: "block", marginBottom: "6px" }}>คอร์สพื้นฐานที่ต้องผ่าน</label>
                      <select
                        value={newOpeningCourseId}
                        onChange={(e) => setNewOpeningCourseId(e.target.value)}
                        style={{
                          width: "100%",
                          padding: "10px 14px",
                          borderRadius: "1rem",
                          border: "1px solid var(--border-subtle)",
                          backgroundColor: "#fff",
                          color: "var(--text-primary)",
                          fontSize: "14px",
                          outline: "none"
                        }}
                      >
                        {allCoursesList.map(c => (
                          <option key={c.id} value={c.id}>{c.title}</option>
                        ))}
                      </select>
                    </div>

                    <button
                      type="submit"
                      disabled={internshipLoading}
                      className="tech-button-primary"
                      style={{ borderRadius: "1rem", padding: "12px", width: "100%", justifyContent: "center", cursor: "pointer", marginTop: "8px" }}
                    >
                      {internshipLoading ? "กำลังประกาศตำแหน่ง…" : "ประกาศตำแหน่งฝึกงาน"}
                    </button>
                  </form>
                </div>

                {/* Company Openings List */}
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  <h3 style={{ fontSize: "16px", color: "var(--text-primary)", fontWeight: 600 }}>ตำแหน่งที่เปิดรับอยู่</h3>
                  {internshipOpenings.length === 0 ? (
                    <div className="glass-card" style={{ padding: "24px", textAlign: "center", color: "var(--text-secondary)" }}>
                      ยังไม่มีตำแหน่งฝึกงานที่ประกาศ
                    </div>
                  ) : (
                    internshipOpenings.map(opening => (
                      <div key={opening.id} className="glass-card" style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <h4 style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>{opening.title}</h4>
                          <span style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "1rem", background: "rgba(34,197,94,0.1)", color: "#22c55e" }}>
                            {statusLabel(opening.status)}
                          </span>
                        </div>
                        <p style={{ fontSize: "13px", color: "var(--text-secondary)", margin: 0 }}>{opening.description}</p>
                        <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "8px", fontSize: "12px", color: "var(--text-secondary)" }}>
                          คอร์สพื้นฐาน: <strong style={{ color: "var(--text-primary)" }}>{opening.course_title}</strong>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Right Column: Applicants Roster, Evaluation, & Timesheet approvals */}
              <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <label style={{ fontSize: "13px", color: "var(--text-secondary)", fontWeight: 600 }}>เลือกใบสมัครของผู้เรียนที่ต้องการพิจารณา:</label>
                  <select
                    value={selectedAppId || ""}
                    onChange={(e) => {
                      const appId = e.target.value;
                      setSelectedAppId(appId);
                      fetchAppLogsHR(appId);
                    }}
                    style={{
                      background: "#fff",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "0.75rem",
                      padding: "10px 14px",
                      fontSize: "14px",
                      width: "100%",
                      outline: "none"
                    }}
                  >
                    <option value="">-- เลือกผู้สมัครที่เป็นผู้เรียน --</option>
                    {receivedApplications.map(app => (
                      <option key={app.id} value={app.id}>
                        {app.student_name} ({app.student_email}) - {app.opening_title} [{statusLabel(app.status)}]
                      </option>
                    ))}
                  </select>
                </div>

                {(() => {
                  const currentApp = receivedApplications.find(a => a.id === selectedAppId);
                  if (!currentApp) return (
                    <div className="glass-card" style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary)" }}>
                      เลือกใบสมัครจากรายการด้านบนเพื่อดูสถานะ ผลการประเมิน และตรวจสอบ/อนุมัติบันทึกเวลาฝึกงานของผู้เรียน
                    </div>
                  );

                  const isAcceptedOrCompleted = currentApp.status === "accepted" || currentApp.status === "completed";

                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                      {/* Application Info & Status controls */}
                      <div className="glass-card" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div>
                            <h4 style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "4px" }}>{currentApp.student_name}</h4>
                            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>มหาวิทยาลัย: {currentApp.student_univ_name || "เรียนด้วยตนเอง (B2C)"}</span>
                          </div>
                          <span style={{
                            padding: "4px 10px",
                            borderRadius: "1rem",
                            fontSize: "11px",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            background: "rgba(229,107,37,0.1)",
                            color: "var(--primary)"
                          }}>{statusLabel(currentApp.status)}</span>
                        </div>

                        <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                          ความคืบหน้าคอร์สพื้นฐาน: <strong style={{ color: "var(--text-primary)" }}>เรียนจบแล้ว {currentApp.course_progress || 0}%</strong>
                        </div>

                        {/* Status update buttons */}
                        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                          {currentApp.status === "applied" && (
                            <button onClick={() => handleUpdateAppStatus(currentApp.id, "under_review")} className="tech-button-outline" style={{ borderRadius: "0.5rem", padding: "6px 12px", fontSize: "12px", cursor: "pointer" }}>
                              กำลังพิจารณา
                            </button>
                          )}
                          {(currentApp.status === "applied" || currentApp.status === "under_review") && (
                            <>
                              <button onClick={() => handleUpdateAppStatus(currentApp.id, "accepted")} className="tech-button-primary" style={{ borderRadius: "0.5rem", padding: "6px 12px", fontSize: "12px", cursor: "pointer" }}>
                                รับเข้าฝึกงาน
                              </button>
                              <button onClick={() => handleUpdateAppStatus(currentApp.id, "rejected")} className="tech-button-outline" style={{ borderRadius: "0.5rem", padding: "6px 12px", fontSize: "12px", cursor: "pointer", borderColor: "rgba(239,68,68,0.4)", color: "#ef4444" }}>
                                ปฏิเสธ
                              </button>
                            </>
                          )}
                        </div>

                        {/* Evaluation Form for Completion */}
                        {isAcceptedOrCompleted && (
                          <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
                            <h4 style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>การประเมินผลสรุป</h4>
                            <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "12px", alignItems: "center" }}>
                              <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>คะแนน (0-100)</label>
                              <input
                                type="number"
                                min="0"
                                max="100"
                                value={evalScore}
                                onChange={(e) => setEvalScore(e.target.value)}
                                className="form-input"
                                style={{ padding: "6px 10px" }}
                              />
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                              <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>ความเห็นของหัวหน้างาน</label>
                              <textarea
                                value={evalFeedback}
                                onChange={(e) => setEvalFeedback(e.target.value)}
                                placeholder="อธิบายผลงาน การทำงานเป็นทีม และจุดแข็งของผู้เรียน…"
                                rows={2}
                                className="form-input"
                                style={{ fontFamily: "inherit", resize: "vertical", padding: "6px 10px" }}
                              />
                            </div>
                            <button
                              onClick={() => handleUpdateAppStatus(currentApp.id, "completed")}
                              className="tech-button-primary"
                              style={{ borderRadius: "0.5rem", padding: "8px", width: "100%", justifyContent: "center", fontSize: "13px", cursor: "pointer" }}
                            >
                              บันทึกการประเมินและจบการฝึกงาน
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Daily logs list for supervisor approval */}
                      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <h4 style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "6px" }}>
                          <Clock size={16} /> อนุมัติบันทึกเวลาฝึกงาน
                        </h4>

                        {applicationLogs.length === 0 ? (
                          <div className="glass-card" style={{ padding: "20px", textAlign: "center", color: "var(--text-secondary)", fontSize: "13px" }}>
                            ผู้เรียนยังไม่ได้ส่งบันทึกเวลาฝึกงาน
                          </div>
                        ) : (
                          applicationLogs.map(log => (
                            <div key={log.id} className="glass-card" style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>📅 {log.log_date} ({log.hours_worked} ชม.)</span>
                                
                                <div style={{ display: "flex", gap: "6px" }}>
                                  {log.company_approved === 0 ? (
                                    <>
                                      <button onClick={() => handleApproveLog(log.id, "company", 1)} className="tech-button-primary" style={{ borderRadius: "0.5rem", padding: "4px 8px", fontSize: "11px", cursor: "pointer" }}>
                                        อนุมัติ
                                      </button>
                                      <button onClick={() => handleApproveLog(log.id, "company", -1)} className="tech-button-outline" style={{ borderRadius: "0.5rem", padding: "4px 8px", fontSize: "11px", cursor: "pointer", borderColor: "rgba(239,68,68,0.3)", color: "#ef4444" }}>
                                        ปฏิเสธ
                                      </button>
                                    </>
                                  ) : (
                                    <span style={{
                                      fontSize: "11px",
                                      padding: "2px 8px",
                                      borderRadius: "0.5rem",
                                      background: log.company_approved === 1 ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                                      color: log.company_approved === 1 ? "#22c55e" : "#ef4444"
                                    }}>
                                      {log.company_approved === 1 ? "อนุมัติแล้ว ✓" : "ปฏิเสธแล้ว ✗"}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <p style={{ fontSize: "13px", color: "var(--text-secondary)", margin: 0 }}>{log.activity_description}</p>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {activeTab === "internships" && data?.partnerType === "university" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: "32px", alignItems: "start" }} className="internship-grid-responsive">
              <style>{`
                @media (max-width: 1024px) {
                  .internship-grid-responsive {
                    grid-template-columns: 1fr !important;
                  }
                }
              `}</style>

              {/* Left Column: List of Students undergoing internships */}
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <h3 style={{ fontSize: "18px", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
                  <Users size={20} color="var(--primary)" /> นักศึกษาฝึกงาน
                </h3>
                
                {internshipSuccess && (
                  <div style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)", color: "#22c55e", padding: "12px", borderRadius: "0.75rem", fontSize: "13px" }}>
                    {internshipSuccess}
                  </div>
                )}

                {internshipError && (
                  <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#ef4444", padding: "12px", borderRadius: "0.75rem", fontSize: "13px" }}>
                    {internshipError}
                  </div>
                )}

                {universityApplications.length === 0 ? (
                  <div className="glass-card" style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary)" }}>
                    ยังไม่มีนักศึกษาของมหาวิทยาลัยที่มีใบสมัครฝึกงานที่ดำเนินอยู่หรือรอดำเนินการ
                  </div>
                ) : (
                  universityApplications.map(app => (
                    <div
                      key={app.id}
                      onClick={() => {
                        setSelectedAppId(app.id);
                        fetchAppLogsHR(app.id);
                      }}
                      className="glass-card"
                      style={{
                        padding: "16px",
                        cursor: "pointer",
                        borderLeft: selectedAppId === app.id ? "4px solid var(--primary)" : "4px solid transparent",
                        display: "flex",
                        flexDirection: "column",
                        gap: "8px"
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <h4 style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>{app.student_name}</h4>
                        <span style={{
                          fontSize: "11px",
                          padding: "2px 8px",
                          borderRadius: "1rem",
                          background: app.status === "accepted" ? "rgba(34,197,94,0.1)" : "rgba(255,255,255,0.05)",
                          color: app.status === "accepted" ? "#22c55e" : "var(--text-secondary)"
                        }}>{statusLabel(app.status)}</span>
                      </div>
                      <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                        ตำแหน่ง: {app.opening_title} ที่ {app.company_name}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Right Column: Coordinator Feedback Form and Log verification approvals */}
              <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
                {(() => {
                  const currentApp = universityApplications.find(a => a.id === selectedAppId);
                  if (!currentApp) return (
                    <div className="glass-card" style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary)" }}>
                      เลือกนักศึกษาฝึกงานจากรายการด้านซ้ายเพื่อดูกิจกรรม เพิ่มความเห็นของผู้ประสานงาน และอนุมัติบันทึกสำหรับหน่วยกิต
                    </div>
                  );

                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                      {/* Coordinator feedback form */}
                      <div className="glass-card" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "14px" }}>
                        <h4 style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)" }}>การนิเทศและการประเมินผล</h4>
                        <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                          ผู้เรียน: <strong style={{ color: "var(--text-primary)" }}>{currentApp.student_name} ({currentApp.student_email})</strong>
                        </div>
                        <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "4px" }}>
                          ตำแหน่ง: <strong style={{ color: "var(--text-primary)" }}>{currentApp.opening_title}</strong> ที่ <strong style={{ color: "var(--text-primary)" }}>{currentApp.company_name}</strong>
                        </div>

                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                          <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>ความเห็นของอาจารย์ผู้ประสานงาน / บันทึกหน่วยกิต</label>
                          <textarea
                            value={univFeedback}
                            onChange={(e) => setUnivFeedback(e.target.value)}
                            placeholder="เพิ่มรายละเอียดการประเมินหน่วยกิตหรือความเห็นจากการนิเทศ…"
                            rows={3}
                            className="form-input"
                            style={{ fontFamily: "inherit", resize: "vertical" }}
                          />
                        </div>

                        <button
                          onClick={() => handleUpdateUnivFeedback(currentApp.id)}
                          className="tech-button-primary"
                          style={{ borderRadius: "0.5rem", padding: "8px", width: "100%", justifyContent: "center", fontSize: "13px", cursor: "pointer" }}
                        >
                          บันทึกความเห็นผู้ประสานงาน
                        </button>
                      </div>

                      {/* Log Approvals */}
                      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <h4 style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "6px" }}>
                          <Clock size={16} /> ตรวจสอบบันทึกเวลาฝึกงาน (หน่วยกิต)
                        </h4>

                        {applicationLogs.length === 0 ? (
                          <div className="glass-card" style={{ padding: "20px", textAlign: "center", color: "var(--text-secondary)", fontSize: "13px" }}>
                            ผู้เรียนยังไม่ได้ส่งบันทึก
                          </div>
                        ) : (
                          applicationLogs.map(log => (
                            <div key={log.id} className="glass-card" style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>📅 {log.log_date} ({log.hours_worked} ชม.)</span>
                                
                                <div style={{ display: "flex", gap: "6px" }}>
                                  {log.university_approved === 0 ? (
                                    <>
                                      <button onClick={() => handleApproveLog(log.id, "university", 1)} className="tech-button-primary" style={{ borderRadius: "0.5rem", padding: "4px 8px", fontSize: "11px", cursor: "pointer" }}>
                                        อนุมัติ
                                      </button>
                                      <button onClick={() => handleApproveLog(log.id, "university", -1)} className="tech-button-outline" style={{ borderRadius: "0.5rem", padding: "4px 8px", fontSize: "11px", cursor: "pointer", borderColor: "rgba(239,68,68,0.3)", color: "#ef4444" }}>
                                        ปฏิเสธ
                                      </button>
                                    </>
                                  ) : (
                                    <span style={{
                                      fontSize: "11px",
                                      padding: "2px 8px",
                                      borderRadius: "0.5rem",
                                      background: log.university_approved === 1 ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                                      color: log.university_approved === 1 ? "#22c55e" : "#ef4444"
                                    }}>
                                      {log.university_approved === 1 ? "อนุมัติแล้ว ✓" : "ปฏิเสธแล้ว ✗"}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <p style={{ fontSize: "13px", color: "var(--text-secondary)", margin: 0 }}>{log.activity_description}</p>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

        </div>
      ) : null}

      {/* Invite Modal (Dialog overlay) */}
      <AnimatePresence>
        {showInviteModal && (
          <div style={{ 
            position: "fixed", 
            inset: 0, 
            background: "rgba(0, 0, 0, 0.4)", 
            backdropFilter: "blur(4px)", 
            display: "flex", 
            justifyContent: "center", 
            alignItems: "center", 
            zIndex: 2000 
          }}>
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="glass-card" 
              style={{ 
                width: "480px", 
                border: "1px solid var(--border-active)", 
                boxShadow: "0 20px 50px rgba(0,0,0,0.15)",
                borderRadius: "1.5rem"
              }}
            >
              <h3 style={{ fontSize: "20px", color: "var(--text-primary)", marginBottom: "8px", display: "flex", alignItems: "center", gap: "8px" }}>
                <PlusCircle size={20} color="var(--primary)" />
                เพิ่มที่นั่งองค์กร
              </h3>
              <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "24px" }}>
                กรอกข้อมูลพนักงานด้านล่าง การลงทะเบียนจะใช้สิทธิ์ 1 ที่นั่งจากโควตาองค์กรของคุณ (ใช้ไปแล้ว {data?.usedSeats}/{data?.totalSeats})
              </p>

              {inviteError && (
                <div style={{ 
                  background: "rgba(239, 68, 68, 0.08)", 
                  border: "1px solid rgba(239, 68, 68, 0.2)", 
                  color: "var(--danger)", 
                  padding: "12px", 
                  borderRadius: "1rem", 
                  fontSize: "13px", 
                  marginBottom: "20px" 
                }}>
                  <strong>ข้อผิดพลาด:</strong> {inviteError}
                </div>
              )}

              <form onSubmit={handleInviteStudent}>
                <div className="form-group">
                  <label className="form-label">ชื่อพนักงาน</label>
                  <div style={{ position: "relative" }}>
                    <User size={16} color="var(--text-muted)" style={{ position: "absolute", left: "14px", top: "14px" }} />
                    <input
                      type="text"
                      placeholder="เช่น สมชาย ใจดี"
                      value={inviteName}
                      onChange={(e) => setInviteName(e.target.value)}
                      className="form-input"
                      style={{ paddingLeft: "42px" }}
                      required
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">อีเมล</label>
                  <div style={{ position: "relative" }}>
                    <Mail size={16} color="var(--text-muted)" style={{ position: "absolute", left: "14px", top: "14px" }} />
                    <input
                      type="email"
                      placeholder="name@company.com"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      className="form-input"
                      style={{ paddingLeft: "42px" }}
                      required
                    />
                  </div>
                </div>

                <div className="form-group">
                  <span className="form-label">วิธีเข้าใช้งานครั้งแรก</span>
                  <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "13px", color: "var(--text-primary)", marginBottom: "8px", cursor: "pointer" }}>
                    <input type="radio" name="invite-mode" checked={inviteMode === "invite"} onChange={() => setInviteMode("invite")} style={{ marginTop: "3px" }} />
                    <span>ส่งลิงก์เชิญทางอีเมล (แนะนำ) <span style={{ display: "block", fontSize: "12px", color: "var(--text-muted)" }}>พนักงานตั้งรหัสผ่านเอง ลิงก์ใช้ได้ 7 วัน</span></span>
                  </label>
                  <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "13px", color: "var(--text-primary)", cursor: "pointer" }}>
                    <input type="radio" name="invite-mode" checked={inviteMode === "password"} onChange={() => setInviteMode("password")} style={{ marginTop: "3px" }} />
                    <span>ตั้งรหัสผ่านเริ่มต้นให้เอง</span>
                  </label>
                </div>

                {inviteMode === "password" && (
                  <div className="form-group">
                    <label className="form-label">รหัสผ่านเริ่มต้น (อย่างน้อย 12 ตัวอักษร)</label>
                    <input
                      type="password"
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={256}
                      value={invitePassword}
                      onChange={(e) => setInvitePassword(e.target.value)}
                      className="form-input"
                      required
                    />
                  </div>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "32px" }}>
                  <button
                    type="button"
                    onClick={() => setShowInviteModal(false)}
                    className="tech-button-outline"
                    style={{ borderRadius: "1rem" }}
                  >
                    ยกเลิก
                  </button>
                  
                  <button
                    type="submit"
                    disabled={actionLoading}
                    className="tech-button-primary"
                    style={{ borderRadius: "1rem" }}
                  >
                    {actionLoading ? "กำลังลงทะเบียน…" : inviteMode === "invite" ? "ส่งคำเชิญ" : "มอบสิทธิ์ใช้งาน"}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      
      {/* Remove-from-organization confirmation */}
      {removeTarget && (
        <Modal title="นำพนักงานออกจากองค์กร" onClose={() => !removeLoading && setRemoveTarget(null)} width={520}>
          <p style={{ fontSize: "14px", color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: "12px" }}>
            นำ <strong style={{ color: "var(--text-primary)" }}>{removeTarget.name}</strong> ({removeTarget.email}) ออกจาก {data?.companyName}?
          </p>
          <ul style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.7, paddingLeft: "20px", marginBottom: "16px" }}>
            <li>คืนที่นั่ง 1 ที่นั่งให้องค์กร</li>
            <li>ระงับคอร์สที่องค์กรสนับสนุนซึ่งยังเรียนไม่จบ</li>
            <li>บัญชียังเข้าสู่ระบบได้ในฐานะผู้เรียนทั่วไป และคอร์สที่ซื้อเองยังเรียนต่อได้</li>
          </ul>
          {removeError && (
            <div role="alert" style={{ background: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.2)", color: "var(--danger)", padding: "12px", borderRadius: "1rem", fontSize: "13px", marginBottom: "16px" }}>
              {removeError}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px" }}>
            <button type="button" onClick={() => setRemoveTarget(null)} disabled={removeLoading} className="tech-button-outline" style={{ borderRadius: "1rem" }}>
              ยกเลิก
            </button>
            <button type="button" onClick={handleRemoveEmployee} disabled={removeLoading} className="tech-button-primary" style={{ borderRadius: "1rem", background: "var(--danger)" }}>
              {removeLoading ? "กำลังดำเนินการ…" : "ยืนยันนำออก"}
            </button>
          </div>
        </Modal>
      )}

      {/* AI PM Requirement Wizard Modal */}
      <AnimatePresence>
        {isAiWizardOpen && (
          <div style={{ 
            position: "fixed", 
            inset: 0, 
            background: "rgba(0, 0, 0, 0.4)", 
            backdropFilter: "blur(4px)", 
            display: "flex", 
            justifyContent: "center", 
            alignItems: "center", 
            zIndex: 2000 
          }}>
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="glass-card" 
              style={{ 
                width: "500px", 
                border: "1px solid var(--border-active)", 
                boxShadow: "0 20px 50px rgba(0,0,0,0.15)",
                borderRadius: "1.5rem",
                padding: "24px"
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
                <Zap size={20} color="var(--accent)" />
                <h3 style={{ fontSize: "18px", color: "var(--text-primary)", margin: 0 }}>
                  AI รวบรวมความต้องการ (มาตรฐาน PM)
                </h3>
              </div>

              {/* Wizard Steps */}
              <div style={{ position: "relative", minHeight: "250px" }}>
                {aiGeneratingScope && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    style={{
                      position: "absolute", inset: 0, zIndex: 10,
                      background: "rgba(10, 10, 15, 0.8)", backdropFilter: "blur(8px)",
                      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                      borderRadius: "1rem", color: "#fff"
                    }}
                  >
                    <div style={{ position: "relative", width: "60px", height: "60px", marginBottom: "20px" }}>
                      <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                        style={{ position: "absolute", inset: 0, border: "3px solid transparent", borderTopColor: "var(--accent)", borderRadius: "50%" }}
                      />
                      <motion.div
                        animate={{ rotate: -360 }}
                        transition={{ repeat: Infinity, duration: 3, ease: "linear" }}
                        style={{ position: "absolute", inset: "10px", border: "3px solid transparent", borderTopColor: "var(--primary)", borderRadius: "50%" }}
                      />
                      <Zap size={24} color="var(--accent)" style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)" }} />
                    </div>
                    <AnimatePresence mode="wait">
                      <motion.h4
                        key={loadingPhraseIdx}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        style={{ fontSize: "16px", fontWeight: "600", margin: 0, textAlign: "center" }}
                      >
                        {loadingPhrases[loadingPhraseIdx]}
                      </motion.h4>
                    </AnimatePresence>
                  </motion.div>
                )}

                <AnimatePresence mode="wait">
                  {aiWizardStep === 1 && (
                    <motion.div key="step1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <div>
                    <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>ขั้นตอนที่ 1 จาก 5</label>
                    <h4 style={{ fontSize: "15px", color: "#fff", fontWeight: "bold", margin: "4px 0 0 0" }}>เป้าหมายหลักของโปรเจกต์นี้คืออะไร?</h4>
                  </div>
                  <textarea
                    placeholder="เช่น พัฒนา Hono API Gateway ประสิทธิภาพสูงเพื่อส่งต่อคำขอไปยัง worker รองรับ rate-limiting และการบันทึก log แบบกำหนดเอง"
                    value={wizardGoal}
                    onChange={(e) => setWizardGoal(e.target.value)}
                    className="form-input"
                    rows={4}
                    style={{ resize: "none" }}
                  />
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
                    <button type="button" onClick={() => setIsAiWizardOpen(false)} className="tech-button-outline" style={{ borderRadius: "1rem" }}>ยกเลิก</button>
                    <button type="button" onClick={() => setAiWizardStep(2)} disabled={!wizardGoal.trim()} className="tech-button-primary" style={{ borderRadius: "1rem" }}>ถัดไป</button>
                  </div>
                </motion.div>
              )}

              {aiWizardStep === 2 && (
                <motion.div key="step2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <div>
                    <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>ขั้นตอนที่ 2 จาก 5</label>
                    <h4 style={{ fontSize: "15px", color: "#fff", fontWeight: "bold", margin: "4px 0 0 0" }}>ระบุขอบเขต ฟีเจอร์ หรืองวดงานที่คาดหวัง</h4>
                  </div>
                  <textarea
                    placeholder="เช่น งวดที่ 1: ตั้งค่าสภาพแวดล้อม งวดที่ 2: ตั้งค่ากฎการ routing งวดที่ 3: แดชบอร์ด log และต้องส่งมอบโค้ด TypeScript ที่สะอาด"
                    value={wizardScope}
                    onChange={(e) => setWizardScope(e.target.value)}
                    className="form-input"
                    rows={4}
                    style={{ resize: "none" }}
                  />
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
                    <button type="button" onClick={() => setAiWizardStep(1)} className="tech-button-outline" style={{ borderRadius: "1rem" }}>กลับ</button>
                    <button type="button" onClick={() => setAiWizardStep(3)} disabled={!wizardScope.trim()} className="tech-button-primary" style={{ borderRadius: "1rem" }}>ถัดไป</button>
                  </div>
                </motion.div>
              )}

              {aiWizardStep === 3 && (
                <motion.div key="step3" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <div>
                    <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>ขั้นตอนที่ 3 จาก 5</label>
                    <h4 style={{ fontSize: "15px", color: "#fff", fontWeight: "bold", margin: "4px 0 0 0" }}>เทคโนโลยีหรือทักษะสำคัญที่ต้องการคืออะไร?</h4>
                  </div>
                  <input
                    type="text"
                    placeholder="เช่น Cloudflare Workers, Hono, Wrangler, SQLite, JWT"
                    value={wizardTechStack}
                    onChange={(e) => setWizardTechStack(e.target.value)}
                    className="form-input"
                  />
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
                    <button type="button" onClick={() => setAiWizardStep(2)} className="tech-button-outline" style={{ borderRadius: "1rem" }}>กลับ</button>
                    <button type="button" onClick={() => setAiWizardStep(4)} disabled={!wizardTechStack.trim()} className="tech-button-primary" style={{ borderRadius: "1rem" }}>ถัดไป</button>
                  </div>
                </motion.div>
              )}

              {aiWizardStep === 4 && (
                <motion.div key="step4" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <div>
                    <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>ขั้นตอนที่ 4 จาก 5</label>
                    <h4 style={{ fontSize: "15px", color: "#fff", fontWeight: "bold", margin: "4px 0 0 0" }}>ระยะเวลาหรือกรอบเวลาของโปรเจกต์ที่คาดหวังคือเท่าใด?</h4>
                  </div>
                  <input
                    type="text"
                    placeholder="เช่น 2 สัปดาห์, 1 เดือน, 3 วัน"
                    value={wizardDuration}
                    onChange={(e) => setWizardDuration(e.target.value)}
                    className="form-input"
                  />
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
                    <button type="button" onClick={() => setAiWizardStep(3)} className="tech-button-outline" style={{ borderRadius: "1rem" }}>กลับ</button>
                    <button type="button" onClick={() => setAiWizardStep(5)} disabled={!wizardDuration.trim()} className="tech-button-primary" style={{ borderRadius: "1rem" }}>ถัดไป</button>
                  </div>
                </motion.div>
              )}

              {aiWizardStep === 5 && (
                <motion.div key="step5" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <div>
                    <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>ขั้นตอนที่ 5 จาก 5</label>
                    <h4 style={{ fontSize: "15px", color: "#fff", fontWeight: "bold", margin: "4px 0 0 0" }}>งบประมาณที่คุณต้องการคือเท่าใด? (บาท)</h4>
                  </div>
                  <div style={{ display: "flex", gap: "10px" }}>
                    <select
                      value={wizardBudgetType}
                      onChange={(e) => setWizardBudgetType(e.target.value as "fixed" | "hourly")}
                      style={{
                        padding: "10px 14px",
                        borderRadius: "1rem",
                        border: "1px solid var(--border-subtle)",
                        backgroundColor: "#fff",
                        color: "var(--text-primary)",
                        fontSize: "14px",
                        outline: "none",
                        width: "150px"
                      }}
                    >
                      <option value="fixed">ราคาเหมาจ่าย</option>
                      <option value="hourly">คิดรายชั่วโมง</option>
                    </select>
                    <input
                      type="text"
                      placeholder={wizardBudgetType === "fixed" ? "เช่น ฿15,000 - ฿25,000" : "เช่น ฿500 - ฿800 / ชม."}
                      value={wizardBudgetRange}
                      onChange={(e) => setWizardBudgetRange(e.target.value)}
                      className="form-input"
                      style={{ flex: 1 }}
                    />
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
                    <button type="button" onClick={() => setAiWizardStep(4)} className="tech-button-outline" style={{ borderRadius: "1rem" }}>กลับ</button>
                    <button 
                      type="button" 
                      onClick={handleRunAiScopeGenerator} 
                      disabled={!wizardBudgetRange.trim() || aiGeneratingScope} 
                      className="tech-button-primary" 
                      style={{ borderRadius: "1rem", display: "inline-flex", alignItems: "center", gap: "6px", opacity: aiGeneratingScope ? 0.5 : 1 }}
                    >
                      <Zap size={14} />
                      {aiGeneratingScope ? "กำลังสร้าง…" : "สร้างขอบเขตงานและประเมินขนาด"}
                    </button>
                  </div>
                </motion.div>
              )}

              {aiWizardStep === 6 && (
                <motion.div key="step6" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <div>
                    <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>ขั้นตอนที่ 6 จาก 6: ตรวจสอบและเผยแพร่</label>
                    <h4 style={{ fontSize: "15px", color: "#fff", fontWeight: "bold", margin: "4px 0 0 0" }}>ตรวจสอบขอบเขตงานที่ AI สร้าง</h4>
                  </div>
                  
                  <div className="form-group">
                    <label className="form-label" style={{ fontWeight: "600", fontSize: "13px", color: "var(--text-primary)", display: "block", marginBottom: "6px" }}>
                      ชื่อโปรเจกต์
                    </label>
                    <input
                      type="text"
                      value={tempDraftTitle}
                      onChange={(e) => setTempDraftTitle(e.target.value)}
                      className="form-input"
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label" style={{ fontWeight: "600", fontSize: "13px", color: "var(--text-primary)", display: "block", marginBottom: "6px" }}>
                      คำอธิบายโดยย่อ
                    </label>
                    <textarea
                      value={tempDraftDesc}
                      onChange={(e) => setTempDraftDesc(e.target.value)}
                      className="form-input"
                      rows={2}
                      required
                      style={{ resize: "vertical", fontFamily: "inherit" }}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label" style={{ fontWeight: "600", fontSize: "13px", color: "var(--text-primary)", display: "block", marginBottom: "6px" }}>
                      ขอบเขตงาน (SOW)
                    </label>
                    <textarea
                      value={tempDraftSOW}
                      onChange={(e) => setTempDraftSOW(e.target.value)}
                      className="form-input"
                      rows={6}
                      required
                      style={{ resize: "vertical", fontFamily: "inherit" }}
                    />
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                    <div className="form-group">
                      <label className="form-label" style={{ fontWeight: "600", fontSize: "13px", color: "var(--text-primary)", display: "block", marginBottom: "6px" }}>
                        งบประมาณ ({budgetTypeLabel(wizardBudgetType)})
                      </label>
                      <input
                        type="text"
                        value={tempDraftBudget}
                        onChange={(e) => setTempDraftBudget(e.target.value)}
                        className="form-input"
                        required
                      />
                    </div>
                    
                    <div className="form-group">
                      <label className="form-label" style={{ fontWeight: "600", fontSize: "13px", color: "var(--text-primary)", display: "block", marginBottom: "6px" }}>
                        เลเวลขั้นต่ำ
                      </label>
                      <select
                        value={tempDraftMinLevel}
                        onChange={(e) => setTempDraftMinLevel(e.target.value)}
                        style={{
                          width: "100%",
                          padding: "10px 14px",
                          borderRadius: "1rem",
                          border: "1px solid var(--border-subtle)",
                          backgroundColor: "#fff",
                          color: "var(--text-primary)",
                          fontSize: "14px",
                          outline: "none"
                        }}
                      >
                        <option value="1">เลเวล 1+</option>
                        <option value="2">เลเวล 2+</option>
                        <option value="3">เลเวล 3+</option>
                        <option value="4">เลเวล 4+</option>
                        <option value="5">เลเวล 5+</option>
                      </select>
                    </div>
                  </div>

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
                    <button type="button" onClick={() => setAiWizardStep(5)} className="tech-button-outline" style={{ borderRadius: "1rem" }}>กลับ</button>
                    <button 
                      type="button" 
                      onClick={handleConfirmAiDraft}
                      disabled={outsourceLoading}
                      className="tech-button-primary" 
                      style={{ borderRadius: "1rem", display: "inline-flex", alignItems: "center", gap: "6px" }}
                    >
                      {outsourceLoading ? "กำลังเผยแพร่…" : "เผยแพร่ขึ้นตลาดงาน"}
                    </button>
                  </div>
                </motion.div>
              )}
              </AnimatePresence>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      {showConfetti && <Confetti recycle={false} numberOfPieces={500} onConfettiComplete={() => setShowConfetti(false)} style={{ zIndex: 9999 }} />}

      {/* Table styling details */}
      <style>{`
        .table-row-hover:hover {
          background: rgba(0, 0, 0, 0.02) !important;
        }
      `}</style>
    </div>
  );
};
export default HRConsole;
