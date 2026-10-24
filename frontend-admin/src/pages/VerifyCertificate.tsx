import React, { useState, useEffect } from "react";
import { ShieldCheck, ShieldAlert, Calendar, Copy, Check, ArrowLeft, Loader2, Linkedin } from "lucide-react";
import { useApi } from "../hooks/useApi";

export const VerifyCertificate: React.FC = () => {
  const api = useApi();
  const [loading, setLoading] = useState(true);
  const [certData, setCertData] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code")?.trim() || "";

  useEffect(() => {
    const verifyCert = async () => {
      if (!code) {
        setError("ไม่พบรหัสตรวจสอบใบประกาศนียบัตรใน URL");
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        const data = await api.get<any>(`/certificates/verify/${code}`);
        setCertData(data);
      } catch (err: any) {
        console.error(err);
        setError(err.message || "ไม่สามารถเชื่อมต่อบริการตรวจสอบได้");
      } finally {
        setLoading(false);
      }
    };

    verifyCert();
  }, [code]);

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleGoHome = () => {
    // Clear code parameter and return to home page
    window.location.href = window.location.origin;
  };

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "100vh",
      width: "100%",
      padding: "20px"
    }}>
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
      <div style={{
        maxWidth: "600px",
        width: "100%",
        background: "rgba(255, 255, 255, 0.03)",
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        borderRadius: "24px",
        boxShadow: "0 20px 50px rgba(0, 0, 0, 0.3)",
        overflow: "hidden",
        position: "relative"
      }}>
        {/* Decorative corner lights */}
        <div style={{
          position: "absolute",
          top: "-50px",
          right: "-50px",
          width: "150px",
          height: "150px",
          borderRadius: "50%",
          background: certData?.verified ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.1)",
          filter: "blur(40px)",
          zIndex: 0
        }} />

        <div style={{ padding: "40px", position: "relative", zIndex: 1 }}>
          {loading ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 0" }}>
              <Loader2 className="spinner" size={48} style={{ color: "var(--primary)", animation: "spin 1.5s linear infinite" }} />
              <p style={{ marginTop: "20px", color: "var(--text-secondary)", fontSize: "14px", fontWeight: "600", letterSpacing: "0.05em" }}>
                กำลังตรวจสอบใบประกาศนียบัตร...
              </p>
            </div>
          ) : certData?.revoked ? (
            // Revoked certificate: it exists but must not be relied on
            <div style={{ textAlign: "center" }}>
              <div style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center", width: "80px", height: "80px",
                borderRadius: "50%", background: "rgba(239, 68, 68, 0.08)", border: "2px solid rgba(239, 68, 68, 0.5)",
                color: "#ef4444", marginBottom: "20px"
              }}>
                <ShieldAlert size={40} />
              </div>
              <h2 style={{ fontSize: "24px", color: "#ffffff", fontWeight: "800", marginBottom: "8px" }}>
                เพิกถอนแล้ว
              </h2>
              <p style={{ color: "var(--text-secondary)", fontSize: "14px", lineHeight: "1.6", marginBottom: "24px" }}>
                ใบประกาศนียบัตรนี้ถูกเพิกถอนโดยผู้ออก ใช้อ้างอิงคุณวุฒิไม่ได้
              </p>
              <div style={{
                background: "rgba(239, 68, 68, 0.03)", border: "1px solid rgba(239, 68, 68, 0.15)", borderRadius: "12px",
                padding: "16px", marginBottom: "28px", fontSize: "13px", color: "var(--text-secondary)", textAlign: "left",
                display: "flex", flexDirection: "column", gap: "8px"
              }}>
                <div>รหัส: <span style={{ fontFamily: "monospace", color: "#ef4444" }}>{certData.certificateCode}</span></div>
                <div>ผู้ได้รับ: {certData.studentName}</div>
                <div>คอร์ส: {certData.courseTitle}</div>
                <div>วันที่เพิกถอน: {new Date(String(certData.revokedAt).replace(" ", "T") + (String(certData.revokedAt).includes("Z") ? "" : "Z"))
                  .toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" })}</div>
              </div>
              <button type="button" onClick={handleGoHome} className="tech-button" style={{ width: "100%", justifyContent: "center" }}>
                <ArrowLeft size={16} /> กลับสู่ NetPrime LMS
              </button>
            </div>
          ) : error || !certData?.verified ? (
            // Error / Invalid Certificate State
            <div style={{ textAlign: "center" }}>
              <div style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "80px",
                height: "80px",
                borderRadius: "50%",
                background: "rgba(239, 68, 68, 0.08)",
                border: "2px solid rgba(239, 68, 68, 0.3)",
                color: "#ef4444",
                marginBottom: "24px"
              }}>
                <ShieldAlert size={40} />
              </div>
              
              <h2 style={{ fontSize: "24px", color: "#ffffff", fontWeight: "800", marginBottom: "12px" }}>
                ตรวจสอบไม่สำเร็จ
              </h2>
              
              <p style={{ color: "var(--text-secondary)", fontSize: "14px", lineHeight: "1.6", marginBottom: "32px" }}>
                {error || "รหัสใบประกาศนียบัตรไม่ถูกต้อง หรือไม่พบข้อมูลที่ตรงกันในฐานข้อมูลของเรา"}
              </p>

              {code && (
                <div style={{
                  background: "rgba(239, 68, 68, 0.03)",
                  border: "1px solid rgba(239, 68, 68, 0.1)",
                  borderRadius: "12px",
                  padding: "16px",
                  marginBottom: "32px",
                  fontFamily: "monospace",
                  fontSize: "13px",
                  color: "#ef4444",
                  wordBreak: "break-all"
                }}>
                  รหัสที่ค้นหา: {code}
                </div>
              )}

              <button
                type="button"
                onClick={handleGoHome}
                className="tech-button"
                style={{ width: "100%", justifyContent: "center" }}
              >
                <ArrowLeft size={16} /> กลับสู่ NetPrime LMS
              </button>
            </div>
          ) : (
            // Verified Success State
            <div>
              <div style={{ textAlign: "center", marginBottom: "32px" }}>
                <div style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "80px",
                  height: "80px",
                  borderRadius: "50%",
                  background: "rgba(16, 185, 129, 0.08)",
                  border: "2px solid var(--accent)",
                  color: "var(--accent)",
                  marginBottom: "20px",
                  boxShadow: "0 0 20px rgba(16, 185, 129, 0.2)"
                }}>
                  <ShieldCheck size={44} />
                </div>
                
                <h2 style={{ fontSize: "24px", color: "#ffffff", fontWeight: "900", letterSpacing: "-0.01em" }}>
                  ตรวจสอบแล้ว
                </h2>
                <span style={{
                  display: "inline-block",
                  fontSize: "11px",
                  background: "rgba(16, 185, 129, 0.12)",
                  border: "1px solid rgba(16, 185, 129, 0.2)",
                  color: "var(--accent)",
                  padding: "4px 12px",
                  borderRadius: "2rem",
                  fontWeight: "700",
                  marginTop: "8px",
                  letterSpacing: "0.05em",
                  textTransform: "uppercase"
                }}>
                  ใบประกาศนียบัตรของแท้
                </span>
              </div>

              {/* Certificate Verification Details Card */}
              <div style={{
                background: "rgba(255, 255, 255, 0.02)",
                border: "1px solid rgba(255, 255, 255, 0.05)",
                borderRadius: "16px",
                padding: "24px",
                marginBottom: "30px",
                display: "flex",
                flexDirection: "column",
                gap: "18px"
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid rgba(255, 255, 255, 0.05)", paddingBottom: "12px" }}>
                  <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>ผู้สำเร็จการศึกษา:</span>
                  <strong style={{ fontSize: "14px", color: "#ffffff" }}>{certData.studentName}</strong>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid rgba(255, 255, 255, 0.05)", paddingBottom: "12px" }}>
                  <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>ชื่อคอร์ส:</span>
                  <strong style={{ fontSize: "14px", color: "var(--primary)" }}>{certData.courseTitle}</strong>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid rgba(255, 255, 255, 0.05)", paddingBottom: "12px" }}>
                  <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>วันที่ออก:</span>
                  <span style={{ fontSize: "13px", color: "#ffffff", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    <Calendar size={13} style={{ color: "var(--text-secondary)" }} />
                    {new Date(certData.issuedAt).toLocaleDateString("th-TH", {
                      year: "numeric",
                      month: "long",
                      day: "numeric"
                    })}
                  </span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid rgba(255, 255, 255, 0.05)", paddingBottom: "12px" }}>
                  <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>รหัสใบประกาศนียบัตร:</span>
                  <span style={{ fontSize: "13px", color: "#ffffff", fontFamily: "monospace", fontWeight: "700" }}>
                    {certData.certificateCode}
                  </span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>หน่วยงานที่ออก:</span>
                  <span style={{ fontSize: "13px", color: "var(--text-muted)", fontWeight: "500" }}>
                    {certData.verifyingAuthority}
                  </span>
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="tech-button"
                  style={{ width: "100%", justifyContent: "center" }}
                >
                  {copied ? (
                    <>
                      <Check size={16} /> คัดลอกลิงก์แล้ว
                    </>
                  ) : (
                    <>
                      <Copy size={16} /> คัดลอกลิงก์ตรวจสอบ
                    </>
                  )}
                </button>

                {certData && (
                  <a
                    href={`https://www.linkedin.com/profile/add?startTask=CERTIFICATION_NAME&name=${encodeURIComponent(certData.courseTitle)}&organizationName=Netprime%20Academy&certUrl=${encodeURIComponent(window.location.href)}&certId=${certData.certificateCode}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="tech-button-primary"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "8px",
                      borderRadius: "8px",
                      padding: "12px",
                      cursor: "pointer",
                      background: "#0a66c2",
                      border: "none",
                      color: "#fff",
                      textDecoration: "none",
                      fontSize: "14px",
                      fontWeight: "bold"
                    }}
                  >
                    <Linkedin size={16} /> เพิ่มใน LinkedIn
                  </a>
                )}

                <button
                  type="button"
                  onClick={handleGoHome}
                  className="tech-button-outline"
                  style={{ width: "100%", justifyContent: "center", padding: "12px", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", color: "#ffffff" }}
                >
                  กลับสู่หน้าแรก
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
