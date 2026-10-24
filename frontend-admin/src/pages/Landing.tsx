import React, { useState, useEffect } from "react";
import { useApi, User } from "../hooks/useApi";
import logo from "../../logo/NetPrimeLogo.png";
import serverRack from "../../logo/server_rack_hero.png";
import { SiteTopBar, ScheduleSection, PromotionsSection, ArticlesSection, ContactSection } from "../components/site/PublicSections";
import { motion, AnimatePresence } from "framer-motion";
import { 
  ArrowRight, 
  Mail, 
  ShieldCheck, 
  Network, 
  Terminal, 
  CloudLightning,
  Clock,
  Star,
  Users,
  Shield,
  Zap,
  Cloud,
  X,
  User as UserIcon,
  ChevronRight,
  BrainCircuit,
  Search,
  Check,
  ChevronDown,
  Building2,
  HelpCircle,
  Play,
  FileText,
  DollarSign,
  TrendingUp,
  Cpu,
  Sparkles,
  Award,
  CheckCircle
} from "lucide-react";

interface LandingProps {
  onLogin: (token: string, user: User) => void;
}

type MenuTab = 
  | "home"
  | "why"
  | "training"
  | "certifications"
  | "enterprise"
  | "resources"
  | "pricing"
  | "company"
  | "schedule"
  | "articles"
  | "contact";

