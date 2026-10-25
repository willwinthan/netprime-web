import React, { useEffect, useRef, useState } from "react";
import { BookOpen, FileText, LayoutGrid, Receipt, Search, CalendarDays, User as UserIcon } from "lucide-react";
import { useApi } from "../../hooks/useApi";

export interface SearchTarget { tab: string; id?: string }
interface SearchResult { kind: "page" | "course" | "user" | "order" | "article" | "session"; id: string; title: string; subtitle?: string; target: SearchTarget }

const KIND: Record<SearchResult["kind"], { label: string; icon: React.ReactNode }> = {
  page: { label: "เมนู", icon: <LayoutGrid size={16} /> },
  course: { label: "คอร์ส", icon: <BookOpen size={16} /> },
  user: { label: "ผู้ใช้", icon: <UserIcon size={16} /> },
  order: { label: "คำสั่งซื้อ", icon: <Receipt size={16} /> },
  article: { label: "บทความ", icon: <FileText size={16} /> },
  session: { label: "รอบอบรม", icon: <CalendarDays size={16} /> }
};

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Global search: a top-bar button plus a Cmd/Ctrl+K command palette over GET /api/search
 * (results are already limited to what the user may see). `onNavigate(target)` opens the console tab.
 */
export const GlobalSearch: React.FC<{ onNavigate: (target: SearchTarget) => void; style?: React.CSSProperties }> = ({ onNavigate, style }) => {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(o => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) { setTimeout(() => inputRef.current?.focus(), 0); }
    else { setQ(""); setResults([]); setError(null); }
  }, [open]);

  // Debounced search; stale responses are ignored.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { seq.current++; setResults([]); setLoading(false); return; }
    const id = ++seq.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      api.get<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(term.slice(0, 100))}`)
        .then(r => { if (id === seq.current) { setResults(r.results); setActive(0); setError(null); } })
        .catch((err: any) => { if (id === seq.current) setError(err.message || "ค้นหาไม่สำเร็จ"); })
        .finally(() => { if (id === seq.current) setLoading(false); });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [q, api.token]);

  const choose = (r: SearchResult | undefined) => {
    if (!r) return;
    setOpen(false);
    onNavigate(r.target);
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(results.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(results[active]); }
    else if (e.key === "Escape") { setOpen(false); }
  };

  if (!api.token) return null;

  return (
    <>
      <button type="button" className="tech-button-outline" onClick={() => setOpen(true)} aria-label="ค้นหา" aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
        style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 12px", fontSize: "13px", ...style }}>
        <Search size={16} />
        <span>ค้นหา</span>
        <kbd style={{ fontSize: "11px", padding: "1px 6px", borderRadius: "4px", border: "1px solid rgba(15,23,42,0.15)", color: "var(--text-muted)", fontFamily: "inherit" }}>{isMac ? "⌘K" : "Ctrl K"}</kbd>
      </button>

      {open && (
        <div role="dialog" aria-modal="true" aria-label="ค้นหาทั่วระบบ" onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.4)", backdropFilter: "blur(6px)", zIndex: 9500, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "10vh 16px 16px" }}>
          <div className="glass-card" onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: "620px", background: "#fff", padding: 0, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "14px 16px", borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
              <Search size={18} color="var(--text-muted)" />
              <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onInputKey} maxLength={100}
                placeholder="ค้นหาคอร์ส ผู้ใช้ คำสั่งซื้อ บทความ รอบอบรม หรือเมนู…" aria-label="คำค้น"
                role="combobox" aria-expanded={results.length > 0} aria-controls="global-search-results" aria-activedescendant={results[active] ? `gs-${active}` : undefined}
                style={{ flex: 1, border: "none", outline: "none", fontSize: "16px", background: "transparent", fontFamily: "inherit" }} />
              <kbd style={{ fontSize: "11px", color: "var(--text-muted)" }}>Esc</kbd>
            </div>
            <div id="global-search-results" role="listbox" style={{ maxHeight: "55vh", overflowY: "auto", padding: "6px" }}>
              {error && <div role="alert" style={{ padding: "16px", color: "var(--danger)", fontSize: "14px" }}>{error}</div>}
              {!error && q.trim().length < 2 && <div style={{ padding: "16px", color: "var(--text-muted)", fontSize: "14px" }}>พิมพ์อย่างน้อย 2 ตัวอักษร · ↑↓ เลือก · Enter เปิด</div>}
              {!error && q.trim().length >= 2 && !loading && results.length === 0 && <div style={{ padding: "16px", color: "var(--text-muted)", fontSize: "14px" }}>ไม่พบผลลัพธ์</div>}
              {results.map((r, i) => (
                <div key={`${r.kind}-${r.id}`} id={`gs-${i}`} role="option" aria-selected={i === active}
                  onMouseEnter={() => setActive(i)} onClick={() => choose(r)}
                  style={{ display: "flex", alignItems: "center", gap: "12px", padding: "10px 12px", borderRadius: "8px", cursor: "pointer", background: i === active ? "var(--primary-glow)" : "transparent" }}>
                  <span style={{ color: "var(--primary)", display: "flex" }}>{KIND[r.kind]?.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "14px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</div>
                    {r.subtitle && <div style={{ fontSize: "12px", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.subtitle}</div>}
                  </div>
                  <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>{KIND[r.kind]?.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default GlobalSearch;
