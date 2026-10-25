import React, { useEffect, useState } from "react";
import { ArrowLeft, Award, CheckCircle2, Circle, Lock, Printer, Route } from "lucide-react";
import { API_BASE_URL, useApi } from "../../hooks/useApi";
import { CertificateDocument, PrintPortal } from "../learner/PrintView";
import { Product } from "./types";

interface PathStep { step: number; course_id: string; title: string; progress_percent: number; completed: boolean; has_access: boolean; recommended_next: boolean }
interface PathCertificate { certificate_code: string; issued_at: string; student_name?: string; path_title?: string }
interface PathSummary extends Product { progress_percent: number; completed: boolean; started: boolean; certificate: PathCertificate | null }
interface PathDetail { path: Product; steps: PathStep[]; progress_percent: number; completed: boolean; certificate: PathCertificate | null }

const bar = (percent: number) => (
  <div style={{ height: "8px", borderRadius: "99px", background: "rgba(100,116,139,0.15)", overflow: "hidden" }}>
    <div style={{ width: `${percent}%`, height: "100%", background: "var(--primary)" }} />
  </div>
);

/** Learner page: learning paths (ordered course bundles) with progress across the path and the completion certificate. */
export const LearningPaths: React.FC<{ initialPathId?: string | null; onOpenCourse?: (courseId: string) => void; onBuy?: () => void }> = ({ initialPathId, onOpenCourse, onBuy }) => {
  const api = useApi();
  const [paths, setPaths] = useState<PathSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(initialPathId ?? null);
  const [detail, setDetail] = useState<PathDetail | null>(null);
  const [printing, setPrinting] = useState<PathCertificate | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.get<{ paths: PathSummary[] }>("/student/paths").then(d => setPaths(d.paths)).catch(err => setError(err.message)); }, [api.token]);
  useEffect(() => { if (initialPathId) setOpenId(initialPathId); }, [initialPathId]);
  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    api.get<PathDetail>(`/student/paths/${openId}`).then(setDetail).catch(err => setError(err.message));
  }, [openId, api.token]);

  const claim = async () => {
    if (!detail) return;
    try {
      const res = await api.post<{ certificate: PathCertificate }>(`/student/paths/${detail.path.id}/certificate`, {});
      setDetail({ ...detail, certificate: res.certificate });
      setPrinting({ ...res.certificate, path_title: detail.path.title });
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {error && <div className="glass-card" role="alert" style={{ color: "var(--danger)" }}>{error}</div>}
      {detail ? (
        <div className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <button type="button" className="tech-button-outline" onClick={() => setOpenId(null)} style={{ alignSelf: "flex-start" }}><ArrowLeft size={14} />เส้นทางทั้งหมด</button>
          <h3 style={{ fontSize: "18px", display: "flex", gap: "8px", alignItems: "center" }}><Route size={18} color="var(--primary)" />{detail.path.title}</h3>
          {detail.path.description && <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>{detail.path.description}</p>}
          <div style={{ fontSize: "13px" }}>ความคืบหน้าทั้งเส้นทาง {detail.progress_percent}%</div>
          {bar(detail.progress_percent)}
          <ol style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "8px" }}>
            {detail.steps.map(s => (
              <li key={s.course_id} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", border: "1px solid var(--border-subtle)", borderRadius: "10px",
                background: s.recommended_next ? "rgba(229,107,37,0.05)" : undefined }}>
                {s.completed ? <CheckCircle2 size={18} color="var(--accent)" /> : s.has_access ? <Circle size={18} color="var(--primary)" /> : <Lock size={18} color="var(--text-muted)" />}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: "14px" }}>{s.step}. {s.title}</div>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{s.completed ? "เรียนจบแล้ว" : s.has_access ? `เรียนไป ${s.progress_percent}%` : "ยังไม่มีสิทธิ์เข้าเรียน"}{s.recommended_next ? " · แนะนำเรียนถัดไป" : ""}</div>
                </div>
                {s.has_access && onOpenCourse && <button type="button" className="tech-button-outline" onClick={() => onOpenCourse(s.course_id)} style={{ padding: "4px 10px", fontSize: "12px" }}>เข้าเรียน</button>}
              </li>
            ))}
          </ol>
          {!detail.steps.some(s => s.has_access) && onBuy && <button type="button" className="tech-button-primary" onClick={onBuy}>ซื้อเส้นทางนี้</button>}
          {detail.path.path_certificate && (detail.certificate ? (
            <button type="button" className="tech-button-outline" onClick={() => setPrinting({ ...detail.certificate!, path_title: detail.path.title })} style={{ alignSelf: "flex-start" }}>
              <Printer size={14} />พิมพ์ใบประกาศเส้นทาง ({detail.certificate.certificate_code})
            </button>
          ) : (
            <button type="button" className="tech-button-primary" onClick={claim} disabled={!detail.completed} style={{ alignSelf: "flex-start" }}>
              <Award size={14} />{detail.completed ? "รับใบประกาศจบเส้นทาง" : "เรียนจบทุกคอร์สเพื่อรับใบประกาศ"}
            </button>
          ))}
        </div>
      ) : paths.length === 0 ? (
        <div className="glass-card" style={{ textAlign: "center", color: "var(--text-secondary)", padding: "40px" }}>ยังไม่มีเส้นทางการเรียน</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "14px" }}>
          {paths.map(p => (
            <button key={p.id} type="button" className="glass-card" onClick={() => setOpenId(p.id)}
              style={{ textAlign: "left", cursor: "pointer", display: "flex", flexDirection: "column", gap: "8px", border: "none" }}>
              <strong style={{ fontSize: "15px" }}>{p.title}</strong>
              <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{p.course_count} คอร์สตามลำดับ{p.path_certificate ? " · มีใบประกาศ" : ""}</span>
              {bar(p.progress_percent)}
              <span style={{ fontSize: "12px" }}>{p.completed ? "จบเส้นทางแล้ว" : p.started ? `ความคืบหน้า ${p.progress_percent}%` : "ยังไม่เริ่ม"}</span>
            </button>
          ))}
        </div>
      )}
      {printing && (
        <PrintPortal orientation="landscape" onDone={() => setPrinting(null)}>
          <CertificateDocument caption="ได้เรียนจบทุกคอร์สในเส้นทางการเรียน"
            cert={{ certificate_code: printing.certificate_code, issued_at: printing.issued_at, student_name: printing.student_name || api.user?.name || "", course_title: printing.path_title || "" }}
            verifyUrl={`${API_BASE_URL}/commerce/path-certificates/${printing.certificate_code}`} />
        </PrintPortal>
      )}
    </div>
  );
};

export default LearningPaths;