export const Landing: React.FC<LandingProps> = ({ onLogin }) => {
  const api = useApi();
  
  // Navigation & UI States
  const [activeTab, setActiveTab] = useState<MenuTab>("home");

  // In-page links from coordinator content (announcement, promotions) such as "#schedule".
  const navigateTo = (target: string) => {
    if (target === "schedule" || target === "articles" || target === "contact") {
      setActiveTab(target);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      setActiveTab("home");
      setTimeout(() => document.getElementById(target)?.scrollIntoView({ behavior: "smooth" }), 300);
    }
  };
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [registering, setRegistering] = useState(false);
  const [providers, setProviders] = useState<Record<string, { enabled: boolean }>>({});
  useEffect(() => {
    api.get<{ providers: Record<string, { enabled: boolean }> }>("/auth/oauth/providers")
      .then(data => setProviders(data.providers)).catch(() => setProviders({}));
  }, []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLoginModal, setShowLoginModal] = useState(false);

  // Dynamic courses states
  const [courses, setCourses] = useState<any[]>([]);
  const [coursesLoading, setCoursesLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");

  // Selected Course details modal (For public viewing details/simulated buy)
  const [selectedCourse, setSelectedCourse] = useState<any | null>(null);

  // FAQ collapse state
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(null);

  // Pricing toggle state (Monthly / Yearly)
  const [isYearly, setIsYearly] = useState(false);

  // Live countdown timer state (14h 22m 45s)
  const [timeLeft, setTimeLeft] = useState({ hours: 14, minutes: 22, seconds: 45 });

  // Certificate verification states
  const [verificationCode, setVerificationCode] = useState("");
  const [verificationLoading, setVerificationLoading] = useState(false);
  const [verificationResult, setVerificationResult] = useState<any | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft(prev => {
        let s = prev.seconds - 1;
        let m = prev.minutes;
        let h = prev.hours;
        if (s < 0) {
          s = 59;
          m -= 1;
        }
        if (m < 0) {
          m = 59;
          h -= 1;
        }
        if (h < 0) {
          h = 23;
        }
        return { hours: h, minutes: m, seconds: s };
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch courses dynamically from SQLite D1 database
  const loadDynamicCourses = async () => {
    try {
      setCoursesLoading(true);
      const res = await api.get<any[]>("/courses");
      setCourses(res);
    } catch (err) {
      console.error("Failed to load courses dynamically:", err);
    } finally {
      setCoursesLoading(false);
    }
  };

  useEffect(() => {
    loadDynamicCourses();
  }, [api.token]);

  // URL-based certificate verification trigger
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code") || params.get("verify");
    if (code) {
      setActiveTab("certifications");
      setVerificationCode(code);
      
      // Execute verify
      setTimeout(async () => {
        setVerificationLoading(true);
        try {
          const res = await api.get<any>(`/certificates/verify/${code.toUpperCase().trim()}`);
          setVerificationResult(res);
        } catch (err: any) {
          setVerificationResult({ verified: false, error: err.message || "รหัสตรวจสอบใบประกาศนียบัตรไม่ถูกต้อง" });
        } finally {
          setVerificationLoading(false);
        }
      }, 300);
    }
  }, []);

  // Form certificate verification handler
  const handleVerifyCertificate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!verificationCode.trim()) return;

    try {
      setVerificationLoading(true);
      setVerificationResult(null);
      const res = await api.get<any>(`/certificates/verify/${verificationCode.toUpperCase().trim()}`);
      setVerificationResult(res);
    } catch (err: any) {
      console.error(err);
      setVerificationResult({ verified: false, error: err.message || "รหัสตรวจสอบใบประกาศนียบัตรไม่ถูกต้อง" });
    } finally {
      setVerificationLoading(false);
    }
  };

  const handleAuth = async (targetEmail: string) => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.post<{ token: string; user: User }>(registering ? "/auth/register" : "/auth/login", registering ? { email: targetEmail, password, name } : { email: targetEmail, password });
      onLogin(res.token, res.user);
      setShowLoginModal(false);
      setPassword("");
    } catch (err: any) {
      console.error(err);
      setError(err.message || "ไม่สามารถเข้าสู่ระบบได้ กรุณาตรวจสอบอีเมลและรหัสผ่าน");
    } finally {
      setLoading(false);
    }
  };

  const handleOAuthLogin = async (provider: "google" | "microsoft" | "github") => {
    try {
      setLoading(true);
      setError(null);
      const redirectUri = `${window.location.origin}/auth/callback/${provider}`;
      const data = await api.get<{ url: string; state: string }>(`/auth/oauth/${provider}/url?redirect_uri=${encodeURIComponent(redirectUri)}`);
      sessionStorage.setItem("netprime_oauth", JSON.stringify({ state: data.state, provider, redirectUri }));
      window.location.assign(data.url);
    } catch (err: any) {
      setError(err.message || "ไม่สามารถเริ่มการเข้าสู่ระบบได้");
      setLoading(false);
    }
  };

  // Helper to get fallback course details for badges
  const getCourseVendor = (title: string) => {
    const t = title.toUpperCase();
    if (t.includes("AWS")) return "AWS";
    if (t.includes("AZURE") || t.includes("AZ-")) return "Azure";
    if (t.includes("GOOGLE") || t.includes("GCP")) return "Google Cloud";
    if (t.includes("CISCO") || t.includes("CCNA") || t.includes("CCNP")) return "Cisco";
    if (t.includes("ARISTA")) return "Arista";
    if (t.includes("ARUBA")) return "Aruba";
    if (t.includes("JUNIPER")) return "Juniper";
    if (t.includes("NUTANIX")) return "Nutanix";
    if (t.includes("HUAWEI")) return "Huawei";
    return "Network";
  };

  const getCourseXp = (price: number) => {
    if (price >= 150) return "300 XP";
    if (price >= 100) return "200 XP";
    return "100 XP";
  };

  const getCourseHours = (title: string) => {
    const t = title.toUpperCase();
    if (t.includes("ADVANCED") || t.includes("PRACTITIONER")) return "20 ชั่วโมง";
    if (t.includes("FUNDAMENTALS") || t.includes("FOUNDATIONS")) return "15 ชั่วโมง";
    return "12 ชั่วโมง";
  };

  const getFallbackCover = (title: string) => {
    const v = getCourseVendor(title);
    if (v === "AWS") return "https://images.unsplash.com/photo-1546182990-dffeafbe841d?q=80&w=600&auto=format&fit=crop";
    if (v === "Azure") return "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?q=80&w=600&auto=format&fit=crop";
    if (v === "Google Cloud") return "https://images.unsplash.com/photo-1454496522488-7a8e488e8606?q=80&w=600&auto=format&fit=crop";
    return "https://images.unsplash.com/photo-1451187580459-43490279c0fa?q=80&w=600&auto=format&fit=crop";
  };

  // Filter courses dynamically based on Search Query and Selected Category
  const filteredCourses = courses.filter(course => {
    const matchesSearch = course.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          course.description.toLowerCase().includes(searchQuery.toLowerCase());
    
    if (selectedCategory === "All") return matchesSearch;
    const vendor = getCourseVendor(course.title);
    return matchesSearch && vendor === selectedCategory;
  });

  // Unique categories helper list for dynamic catalog filtering
  const categories = ["All", "AWS", "Azure", "Google Cloud", "Cisco", "Arista", "Juniper", "Network"];

  // FAQs data list
  const faqs = [
    {
      q: "NetPrime มีห้องแลปจำลองให้ลงมือปฏิบัติจริงหรือไม่",
      a: "มี ทุกบทเรียนเชื่อมกับแลปจำลองโทโพโลยีเครือข่าย ผู้เรียนสามารถตรวจสอบ ตั้งค่า และแก้ไขปัญหาอุปกรณ์เครือข่ายได้ผ่านระบบจำลองของเรา"
    },
    {
      q: "ระยะเวลาเข้าถึงคอร์สเป็นอย่างไร",
      a: "ขึ้นอยู่กับการตั้งค่าของแต่ละคอร์ส บางคอร์สเข้าถึงได้ตลอดชีพ บางคอร์สมีกำหนดระยะเวลา (เช่น 30 วัน) โดยนับตั้งแต่วันที่ชำระเงินหรือวันที่ผู้ดูแลระบบมอบสิทธิ์"
    },
    {
      q: "ลูกค้าองค์กรสามารถติดตามความคืบหน้าของผู้เรียนได้หรือไม่",
      a: "ได้ พาร์ตเนอร์องค์กรมีแดชบอร์ดเฉพาะสำหรับดูข้อมูลสมาชิก การเรียนจบคอร์ส สถิติความคืบหน้าเฉลี่ย และประวัติการจัดสรรที่นั่งด้วยโค้ดส่วนลด"
    },
    {
      q: "รองรับการชำระเงินแบบใดบ้าง",
      a: "รองรับการชำระเงินด้วยบัตรและการใช้โค้ดส่วนลด โดยโค้ดส่วนลดตั้งค่าให้ใช้ได้ทั้งเว็บไซต์หรือเฉพาะบางใบรับรองได้"
    }
  ];

  // ==========================================
  // SUB-PAGES RENDER HELPER FUNCTIONS
  // ==========================================

  const renderHomeTab = () => {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "64px" }}>
        
        {/* HERO / MAIN SECTION */}
        <section style={{ 
          display: "grid", 
          gridTemplateColumns: "1.1fr 0.9fr", 
          gap: "48px", 
          alignItems: "center", 
          paddingTop: "12px"
        }}>
          {/* Left Copywriting */}
          <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
            <div>
              <div style={{ 
                display: "inline-flex", 
                alignItems: "center", 
                gap: "6px", 
                background: "rgba(229,107,37,0.06)", 
                border: "1px solid rgba(229,107,37,0.15)", 
                borderRadius: "99px", 
                padding: "6px 16px",
                color: "#e56b25",
                fontWeight: 700,
                fontSize: "11px",
                letterSpacing: "0.5px",
                textTransform: "uppercase",
                fontFamily: "Anuphan, sans-serif"
              }}>
                <BrainCircuit size={12} />
                พัฒนาสถาปนิกแห่งอนาคต
              </div>
            </div>

            <h1 style={{ 
              fontSize: "64px", 
              lineHeight: "1.1", 
              fontWeight: 850, 
              color: "var(--text-primary)",
              letterSpacing: "-1.5px",
              fontFamily: "Anuphan, sans-serif"
            }}>
              เชี่ยวชาญ <span style={{ color: "#e56b25" }}>คลาวด์</span> <br />
              และ Edge <br />
              ของโครงสร้างพื้นฐาน
            </h1>

            <p style={{ 
              fontSize: "16px", 
              color: "var(--text-secondary)", 
              lineHeight: "1.6", 
              maxWidth: "520px" 
            }}>
              NetPrime จัดอบรมมาตรฐานองค์กรด้านเครือข่าย ความปลอดภัย ระบบ และคลาวด์ โดยผู้เชี่ยวชาญที่ได้รับการรับรอง ครอบคลุม AWS, Azure, Cisco และอื่น ๆ
            </p>

            <div style={{ display: "flex", gap: "16px" }}>
              <button 
                onClick={() => setActiveTab("training")}
                className="tech-button-primary"
                style={{ borderRadius: "1rem", padding: "14px 28px", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px" }}
              >
                สำรวจคอร์สเรียน
                <ArrowRight size={16} />
              </button>

              <button 
                onClick={() => {
                  setError(null);
                  setEmail("");
                  setRegistering(true);
                  setPassword("");
                  setShowLoginModal(true);
                }}
                className="tech-button-outline"
                style={{ 
                  borderRadius: "1rem", 
                  padding: "14px 28px", 
                  fontSize: "14px", 
                  color: "var(--text-primary)", 
                  borderColor: "#e2e8f0", 
                  display: "flex", 
                  alignItems: "center", 
                  gap: "8px" 
                }}
              >
                <UserIcon size={16} />
                สมัครสมาชิก
              </button>
            </div>

            {/* Student satisfaction indicators */}
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "12px" }}>
              <div style={{ display: "flex", alignItems: "center" }}>
                {[
                  "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=80&auto=format&fit=crop&q=60",
                  "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=80&auto=format&fit=crop&q=60",
                  "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=80&auto=format&fit=crop&q=60",
                  "https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=80&auto=format&fit=crop&q=60"
                ].map((src, i) => (
                  <img 
                    key={i} 
                    src={src} 
                    alt="ผู้เรียน" 
                    style={{ 
                      width: "36px", 
                      height: "36px", 
                      borderRadius: "50%", 
                      border: "2px solid #ffffff", 
                      marginLeft: i === 0 ? "0" : "-10px",
                      objectFit: "cover"
                    }} 
                  />
                ))}
                <div style={{ 
                  width: "36px", 
                  height: "36px", 
                  borderRadius: "50%", 
                  backgroundColor: "#e56b25", 
                  border: "2px solid #ffffff", 
                  marginLeft: "-10px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#ffffff",
                  fontSize: "11px",
                  fontWeight: "700"
                }}>
                  +12k
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <Star size={14} color="#f59e0b" fill="#f59e0b" />
                  <span style={{ fontSize: "14px", fontWeight: "700", color: "var(--text-primary)" }}>4.9/5</span>
                </div>
                <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>คะแนนความพึงพอใจของผู้เรียน</span>
              </div>
            </div>
          </div>

          {/* Right Server Rack Illustration & Floating Badges */}
          <div style={{ position: "relative", justifySelf: "center", width: "100%", maxWidth: "580px" }}>
            
            {/* Main Server Graphic */}
            <div style={{ borderRadius: "2rem", overflow: "hidden", boxShadow: "0 20px 40px -15px rgba(0,0,0,0.15)", border: "1px solid rgba(0,0,0,0.05)" }}>
              <img 
                src={serverRack} 
                alt="ตู้เซิร์ฟเวอร์ในห้องเซิร์ฟเวอร์" 
                style={{ width: "100%", height: "auto", display: "block" }} 
              />
            </div>

            {/* Floating Card: Security Expert Path (Top-Left) */}
            <motion.div 
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.2, duration: 0.5 }}
              style={{ 
                position: "absolute", 
                top: "40px", 
                left: "-30px", 
                backgroundColor: "rgba(255, 255, 255, 0.9)", 
                backdropFilter: "blur(12px)",
                border: "1px solid rgba(255,255,255,0.8)",
                borderRadius: "1rem", 
                padding: "12px 20px", 
                display: "flex", 
                alignItems: "center", 
                gap: "12px",
                boxShadow: "0 10px 25px -5px rgba(0,0,0,0.08)"
              }}
            >
              <div style={{ 
                width: "36px", 
                height: "36px", 
                borderRadius: "50%", 
                backgroundColor: "rgba(16, 185, 129, 0.1)", 
                display: "flex", 
                alignItems: "center", 
                justifyContent: "center",
                color: "#10b981"
              }}>
                <Shield size={18} />
              </div>
              <div>
                <span style={{ fontSize: "10px", fontWeight: "700", color: "var(--text-muted)", display: "block", letterSpacing: "0.5px" }}>ผู้เชี่ยวชาญด้านความปลอดภัย</span>
                <span style={{ fontSize: "13px", fontWeight: "700", color: "var(--text-primary)" }}>เส้นทางรับรอง</span>
              </div>
            </motion.div>

            {/* Floating Card: Cloud Associate Path (Bottom-Right) */}
            <motion.div 
              initial={{ y: -10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.4, duration: 0.5 }}
              style={{ 
                position: "absolute", 
                bottom: "80px", 
                right: "-30px", 
                backgroundColor: "rgba(255, 255, 255, 0.9)", 
                backdropFilter: "blur(12px)",
                border: "1px solid rgba(255,255,255,0.8)",
                borderRadius: "1rem", 
                padding: "12px 20px", 
                display: "flex", 
                alignItems: "center", 
                gap: "12px",
                boxShadow: "0 10px 25px -5px rgba(0,0,0,0.08)"
              }}
            >
              <div style={{ 
                width: "36px", 
                height: "36px", 
                borderRadius: "50%", 
                backgroundColor: "rgba(59, 130, 246, 0.1)", 
                display: "flex", 
                alignItems: "center", 
                justifyContent: "center",
                color: "#3b82f6"
              }}>
                <Cloud size={18} />
              </div>
              <div>
                <span style={{ fontSize: "10px", fontWeight: "700", color: "var(--text-muted)", display: "block", letterSpacing: "0.5px" }}>คลาวด์ระดับ Associate</span>
                <span style={{ fontSize: "13px", fontWeight: "700", color: "var(--text-primary)" }}>เส้นทางเร่งรัด</span>
              </div>
            </motion.div>
          </div>
        </section>

        {/* DYNAMIC COURSE DISCOVER SECTION */}
        <section id="explore-certs" style={{ borderTop: "1px solid rgba(0,0,0,0.05)", paddingTop: "48px" }}>
          
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: "40px" }}>
            <div>
              <h2 style={{ fontSize: "36px", fontWeight: 800, fontFamily: "Anuphan, sans-serif", color: "var(--text-primary)", letterSpacing: "-1px" }}>
                ใบรับรองด้านเครือข่ายระดับแนวหน้า
              </h2>
              <p style={{ fontSize: "16px", color: "var(--text-secondary)", marginTop: "6px" }}>
                การอบรมเข้มข้น ออกแบบเพื่อใช้งานจริง
              </p>
            </div>
            
            <button 
              onClick={() => setActiveTab("training")}
              style={{ 
                background: "none", 
                border: "none", 
                color: "#e56b25", 
                fontWeight: 700, 
                fontSize: "15px", 
                cursor: "pointer", 
                display: "flex", 
                alignItems: "center", 
                gap: "4px" 
              }}
            >
              ดูหลักสูตรทั้งหมด
              <ChevronRight size={16} />
            </button>
          </div>

          {coursesLoading ? (
            <div style={{ display: "flex", justifyContent: "center", padding: "48px" }}>
              <div className="spinner" style={{ border: "3px solid var(--border-subtle)", borderTop: "3px solid var(--primary)", borderRadius: "50%", width: "32px", height: "32px", animation: "spin 1s linear infinite" }} />
            </div>
          ) : courses.length === 0 ? (
            <div style={{ padding: "40px", textShadow: "none", textAlign: "center", color: "var(--text-secondary)" }} className="glass-card">
              ยังไม่มีใบรับรองในระบบ กรุณาเข้าสู่ระบบด้วยบัญชีผู้ดูแลระบบเพื่อเพิ่มคอร์สเริ่มต้น
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "32px" }}>
              {courses.slice(0, 3).map((cert) => (
                <div 
                  key={cert.id} 
                  className="glass-card" 
                  onClick={() => setSelectedCourse(cert)}
                  style={{ 
                    padding: "0", 
                    overflow: "hidden", 
                    borderRadius: "1.5rem", 
                    border: "1px solid rgba(0, 0, 0, 0.05)",
                    display: "flex", 
                    flexDirection: "column",
                    height: "100%",
                    background: "#ffffff",
                    cursor: "pointer"
                  }}
                >
                  <div style={{ position: "relative", height: "200px" }}>
                    <img 
                      src={cert.cover_image_url || getFallbackCover(cert.title)} 
                      alt={cert.title} 
                      style={{ width: "100%", height: "100%", objectFit: "cover" }} 
                    />
                    
                    <div style={{ 
                      position: "absolute", 
                      top: "16px", 
                      left: "16px", 
                      backgroundColor: "rgba(15, 23, 42, 0.75)", 
                      color: "#ffffff", 
                      fontSize: "11px", 
                      fontWeight: 800, 
                      padding: "4px 10px", 
                      borderRadius: "6px",
                      letterSpacing: "0.5px"
                    }}>
                      {getCourseVendor(cert.title)}
                    </div>

                    <div style={{ 
                      position: "absolute", 
                      bottom: "16px", 
                      right: "16px", 
                      backgroundColor: "#e56b25", 
                      color: "#ffffff", 
                      fontSize: "11px", 
                      fontWeight: 800, 
                      padding: "4px 10px", 
                      borderRadius: "99px",
                      display: "flex",
                      alignItems: "center",
                      gap: "4px"
                    }}>
                      <Zap size={11} fill="#ffffff" />
                      {getCourseXp(cert.price || 0)}
                    </div>
                  </div>

                  <div style={{ padding: "24px", display: "flex", flexDirection: "column", flexGrow: 1, gap: "16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                      <span style={{ 
                        backgroundColor: "rgba(229,107,37,0.08)", 
                        color: "#e56b25", 
                        fontSize: "11px", 
                        fontWeight: 800, 
                        padding: "3px 8px", 
                        borderRadius: "6px",
                        letterSpacing: "0.5px"
                      }}>
                        เริ่มต้น
                      </span>
                      <span style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "var(--text-secondary)" }}>
                        <Clock size={13} />
                        {getCourseHours(cert.title)}
                      </span>
                    </div>

                    <div>
                      <h3 style={{ fontSize: "18px", fontWeight: 800, color: "var(--text-primary)", lineHeight: "1.3", marginBottom: "8px" }}>
                        {cert.title}
                      </h3>
                      <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: "1.5", display: "-webkit-box", WebkitLineClamp: "3", WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                        {cert.description}
                      </p>
                    </div>

                    <div style={{ 
                      marginTop: "auto", 
                      display: "flex", 
                      justifyContent: "space-between", 
                      alignItems: "center",
                      borderTop: "1px solid rgba(0,0,0,0.05)",
                      paddingTop: "16px"
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "13px", fontWeight: "700" }}>
                          <Star size={14} color="#f59e0b" fill="#f59e0b" />
                          4.9
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "var(--text-secondary)" }}>
                          <Users size={13} />
                          {(cert.student_count || 1.2).toFixed(1)}k
                        </div>
                      </div>

                      <span style={{ fontSize: "18px", fontWeight: 800, color: "var(--text-primary)" }}>
                        {cert.price && cert.price > 0 ? `฿${cert.price}` : "ฟรี"}
                      </span>
                    </div>
                  </div>

                </div>
              ))}
            </div>
          )}
        </section>

        {/* DYNAMIC WEBSITE CONTENT (managed in Admin › จัดการเว็บไซต์) */}
        <ScheduleSection limit={4} onViewAll={() => navigateTo("schedule")} />
        <PromotionsSection onNavigate={navigateTo} />
        <ArticlesSection limit={4} onViewAll={() => navigateTo("articles")} />

        {/* TESTIMONIALS & TRUST PORTAL */}
        <section style={{ borderTop: "1px solid rgba(0,0,0,0.05)", paddingTop: "48px" }}>
          <div style={{ textAlign: "center", marginBottom: "40px" }}>
            <span style={{ color: "#e56b25", fontWeight: "700", fontSize: "11px", letterSpacing: "1px", textTransform: "uppercase" }}>เสียงจากผู้เรียน</span>
            <h2 style={{ fontSize: "32px", fontWeight: 800, marginTop: "8px" }}>ได้รับความไว้วางใจจากวิศวกรเครือข่ายชั้นนำ</h2>
            <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginTop: "6px" }}>อ่านความเห็นจากศิษย์เก่าที่ผ่านแลปจำลองของหลักสูตรใบรับรอง NetPrime</p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "24px" }}>
            {[
              {
                text: "แลปปฏิบัติเปลี่ยนวิธีเรียนของผมไปเลย แทนที่จะนั่งดูสไลด์ ผมได้สร้างกฎแบ่งเซกเมนต์เครือข่ายบนอินสแตนซ์ edge จริง สอบ CCNA ผ่านแล้ว!",
                author: "Sompong K., Cloud Engineer",
                title: "สอบผ่าน CCNA และ AWS Architect"
              },
              {
                text: "ระบบสำหรับองค์กรของ NetPrime ทำให้การมอบหมายที่นั่งและติดตามข้อมูลการใช้งานง่ายมาก แนะนำสำหรับทีม IT ขององค์กร",
                author: "Varanya S., DevOps Manager",
                title: "จัดสรร 15 ที่นั่ง"
              },
              {
                text: "ขั้นตอนชำระเงินใช้งานง่าย และโค้ดส่วนลดช่วยให้เราประหยัดค่าอบรมไปถึง 50% ชอบหน้าแดชบอร์ดและเครื่องเล่นวิดีโอที่ดูทันสมัยมาก",
                author: "Natdanai T., Cybersecurity Analyst",
                title: "ผู้เรียนคอร์ส Advanced Pentesting"
              }
            ].map((test, i) => (
              <div key={i} className="glass-card" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "16px" }}>
                <div style={{ display: "flex", gap: "2px" }}>
                  {[...Array(5)].map((_, idx) => <Star key={idx} size={14} color="#f59e0b" fill="#f59e0b" />)}
                </div>
                <p style={{ fontSize: "13px", fontStyle: "italic", color: "var(--text-secondary)", lineHeight: "1.6", flexGrow: 1 }}>
                  "{test.text}"
                </p>
                <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "12px" }}>
                  <span style={{ fontSize: "14px", fontWeight: "700", display: "block", color: "var(--text-primary)" }}>{test.author}</span>
                  <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>{test.title}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* FAQs COLLAPSIBLE ACCORDION */}
        <section style={{ borderTop: "1px solid rgba(0,0,0,0.05)", paddingTop: "48px", marginBottom: "32px" }}>
          <div style={{ textAlign: "center", marginBottom: "40px" }}>
            <span style={{ color: "#e56b25", fontWeight: "700", fontSize: "11px", letterSpacing: "1px", textTransform: "uppercase" }}>คำถามที่พบบ่อย</span>
            <h2 style={{ fontSize: "32px", fontWeight: 800, marginTop: "8px" }}>มีคำถาม? เรามีคำตอบ</h2>
          </div>

          <div style={{ maxWidth: "800px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "16px" }}>
            {faqs.map((faq, idx) => {
              const isOpen = openFaqIndex === idx;
              return (
                <div 
                  key={idx} 
                  className="glass-card" 
                  style={{ 
                    padding: "20px", 
                    cursor: "pointer", 
                    border: isOpen ? "1px solid var(--primary)" : "1px solid var(--border-subtle)",
                    background: isOpen ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.6)",
                    borderRadius: "1rem" 
                  }}
                  onClick={() => setOpenFaqIndex(isOpen ? null : idx)}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h4 style={{ fontSize: "15px", fontWeight: "700", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
                      <HelpCircle size={16} color="var(--primary)" />
                      {faq.q}
                    </h4>
                    <ChevronDown size={16} style={{ transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
                  </div>
                  {isOpen && (
                    <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "12px", lineHeight: "1.6" }}>
                      {faq.a}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>


        <ContactSection />
      </div>
    );
  };

  const renderWhyTab = () => {
    return (
      <div className="glass-card animate-fade-in" style={{ padding: "40px" }}>
        <h2 style={{ fontSize: "32px", marginBottom: "12px" }}>ทำไมต้องเลือก NetPrime</h2>
        <p style={{ color: "var(--text-secondary)", marginBottom: "32px", maxWidth: "700px" }}>
          เราให้มากกว่าการดูวิดีโอ NetPrime ผสานสถาปัตยกรรม Cloudflare D1 แบบใช้งานจริง การแคชที่ edge และระบบจำลองแบบโต้ตอบ ไว้ในแพลตฟอร์มเดียว
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "24px", marginBottom: "40px" }}>
          <div className="glass-card" style={{ padding: "24px" }}>
            <span className="badge-gamified">01. ประเมิน</span>
            <h4 style={{ fontSize: "18px", margin: "12px 0 8px 0" }}>ประเมินระดับความรู้</h4>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: "1.6" }}>
              วัดพื้นฐานของผู้เรียน ค้นหาช่องว่างด้านทักษะ และแนะนำเส้นทางใบรับรองที่เหมาะกับเป้าหมายของบุคคลหรือองค์กร
            </p>
          </div>
          <div className="glass-card" style={{ padding: "24px" }}>
            <span className="badge-gamified" style={{ backgroundColor: "var(--secondary-glow)", color: "var(--secondary)", borderColor: "rgba(168, 85, 247, 0.2)" }}>02. เรียนรู้</span>
            <h4 style={{ fontSize: "18px", margin: "12px 0 8px 0" }}>เครื่องเล่นวิดีโอ Cloudflare Stream</h4>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: "1.6" }}>
              เรียนผ่านวิดีโอจากผู้เชี่ยวชาญด้วย URL ที่ลงลายมือชื่อเข้ารหัส ปลอดภัยสูงสุดบน CDN และสตรีมได้ลื่นไหล
            </p>
          </div>
          <div className="glass-card" style={{ padding: "24px" }}>
            <span className="badge-gamified" style={{ backgroundColor: "var(--accent-glow)", color: "var(--accent)", borderColor: "rgba(16, 185, 129, 0.2)" }}>03. ฝึกปฏิบัติ</span>
            <h4 style={{ fontSize: "18px", margin: "12px 0 8px 0" }}>แลปโทโพโลยีปฏิบัติจริง</h4>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: "1.6" }}>
              เชื่อมต่อสวิตช์เครือข่ายเสมือน ตั้งค่า static routing ทดสอบเจาะระบบอินสแตนซ์ CVE และดาวน์โหลดคู่มือ
            </p>
          </div>
        </div>

        <div className="glass-card" style={{ padding: "32px", background: "rgba(229,107,37,0.04)" }}>
          <h4 style={{ fontSize: "18px", marginBottom: "8px" }}>สถาปัตยกรรม Cloudflare Serverless แบบโต้ตอบ</h4>
          <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: "1.6" }}>
            NetPrime ทำงานบน Cloudflare Workers, R2 Buckets และ D1 SQLite ทั้งหมด ช่วยให้ตอบสนองรวดเร็ว ไม่มีฐานข้อมูลหนักหรือการรอโหลดนาน เหลือเพียงการเรียนรู้ที่สมจริง
          </p>
        </div>
      </div>
    );
  };

  const renderTrainingTab = () => {
    return (
      <div className="glass-card animate-fade-in" style={{ padding: "40px" }}>
        {/* Certificate Verification System (Only shown on Certifications tab) */}
        {activeTab === "certifications" && (
          <div style={{
            background: "linear-gradient(135deg, rgba(229,107,37,0.04) 0%, rgba(245,158,11,0.04) 100%)",
            border: "1px solid rgba(229,107,37,0.15)",
            padding: "24px",
            borderRadius: "1.5rem",
            marginBottom: "32px"
          }}>
            <h3 style={{ fontSize: "18px", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
              <Award size={20} color="var(--primary)" />
              ตรวจสอบใบประกาศนียบัตรอย่างเป็นทางการ
            </h3>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "16px" }}>
              นายจ้างและพาร์ตเนอร์องค์กรสามารถตรวจสอบความถูกต้องของใบประกาศนียบัตรดิจิทัลของ Netprime LMS ได้ กรอกรหัสใบประกาศนียบัตรด้านล่าง (เช่น <code>NP-WORKERS-xxxx-xxxx</code>)
            </p>
            <form onSubmit={handleVerifyCertificate} style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
              <input 
                type="text" 
                placeholder="กรอกรหัสใบประกาศนียบัตร..." 
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value)}
                className="form-input"
                style={{ flexGrow: 1, textTransform: "uppercase", padding: "12px 16px", borderRadius: "1rem" }}
              />
              <button 
                type="submit" 
                disabled={verificationLoading || !verificationCode.trim()}
                className="tech-button-primary"
                style={{ padding: "12px 24px", borderRadius: "1rem", cursor: "pointer" }}
              >
                {verificationLoading ? "กำลังตรวจสอบ..." : "ตรวจสอบใบประกาศนียบัตร"}
              </button>
            </form>

            {/* Verification Result Display */}
            {verificationResult && (
              <div style={{ 
                marginTop: "20px", 
                padding: "16px 20px", 
                borderRadius: "1rem", 
                background: verificationResult.verified ? "rgba(16, 185, 129, 0.08)" : "rgba(239, 68, 68, 0.08)",
                border: verificationResult.verified ? "1px solid rgba(16, 185, 129, 0.2)" : "1px solid rgba(239, 68, 68, 0.2)"
              }}>
                {verificationResult.verified ? (
                  <div>
                    <h4 style={{ color: "var(--accent)", fontWeight: "700", display: "flex", alignItems: "center", gap: "6px", fontSize: "14px" }}>
                      <CheckCircle size={16} /> ยืนยันความถูกต้องของใบประกาศนียบัตรแล้ว
                    </h4>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginTop: "12px", fontSize: "13px", color: "var(--text-primary)" }}>
                      <div>
                        <span style={{ color: "var(--text-muted)", fontSize: "11px", display: "block" }}>ชื่อผู้เรียน</span>
                        <strong>{verificationResult.studentName}</strong>
                      </div>
                      <div>
                        <span style={{ color: "var(--text-muted)", fontSize: "11px", display: "block" }}>ชื่อคอร์ส</span>
                        <strong>{verificationResult.courseTitle}</strong>
                      </div>
                      <div>
                        <span style={{ color: "var(--text-muted)", fontSize: "11px", display: "block" }}>วันที่ออก</span>
                        <strong>{new Date(verificationResult.issuedAt).toLocaleDateString("th-TH")}</strong>
                      </div>
                      <div>
                        <span style={{ color: "var(--text-muted)", fontSize: "11px", display: "block" }}>หน่วยงานที่ออก</span>
                        <strong>{verificationResult.verifyingAuthority}</strong>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div>
                    <h4 style={{ color: "var(--danger)", fontWeight: "700", display: "flex", alignItems: "center", gap: "6px", fontSize: "14px" }}>
                      <X size={16} /> การตรวจสอบไม่สำเร็จ
                    </h4>
                    <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px" }}>
                      {verificationResult.error || "รหัสใบประกาศนียบัตรไม่ถูกต้องหรือไม่พบในระบบของเรา"}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px", flexWrap: "wrap", gap: "16px" }}>
          <div>
            <h2 style={{ fontSize: "32px" }}>{activeTab === "certifications" ? "ใบรับรองระดับมืออาชีพ" : "สำรวจหลักสูตรและใบรับรอง"}</h2>
            <p style={{ color: "var(--text-secondary)" }}>{activeTab === "certifications" ? "รับใบรับรองที่เป็นที่ยอมรับในอุตสาหกรรมผ่านเส้นทางการอบรมของ Netprime" : "เลือกดูเส้นทางการอบรมที่เปิดสอนอยู่ในขณะนี้"}</p>
          </div>
        </div>

        {/* Search & Category Filter System */}
        <div style={{ display: "flex", gap: "16px", marginBottom: "32px", flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ position: "relative", flexGrow: 1, minWidth: "250px" }}>
            <Search size={16} color="var(--text-muted)" style={{ position: "absolute", left: "14px", top: "14px" }} />
            <input 
              type="text" 
              placeholder="ค้นหาคอร์สด้วยคำสำคัญ..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="form-input"
              style={{ paddingLeft: "42px" }}
            />
          </div>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {categories.map((cat) => (
              <button 
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                style={{ 
                  padding: "8px 16px", 
                  borderRadius: "99px", 
                  border: selectedCategory === cat ? "1px solid var(--primary)" : "1px solid var(--border-subtle)",
                  background: selectedCategory === cat ? "var(--primary)" : "rgba(255,255,255,0.6)",
                  color: selectedCategory === cat ? "#ffffff" : "var(--text-primary)",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: "pointer",
                  transition: "all 0.2s"
                }}
              >
                {cat === "All" ? "ทั้งหมด" : cat === "Network" ? "เครือข่าย" : cat}
              </button>
            ))}
          </div>
        </div>

        {/* Grid List */}
        {coursesLoading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "64px" }}>
            <div className="spinner" style={{ border: "3px solid var(--border-subtle)", borderTop: "3px solid var(--primary)", borderRadius: "50%", width: "40px", height: "40px", animation: "spin 1s linear infinite" }} />
          </div>
        ) : filteredCourses.length === 0 ? (
          <div style={{ padding: "48px", textAlign: "center", color: "var(--text-secondary)" }}>
            ไม่พบคอร์สที่ตรงกับคำค้นหาหรือหมวดหมู่ที่เลือก
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "24px" }}>
            {filteredCourses.map((cert) => (
              <div 
                key={cert.id} 
                className="glass-card" 
                onClick={() => setSelectedCourse(cert)}
                style={{ 
                  padding: "0", 
                  overflow: "hidden", 
                  borderRadius: "1.5rem", 
                  border: "1px solid rgba(0, 0, 0, 0.05)",
                  display: "flex", 
                  flexDirection: "column",
                  height: "100%",
                  background: "#ffffff",
                  cursor: "pointer"
                }}
              >
                <div style={{ position: "relative", height: "180px" }}>
                  <img 
                    src={cert.cover_image_url || getFallbackCover(cert.title)} 
                    alt={cert.title} 
                    style={{ width: "100%", height: "100%", objectFit: "cover" }} 
                  />
                  
                  <div style={{ 
                    position: "absolute", 
                    top: "12px", 
                    left: "12px", 
                    backgroundColor: "rgba(15, 23, 42, 0.75)", 
                    color: "#ffffff", 
                    fontSize: "10px", 
                    fontWeight: 800, 
                    padding: "3px 8px", 
                    borderRadius: "6px"
                  }}>
                    {getCourseVendor(cert.title)}
                  </div>

                  <div style={{ 
                    position: "absolute", 
                    bottom: "12px", 
                    right: "12px", 
                    backgroundColor: "#e56b25", 
                    color: "#ffffff", 
                    fontSize: "10px", 
                    fontWeight: 800, 
                    padding: "3px 8px", 
                    borderRadius: "99px",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px"
                  }}>
                    <Zap size={10} fill="#ffffff" />
                    {getCourseXp(cert.price || 0)}
                  </div>
                </div>

                <div style={{ padding: "20px", display: "flex", flexDirection: "column", flexGrow: 1, gap: "12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <span style={{ 
                      backgroundColor: "rgba(229,107,37,0.08)", 
                      color: "#e56b25", 
                      fontSize: "10px", 
                      fontWeight: 800, 
                      padding: "2px 6px", 
                      borderRadius: "6px"
                    }}>
                      เริ่มต้น
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "11px", color: "var(--text-secondary)" }}>
                      <Clock size={12} />
                      {getCourseHours(cert.title)}
                    </span>
                  </div>

                  <div>
                    <h3 style={{ fontSize: "16px", fontWeight: 800, color: "var(--text-primary)", lineHeight: "1.3", marginBottom: "6px" }}>
                      {cert.title}
                    </h3>
                    <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: "1.4", display: "-webkit-box", WebkitLineClamp: "3", WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                      {cert.description}
                    </p>
                  </div>

                  <div style={{ 
                    marginTop: "auto", 
                    display: "flex", 
                    justifyContent: "space-between", 
                    alignItems: "center",
                    borderTop: "1px solid rgba(0,0,0,0.05)",
                    paddingTop: "12px"
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <Star size={12} color="#f59e0b" fill="#f59e0b" />
                      <span style={{ fontSize: "12px", fontWeight: "700" }}>4.9</span>
                    </div>

                    <span style={{ fontSize: "16px", fontWeight: 800, color: "var(--text-primary)" }}>
                      {cert.price && cert.price > 0 ? `฿${cert.price}` : "ฟรี"}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderEnterpriseTab = () => {
    return (
      <div className="glass-card animate-fade-in" style={{ padding: "40px" }}>
        <h2 style={{ fontSize: "32px", marginBottom: "8px" }}>โซลูชันการอบรมสำหรับองค์กร</h2>
        <p style={{ color: "var(--text-secondary)", marginBottom: "32px" }}>
          ยกระดับขีดความสามารถของทีมวิศวกรด้วยระบบเรียนรู้สำหรับองค์กรที่รองรับหลายหน่วยงาน
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px", marginBottom: "40px", alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div style={{ display: "flex", gap: "16px" }}>
              <div style={{ padding: "10px", borderRadius: "10px", backgroundColor: "rgba(229,107,37,0.1)", color: "#e56b25", alignSelf: "start" }}>
                <Building2 size={20} />
              </div>
              <div>
                <h4 style={{ fontSize: "16px", fontWeight: "700" }}>บริหารจัดการที่นั่งขององค์กร</h4>
                <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "4px" }}>
                  จัดสรรที่นั่งให้วิศวกรได้ตามต้องการ รีเซ็ตข้อมูลเข้าสู่ระบบของผู้เรียน และเพิกถอนสิทธิ์เมื่อมีการเปลี่ยนบทบาท
                </p>
              </div>
            </div>

            <div style={{ display: "flex", gap: "16px" }}>
              <div style={{ padding: "10px", borderRadius: "10px", backgroundColor: "rgba(168,85,247,0.1)", color: "var(--secondary)", alignSelf: "start" }}>
                <TrendingUp size={20} />
              </div>
              <div>
                <h4 style={{ fontSize: "16px", fontWeight: "700" }}>ติดตามผลการเรียนรายหลักสูตร</h4>
                <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "4px" }}>
                  ติดตามความคืบหน้าเฉลี่ย ผลแบบทดสอบ เวลารับชมวิดีโอ และใบรับรองที่ใช้งานอยู่ได้แบบเรียลไทม์
                </p>
              </div>
            </div>

            <div style={{ display: "flex", gap: "16px" }}>
              <div style={{ padding: "10px", borderRadius: "10px", backgroundColor: "rgba(16,185,129,0.1)", color: "var(--accent)", alignSelf: "start" }}>
                <Zap size={20} />
              </div>
              <div>
                <h4 style={{ fontSize: "16px", fontWeight: "700" }}>โค้ดส่วนลดตามต้องการ</h4>
                <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "4px" }}>
                  สร้างโค้ดส่วนลด (เป็นเปอร์เซ็นต์หรือจำนวนเงินคงที่) ที่เหมาะกับโครงสร้างธุรกิจขององค์กรเป้าหมาย
                </p>
              </div>
            </div>
          </div>

          <div className="glass-card" style={{ padding: "32px", background: "rgba(255,255,255,0.4)" }}>
            <h4 style={{ fontSize: "18px", marginBottom: "12px", color: "var(--text-primary)" }}>ขอทดลองใช้สำหรับองค์กร</h4>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "20px", lineHeight: "1.5" }}>
              พูดคุยกับผู้เชี่ยวชาญด้านการอบรมคลาวด์ของเรา เราจะจัดเตรียมพื้นที่ทดลอง 10 ที่นั่งให้ทีมวิศวกรเครือข่ายของคุณ
            </p>
            <button 
              onClick={() => alert("บันทึกคำขอเรียบร้อยแล้ว ทีมงานจะติดต่อกลับภายใน 24 ชั่วโมง")}
              className="tech-button-primary" 
              style={{ width: "100%", borderRadius: "1rem" }}
            >
              ติดต่อฝ่ายขายองค์กร
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderResourcesTab = () => {
    return (
      <div className="glass-card animate-fade-in" style={{ padding: "40px" }}>
        <h2 style={{ fontSize: "32px", marginBottom: "12px" }}>แหล่งความรู้และเอกสารประกอบการเรียน</h2>
        <p style={{ color: "var(--text-secondary)", marginBottom: "32px" }}>
          เข้าถึงเอกสารการตั้งค่าตัวจำลอง Cloudflare, signed URL และคู่มือปฏิบัติการ
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "24px" }}>
          <div className="glass-card" style={{ padding: "24px", background: "rgba(255,255,255,0.45)" }}>
            <div style={{ color: "var(--primary)", marginBottom: "16px" }}><Terminal size={24} /></div>
            <h4 style={{ fontSize: "16px", fontWeight: "700" }}>การใช้งาน Wrangler CLI</h4>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "8px", lineHeight: "1.5" }}>
              เรียนรู้การเริ่มต้น D1 SQLite ในเครื่อง การสร้างแผน SQL migration และการรันไฟล์ข้อมูลตั้งต้นบนเซิร์ฟเวอร์ edge
            </p>
          </div>

          <div className="glass-card" style={{ padding: "24px", background: "rgba(255,255,255,0.45)" }}>
            <div style={{ color: "var(--secondary)", marginBottom: "16px" }}><FileText size={24} /></div>
            <h4 style={{ fontSize: "16px", fontWeight: "700" }}>คู่มือปฏิบัติการ R2</h4>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "8px", lineHeight: "1.5" }}>
              คู่มือ PDF สำหรับการตั้งค่าการแบ่งเส้นทาง BGP การทดสอบเจาะระบบไฟร์วอลล์ และการจัดการเครือข่ายตู้เซิร์ฟเวอร์
            </p>
          </div>

          <div className="glass-card" style={{ padding: "24px", background: "rgba(255,255,255,0.45)" }}>
            <div style={{ color: "var(--accent)", marginBottom: "16px" }}><CloudLightning size={24} /></div>
            <h4 style={{ fontSize: "16px", fontWeight: "700" }}>การสตรีมผ่าน Cloudflare CDN</h4>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "8px", lineHeight: "1.5" }}>
              เอกสาร API อธิบายตัวสร้าง signed URL การตั้งค่าคีย์ HMAC และความปลอดภัยของโทเคนที่มีวันหมดอายุ
            </p>
          </div>
        </div>
      </div>
    );
  };

  const renderPricingTab = () => {
    return (
      <div className="glass-card animate-fade-in" style={{ padding: "40px" }}>
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <h2 style={{ fontSize: "32px" }}>แพ็กเกจที่ยืดหยุ่นสำหรับผู้เรียนและทีมงาน</h2>
          <p style={{ color: "var(--text-secondary)", marginTop: "6px" }}>เลือกระดับการเข้าถึงแลปและการจัดการที่นั่งที่เหมาะกับคุณ</p>
          
          {/* Monthly / Yearly Toggle */}
          <div style={{ display: "inline-flex", alignItems: "center", gap: "12px", marginTop: "20px", background: "rgba(0,0,0,0.03)", padding: "6px 12px", borderRadius: "99px" }}>
            <span style={{ fontSize: "12px", fontWeight: isYearly ? "500" : "700", color: isYearly ? "var(--text-secondary)" : "var(--text-primary)" }}>รายเดือน</span>
            <button 
              onClick={() => setIsYearly(!isYearly)}
              style={{
                width: "48px",
                height: "24px",
                borderRadius: "12px",
                backgroundColor: "var(--primary)",
                border: "none",
                position: "relative",
                cursor: "pointer",
                padding: "2px"
              }}
            >
              <div style={{ 
                width: "20px", 
                height: "20px", 
                borderRadius: "50%", 
                backgroundColor: "#ffffff", 
                position: "absolute",
                left: isYearly ? "26px" : "2px",
                top: "2px",
                transition: "left 0.2s"
              }} />
            </button>
            <span style={{ fontSize: "12px", fontWeight: isYearly ? "700" : "500", color: isYearly ? "var(--text-primary)" : "var(--text-secondary)", display: "flex", alignItems: "center", gap: "4px" }}>
              รายปี
              <span className="badge-gamified" style={{ padding: "2px 6px", fontSize: "9px", textTransform: "none", background: "rgba(16,185,129,0.1)", color: "var(--accent)" }}>-20%</span>
            </span>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "24px" }}>
          {[
            {
              name: "ผู้เรียนทั่วไป",
              price: isYearly ? "฿790" : "฿990",
              period: "/ เดือน",
              desc: "เหมาะสำหรับผู้เรียนรายบุคคลที่เตรียมสอบ Cisco/AWS",
              features: [
                "คอร์สวิดีโอครบทุกหลักสูตร",
                "แบบทดสอบจำลองข้อสอบ",
                "เอกสารประกอบการเรียนและคู่มือ PDF",
                "เหรียญตราใบประกาศนียบัตร",
                "บริการช่วยเหลือมาตรฐาน"
              ],
              button: "เริ่มต้นใช้งาน",
              color: "var(--primary)",
              accent: false
            },
            {
              name: "กลุ่มองค์กร",
              price: isYearly ? "฿5,500" : "฿6,900",
              period: "/ ที่นั่ง / เดือน",
              desc: "เหมาะสำหรับทีมองค์กรที่ต้องการยกระดับความรู้ด้านโครงสร้างพื้นฐาน IT",
              features: [
                "ทุกอย่างในแพ็กเกจผู้เรียนทั่วไป",
                "แดชบอร์ดวิเคราะห์ข้อมูลสำหรับองค์กร",
                "ตัวจัดการที่นั่ง (จัดสรรและเพิกถอน)",
                "โค้ดส่วนลดแบบจำนวนมาก",
                "บริการช่วยเหลือแบบเร่งด่วน"
              ],
              button: "ติดต่อฝ่ายขาย",
              color: "var(--secondary)",
              accent: true
            },
            {
              name: "องค์กรแบบกำหนดเอง",
              price: "ตามที่ตกลง",
              period: "",
              desc: "เหมาะสำหรับองค์กรขนาดใหญ่ที่ต้องการโทโพโลยีเฉพาะ",
              features: [
                "ทุกอย่างในแพ็กเกจกลุ่มองค์กร",
                "ระบบจำลองแลปตามความต้องการ",
                "เชื่อมต่อ Single Sign-On (SSO)",
                "ผู้เชี่ยวชาญด้านการอบรมประจำ",
                "รับประกันเวลาให้บริการตาม SLA"
              ],
              button: "ขอใบเสนอราคา",
              color: "var(--accent)",
              accent: false
            }
          ].map((plan, idx) => (
            <div 
              key={idx}
              className="glass-card"
              style={{ 
                padding: "32px 24px", 
                display: "flex", 
                flexDirection: "column", 
                gap: "20px", 
                border: plan.accent ? `2px solid var(--primary)` : "1px solid var(--border-subtle)",
                background: plan.accent ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.55)",
                transform: plan.accent ? "scale(1.03)" : "none"
              }}
            >
              <div>
                <span style={{ fontSize: "14px", fontWeight: "700", color: plan.accent ? "var(--primary)" : "var(--text-secondary)" }}>{plan.name}</span>
                <div style={{ display: "flex", alignItems: "baseline", gap: "4px", marginTop: "12px" }}>
                  <span style={{ fontSize: "36px", fontWeight: "800", color: "var(--text-primary)" }}>{plan.price}</span>
                  <span style={{ fontSize: "14px", color: "var(--text-secondary)" }}>{plan.period}</span>
                </div>
                <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "8px", lineHeight: "1.4" }}>{plan.desc}</p>
              </div>

              <ul style={{ display: "flex", flexDirection: "column", gap: "10px", listStyle: "none", fontSize: "12px", padding: "0" }}>
                {plan.features.map((f, i) => (
                  <li key={i} style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text-secondary)" }}>
                    <Check size={14} color="var(--accent)" />
                    {f}
                  </li>
                ))}
              </ul>

              <button 
                onClick={() => {
                  if (idx === 0) {
                    setRegistering(false);
                  setPassword("");
                  setShowLoginModal(true);
                  } else {
                    alert(`เริ่มขั้นตอนสมัครแพ็กเกจ ${plan.name} เรียบร้อยแล้ว`);
                  }
                }}
                className="tech-button-primary"
                style={{ 
                  width: "100%", 
                  marginTop: "auto", 
                  backgroundColor: plan.accent ? "var(--primary)" : "transparent",
                  color: plan.accent ? "#ffffff" : "var(--text-primary)",
                  border: plan.accent ? "none" : "1px solid var(--border-active)",
                  boxShadow: plan.accent ? "var(--shadow-glow)" : "none",
                  borderRadius: "1rem"
                }}
              >
                {plan.button}
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderCompanyTab = () => {
    return (
      <div className="glass-card animate-fade-in" style={{ padding: "40px" }}>
        <h2 style={{ fontSize: "32px", marginBottom: "12px" }}>เกี่ยวกับศูนย์ฝึกอบรม NetPrime</h2>
        <p style={{ color: "var(--text-secondary)", marginBottom: "32px", maxWidth: "700px", lineHeight: "1.6" }}>
          NetPrime เป็นศูนย์ฝึกอบรมด้าน IT ที่มุ่งพัฒนาวิศวกรเครือข่ายและสถาปนิกคลาวด์ ก่อตั้งโดยผู้มีประสบการณ์ด้าน edge computing ให้บริการผู้เรียนและองค์กรลูกค้ากว่า 40 ประเทศ
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px", alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <h4 style={{ fontSize: "18px", fontWeight: "700" }}>วิสัยทัศน์ของเรา</h4>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: "1.6" }}>
              เชื่อมช่องว่างระหว่างทฤษฎีของข้อสอบใบรับรองกับความเชี่ยวชาญในการปฏิบัติงานจริง เราเชื่อว่าวิศวกรเรียนรู้ได้ดีที่สุดจากการตั้งค่าโทโพโลยีจริง ไม่ใช่แค่ท่องจำคำตอบ
            </p>

            <h4 style={{ fontSize: "18px", fontWeight: "700" }}>ผู้สอนของเรา</h4>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: "1.6" }}>
              คู่มือ เอกสารประกอบ และวิดีโอทุกชุดใน NetPrime คัดสรรโดยผู้เชี่ยวชาญที่ถือใบรับรอง CCIE สองสาขา ใบรับรอง AWS Solutions Architect และใบรับรองด้านการทดสอบเจาะระบบความปลอดภัยไซเบอร์
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div className="glass-card" style={{ padding: "20px", textAlign: "center" }}>
              <span style={{ fontSize: "28px", fontWeight: "800", color: "var(--primary)", display: "block" }}>12k+</span>
              <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>ผู้เรียนที่ลงทะเบียน</span>
            </div>
            <div className="glass-card" style={{ padding: "20px", textAlign: "center" }}>
              <span style={{ fontSize: "28px", fontWeight: "800", color: "var(--secondary)", display: "block" }}>750+</span>
              <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>ชั่วโมงวิดีโอ</span>
            </div>
            <div className="glass-card" style={{ padding: "20px", textAlign: "center" }}>
              <span style={{ fontSize: "28px", fontWeight: "800", color: "var(--accent)", display: "block" }}>40+</span>
              <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>ประเทศที่ให้บริการ</span>
            </div>
            <div className="glass-card" style={{ padding: "20px", textAlign: "center" }}>
              <span style={{ fontSize: "28px", fontWeight: "800", color: "var(--warning)", display: "block" }}>98%</span>
              <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>อัตราสอบผ่าน</span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ maxWidth: "1280px", margin: "0 auto", padding: "24px 32px", minHeight: "100vh" }}>
      
      <SiteTopBar onNavigate={navigateTo} />

      {/* HEADER SECTION */}
      <header style={{ 
        display: "flex", 
        justifyContent: "space-between", 
        alignItems: "center", 
        marginBottom: "48px",
        padding: "16px 0",
        borderBottom: "1px solid rgba(0, 0, 0, 0.05)"
      }}>
        {/* Brand Logo & Subtext */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }} onClick={() => setActiveTab("home")}>
          <img src={logo} alt="โลโก้ NetPrime" style={{ height: "46px", width: "auto" }} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: "22px", fontWeight: 800, fontFamily: "Anuphan, sans-serif", color: "var(--text-primary)", lineHeight: "1.1", letterSpacing: "-0.5px" }}>
              NetPrime
            </span>
            <span style={{ fontSize: "9px", fontWeight: 700, color: "var(--text-secondary)", letterSpacing: "1px", textTransform: "uppercase" }}>
              ศูนย์ฝึกอบรมด้าน IT
            </span>
          </div>
        </div>

        {/* Navigation Middle Menu */}
        <nav style={{ display: "flex", alignItems: "center", gap: "24px" }}>
          <button onClick={() => setActiveTab("training")} className={`nav-link ${activeTab === "training" ? "active" : ""}`} style={{ fontSize: "13px", fontWeight: "600" }}>หลักสูตรอบรม</button>
          <button onClick={() => setActiveTab("resources")} className={`nav-link ${activeTab === "resources" ? "active" : ""}`} style={{ fontSize: "13px", fontWeight: "600" }}>แหล่งความรู้</button>
          <button onClick={() => setActiveTab("pricing")} className={`nav-link ${activeTab === "pricing" ? "active" : ""}`} style={{ fontSize: "13px", fontWeight: "600" }}>ราคาและแพ็กเกจ</button>
          <button onClick={() => setActiveTab("company")} className={`nav-link ${activeTab === "company" ? "active" : ""}`} style={{ fontSize: "13px", fontWeight: "600" }}>เกี่ยวกับเรา</button>
          <button onClick={() => setActiveTab("schedule")} className={`nav-link ${activeTab === "schedule" ? "active" : ""}`} style={{ fontSize: "13px", fontWeight: "600" }}>ตารางอบรม</button>
          <button onClick={() => setActiveTab("articles")} className={`nav-link ${activeTab === "articles" ? "active" : ""}`} style={{ fontSize: "13px", fontWeight: "600" }}>บทความ</button>
        </nav>

        {/* Action Button */}
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <button 
            onClick={() => {
              setError(null);
              setEmail("");
              setRegistering(false);
                  setPassword("");
                  setShowLoginModal(true);
            }}
            className="tech-button-outline"
            style={{ 
              padding: "10px 22px", 
              fontSize: "14px", 
              borderRadius: "1rem", 
              display: "flex", 
              alignItems: "center", 
              gap: "8px",
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              color: "var(--text-primary)"
            }}
          >
            <UserIcon size={16} color="var(--text-secondary)" />
            เข้าสู่ระบบ
          </button>
        </div>
      </header>

      {/* RENDER VIEWS ACCORDING TO HEADER SELECTION */}
      <main style={{ marginBottom: "64px" }}>
        <AnimatePresence mode="wait">
          {activeTab === "home" && (
            <motion.div key="home" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} transition={{ duration: 0.25 }}>
              {renderHomeTab()}
            </motion.div>
          )}
          {activeTab === "why" && (
            <motion.div key="why" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} transition={{ duration: 0.25 }}>
              {renderWhyTab()}
            </motion.div>
          )}
          {(activeTab === "training" || activeTab === "certifications") && (
            <motion.div key="training" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} transition={{ duration: 0.25 }}>
              {renderTrainingTab()}
            </motion.div>
          )}
          {activeTab === "enterprise" && (
            <motion.div key="enterprise" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} transition={{ duration: 0.25 }}>
              {renderEnterpriseTab()}
            </motion.div>
          )}
          {activeTab === "resources" && (
            <motion.div key="resources" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} transition={{ duration: 0.25 }}>
              {renderResourcesTab()}
            </motion.div>
          )}
          {activeTab === "pricing" && (
            <motion.div key="pricing" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} transition={{ duration: 0.25 }}>
              {renderPricingTab()}
            </motion.div>
          )}
          {activeTab === "schedule" && (
            <motion.div key="schedule" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} transition={{ duration: 0.25 }}>
              <ScheduleSection />
            </motion.div>
          )}
          {activeTab === "articles" && (
            <motion.div key="articles" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} transition={{ duration: 0.25 }}>
              <ArticlesSection limit={48} />
            </motion.div>
          )}
          {activeTab === "contact" && (
            <motion.div key="contact" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} transition={{ duration: 0.25 }}>
              <ContactSection />
            </motion.div>
          )}
          {activeTab === "company" && (
            <motion.div key="company" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} transition={{ duration: 0.25 }}>
              {renderCompanyTab()}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* PORTAL AUTHENTICATION MODAL */}
      <AnimatePresence>
        {showLoginModal && (
          <div style={{ 
            position: "fixed", 
            inset: 0, 
            backgroundColor: "rgba(15, 23, 42, 0.4)", 
            backdropFilter: "blur(8px)", 
            display: "flex", 
            alignItems: "center", 
            justifyContent: "center", 
            zIndex: 10000 
          }}>
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="glass-card"
              style={{ 
                width: "100%", 
                maxWidth: "440px",
                maxHeight: "90vh",
                overflowY: "auto", 
                padding: "36px", 
                position: "relative",
                backgroundColor: "#ffffff",
                boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)"
              }}
            >
              {/* Close Button */}
              <button 
                onClick={() => setShowLoginModal(false)}
                style={{ 
                  position: "absolute", 
                  top: "20px", 
                  right: "20px", 
                  background: "none", 
                  border: "none", 
                  color: "var(--text-secondary)", 
                  cursor: "pointer" 
                }}
              >
                <X size={20} />
              </button>

              <h3 style={{ fontSize: "24px", marginBottom: "8px", fontWeight: 800 }}>{registering ? "สร้างบัญชีของคุณ" : "เข้าสู่ระบบ"}</h3>
              <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "24px" }}>
                เข้าถึงคลังหลักสูตรของคุณหรือคอนโซลสำหรับพาร์ตเนอร์องค์กร
              </p>

              {error && (
                <div style={{ 
                  background: "rgba(239, 68, 68, 0.06)", 
                  border: "1px solid rgba(239, 68, 68, 0.2)", 
                  color: "var(--danger)", 
                  padding: "12px", 
                  borderRadius: "1rem", 
                  fontSize: "12px", 
                  marginBottom: "20px" 
                }}>
                  {error}
                </div>
              )}

              {/* Social OAuth Sign-In Buttons */}
              <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "20px" }}>
                {/* Google Button */}
                <button
                  type="button"
                  onClick={() => handleOAuthLogin("google")}
                  disabled={loading || !providers.google?.enabled}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "10px",
                    width: "100%",
                    padding: "10px 16px",
                    borderRadius: "1rem",
                    border: "1px solid var(--border-subtle)",
                    background: "#ffffff",
                    color: "var(--text-primary)",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                    transition: "all 0.2s ease"
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"/>
                    <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.33 24 12 24z"/>
                    <path fill="#FBBC05" d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.18 0 9.99 0 12s.45 3.82 1.25 5.42l4.03-3.15z"/>
                    <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"/>
                  </svg>
                  {providers.google?.enabled ? "ดำเนินการต่อด้วย Google" : "ยังไม่เปิดใช้การเข้าสู่ระบบด้วย Google"}
                </button>

                {/* Microsoft 365 Button */}
                <button
                  type="button"
                  onClick={() => handleOAuthLogin("microsoft")}
                  disabled={loading || !providers.microsoft?.enabled}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "10px",
                    width: "100%",
                    padding: "10px 16px",
                    borderRadius: "1rem",
                    border: "1px solid var(--border-subtle)",
                    background: "#ffffff",
                    color: "var(--text-primary)",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                    transition: "all 0.2s ease"
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 21 21">
                    <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
                    <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
                    <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
                    <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
                  </svg>
                  {providers.microsoft?.enabled ? "ดำเนินการต่อด้วย Microsoft 365" : "ยังไม่เปิดใช้การเข้าสู่ระบบด้วย Microsoft"}
                </button>

                {/* GitHub Button */}
                <button
                  type="button"
                  onClick={() => handleOAuthLogin("github")}
                  disabled={loading || !providers.github?.enabled}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "10px",
                    width: "100%",
                    padding: "10px 16px",
                    borderRadius: "1rem",
                    border: "1px solid #24292f",
                    background: "#24292f",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                    transition: "all 0.2s ease"
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="#ffffff">
                    <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
                  </svg>
                  {providers.github?.enabled ? "ดำเนินการต่อด้วย GitHub" : "ยังไม่เปิดใช้การเข้าสู่ระบบด้วย GitHub"}
                </button>
              </div>

              {/* Divider */}
              <div style={{ display: "flex", alignItems: "center", gap: "12px", margin: "16px 0" }}>
                <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
                <span style={{ fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase", fontWeight: "600" }}>หรือเข้าสู่ระบบด้วยอีเมล</span>
                <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
              </div>

              <form onSubmit={(e) => { e.preventDefault(); handleAuth(email); }}>
                <div className="form-group">
                  <label htmlFor="login-email" className="form-label">อีเมล</label>
                  <div style={{ position: "relative" }}>
                    <Mail size={16} color="var(--text-muted)" style={{ position: "absolute", left: "14px", top: "14px" }} />
                    <input
                      type="email"
                      id="login-email"
                      autoComplete="username"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="form-input"
                      style={{ paddingLeft: "42px" }}
                      required
                    />
                  </div>
                </div>

                {registering && <div className="form-group">
                  <label htmlFor="register-name" className="form-label">ชื่อ</label>
                  <input id="register-name" className="form-input" value={name} onChange={e => setName(e.target.value)} autoComplete="name" maxLength={120} required />
                </div>}
                <div className="form-group">
                  <label htmlFor="login-password" className="form-label">รหัสผ่าน</label>
                  <input id="login-password" className="form-input" type="password" value={password}
                    onChange={e => setPassword(e.target.value)} autoComplete={registering ? "new-password" : "current-password"}
                    minLength={registering ? 12 : 1} maxLength={256} required />
                  {registering && <p style={{ fontSize: "12px", marginTop: "8px" }}>ใช้อย่างน้อย 12 ตัวอักษร</p>}
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="tech-button-primary"
                  style={{ width: "100%", marginTop: "12px", borderRadius: "1rem" }}
                >
                  {loading ? "กรุณารอสักครู่…" : registering ? "สร้างบัญชี" : "เข้าสู่ระบบ"}
                </button>
              </form>
              
              <button type="button" className="tech-button-outline" disabled={loading}
                onClick={() => { setRegistering(!registering); setError(null); setPassword(""); }}
                style={{ width: "100%", marginTop: "16px" }}>
                {registering ? "มีบัญชีอยู่แล้ว? เข้าสู่ระบบ" : "สร้างบัญชีผู้เรียน"}
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* PUBLIC DETAILED COURSE VIEW MODAL */}
      <AnimatePresence>
        {selectedCourse && (
          <div style={{ 
            position: "fixed", 
            inset: 0, 
            backgroundColor: "rgba(15, 23, 42, 0.4)", 
            backdropFilter: "blur(8px)", 
            display: "flex", 
            alignItems: "center", 
            justifyContent: "center", 
            zIndex: 10000 
          }}>
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="glass-card"
              style={{ 
                width: "100%", 
                maxWidth: "600px", 
                padding: "0", 
                position: "relative",
                backgroundColor: "#ffffff",
                boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)",
                overflow: "hidden",
                borderRadius: "1.5rem"
              }}
            >
              {/* Cover */}
              <div style={{ position: "relative", height: "220px" }}>
                <img 
                  src={selectedCourse.cover_image_url || getFallbackCover(selectedCourse.title)} 
                  alt={selectedCourse.title} 
                  style={{ width: "100%", height: "100%", objectFit: "cover" }} 
                />
                <button 
                  onClick={() => setSelectedCourse(null)}
                  style={{ 
                    position: "absolute", 
                    top: "16px", 
                    right: "16px", 
                    background: "rgba(15, 23, 42, 0.6)", 
                    border: "none", 
                    color: "#ffffff", 
                    cursor: "pointer",
                    borderRadius: "50%",
                    width: "32px",
                    height: "32px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center"
                  }}
                >
                  <X size={18} />
                </button>
              </div>

              {/* Body */}
              <div style={{ padding: "32px", display: "flex", flexDirection: "column", gap: "20px" }}>
                <div>
                  <span className="badge-gamified" style={{ marginBottom: "8px" }}>
                    ขอบเขตใบรับรอง {getCourseVendor(selectedCourse.title)}
                  </span>
                  <h3 style={{ fontSize: "22px", fontWeight: 800, color: "var(--text-primary)" }}>{selectedCourse.title}</h3>
                </div>

                <p style={{ fontSize: "14px", color: "var(--text-secondary)", lineHeight: "1.6" }}>
                  {selectedCourse.description}
                </p>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", background: "rgba(0,0,0,0.02)", padding: "16px", borderRadius: "1rem", border: "1px solid var(--border-subtle)" }}>
                  <div>
                    <span style={{ fontSize: "11px", color: "var(--text-muted)", display: "block" }}>ราคา</span>
                    <span style={{ fontSize: "16px", fontWeight: "800", color: "var(--text-primary)" }}>
                      {selectedCourse.price && selectedCourse.price > 0 ? `฿${selectedCourse.price}` : "ฟรี"}
                    </span>
                  </div>
                  <div>
                    <span style={{ fontSize: "11px", color: "var(--text-muted)", display: "block" }}>ระยะเวลาเข้าถึง</span>
                    <span style={{ fontSize: "16px", fontWeight: "800", color: "var(--text-primary)" }}>
                      {selectedCourse.access_duration_days ? `${selectedCourse.access_duration_days} วัน` : "ตลอดชีพ"}
                    </span>
                  </div>
                </div>

                <div style={{ display: "flex", gap: "12px", marginTop: "8px" }}>
                  <button 
                    onClick={() => {
                      setSelectedCourse(null);
                      setRegistering(false);
                  setPassword("");
                  setShowLoginModal(true);
                    }}
                    className="tech-button-primary"
                    style={{ flexGrow: 1, borderRadius: "1rem" }}
                  >
                    เข้าสู่ระบบเพื่อลงทะเบียนเรียน
                  </button>
                  <button 
                    onClick={() => setSelectedCourse(null)}
                    className="tech-button-outline"
                    style={{ borderRadius: "1rem", borderColor: "#e2e8f0", color: "var(--text-secondary)" }}
                  >
                    ปิด
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* FOOTER SECTION */}
      <footer style={{ 
        borderTop: "1px solid rgba(0,0,0,0.05)", 
        paddingTop: "40px", 
        paddingBottom: "32px",
        marginTop: "64px",
        display: "flex",
        flexDirection: "column",
        gap: "32px"
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "40px" }}>
          {/* Brand & Subtext */}
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxWidth: "320px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <img src={logo} alt="โลโก้ NetPrime" style={{ height: "36px", width: "auto" }} />
              <span style={{ fontSize: "18px", fontWeight: 800, color: "var(--text-primary)" }}>NetPrime</span>
            </div>
            <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: "1.5" }}>
              แพลตฟอร์มจำลองแลปสำหรับอบรมวิศวกรเครือข่ายและสถาปนิกคลาวด์ระดับองค์กร สร้างบนเทคโนโลยี serverless edge ทั้งหมด
            </p>
          </div>

          {/* Links */}
          <div style={{ display: "flex", gap: "64px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <h5 style={{ fontSize: "13px", textTransform: "uppercase", color: "var(--text-primary)" }}>หลักสูตรอบรม</h5>
              <button onClick={() => setActiveTab("training")} style={{ background: "none", border: "none", fontSize: "12px", color: "var(--text-secondary)", cursor: "pointer", textAlign: "left" }} className="nav-link-hover">หลักสูตรทั้งหมด</button>
              <button onClick={() => setActiveTab("why")} style={{ background: "none", border: "none", fontSize: "12px", color: "var(--text-secondary)", cursor: "pointer", textAlign: "left" }} className="nav-link-hover">วิธีการเรียนรู้</button>
              <button onClick={() => setActiveTab("resources")} style={{ background: "none", border: "none", fontSize: "12px", color: "var(--text-secondary)", cursor: "pointer", textAlign: "left" }} className="nav-link-hover">เอกสารประกอบ</button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <h5 style={{ fontSize: "13px", textTransform: "uppercase", color: "var(--text-primary)" }}>เกี่ยวกับเรา</h5>
              <button onClick={() => setActiveTab("company")} style={{ background: "none", border: "none", fontSize: "12px", color: "var(--text-secondary)", cursor: "pointer", textAlign: "left" }} className="nav-link-hover">เกี่ยวกับเรา</button>
              <button onClick={() => setActiveTab("pricing")} style={{ background: "none", border: "none", fontSize: "12px", color: "var(--text-secondary)", cursor: "pointer", textAlign: "left" }} className="nav-link-hover">แพ็กเกจและราคา</button>
              <button onClick={() => setShowLoginModal(true)} style={{ background: "none", border: "none", fontSize: "12px", color: "var(--text-secondary)", cursor: "pointer", textAlign: "left" }} className="nav-link-hover">ร่วมงานกับเรา</button>
            </div>
          </div>

          {/* Newsletter signup */}
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxWidth: "280px" }}>
            <h5 style={{ fontSize: "13px", textTransform: "uppercase", color: "var(--text-primary)" }}>จดหมายข่าว</h5>
            <p style={{ fontSize: "12px", color: "var(--text-secondary)" }}>รับแจ้งเมื่อมีโมดูล CCIE หรือ AWS ใหม่</p>
            <form onSubmit={(e) => { e.preventDefault(); alert("สมัครรับจดหมายข่าวเรียบร้อยแล้ว"); }} style={{ display: "flex", gap: "8px" }}>
              <input 
                type="email" 
                placeholder="engineering@netprime.com" 
                className="form-input" 
                style={{ fontSize: "11px", padding: "8px 12px" }}
                required 
              />
              <button type="submit" className="tech-button-primary" style={{ padding: "8px 16px", borderRadius: "1rem" }}>
                ส่ง
              </button>
            </form>
          </div>
        </div>

        <div style={{ borderTop: "1px solid rgba(0,0,0,0.05)", paddingTop: "20px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
            © {new Date().getFullYear()} ศูนย์ฝึกอบรม NetPrime สงวนลิขสิทธิ์
          </span>
          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
            ขับเคลื่อนด้วย Cloudflare Workers และ SQLite D1
          </span>
        </div>
      </footer>
      
    </div>
  );
};
export default Landing;
