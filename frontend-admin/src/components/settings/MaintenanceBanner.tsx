import React, { useEffect, useState } from "react";
import { AlertTriangle, Info, X } from "lucide-react";
import { API_BASE_URL } from "../../hooks/useApi";

interface PublicPlatform { maintenance: { active: boolean; message?: string | null; level?: "info" | "warning" } }

/**
 * Maintenance banner from the school settings (GET /api/public/platform). Render at the top of the
 * public site and the console; it hides itself when no banner is active. Dismissal lasts for the tab.
 */
export const MaintenanceBanner: React.FC = () => {
  const [banner, setBanner] = useState<PublicPlatform["maintenance"] | null>(null);
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem("netprime.maintenance.hidden") || ""; } catch { return ""; } });

  useEffect(() => {
    fetch(`${API_BASE_URL}/public/platform`).then(r => r.ok ? r.json() : null).then((d: PublicPlatform | null) => setBanner(d?.maintenance ?? null)).catch(() => setBanner(null));
  }, []);

  if (!banner?.active || !banner.message || hidden === banner.message) return null;
  const warning = banner.level === "warning";
  const dismiss = () => {
    setHidden(banner.message!);
    try { sessionStorage.setItem("netprime.maintenance.hidden", banner.message!); } catch { /* storage unavailable */ }
  };
  return (
    <div role="status" style={{ display: "flex", gap: "10px", alignItems: "center", justifyContent: "center", padding: "8px 16px", fontSize: "14px",
      background: warning ? "#fff4e5" : "#eaf2ff", color: warning ? "#8a4b00" : "#1d4ed8", borderBottom: `1px solid ${warning ? "#f5c27a" : "#bfd4ff"}` }}>
      {warning ? <AlertTriangle size={16} /> : <Info size={16} />}
      <span>{banner.message}</span>
      <button onClick={dismiss} aria-label="ปิดประกาศ" style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", display: "flex" }}><X size={16} /></button>
    </div>
  );
};
