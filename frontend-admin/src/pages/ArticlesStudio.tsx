import React, { Suspense, lazy, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, FileText } from "lucide-react";
import { can, useApi } from "../hooks/useApi";
import { Chip, Empty, ErrorBox, formatDateTime, tableStyle, thStyle, tdStyle } from "../components/site-admin/ui";

// BlockNote is large; load it only when someone opens the editor.
const ArticleEditor = lazy(() => import("../components/editor/ArticleEditor"));

interface ArticleRow {
  id: string; slug: string; title: string; category: string | null; cover_url: string | null;
  status: "draft" | "review" | "published"; published_at: string | null; updated_at: string;
  submitted_at: string | null; review_note: string | null; author_id: string | null; author_name: string | null;
}

const STATUS: Record<ArticleRow["status"], { label: string; color: string; bg: string }> = {
  draft: { label: "ฉบับร่าง", color: "#3a4660", bg: "#eceff4" },
  review: { label: "รอตรวจ", color: "#7a4b00", bg: "#fff1d6" },
  published: { label: "เผยแพร่แล้ว", color: "#1f6b45", bg: "#dff3e8" }
};

type Filter = "all" | "mine" | "review" | "draft" | "published";
const PAGE = 30;

/** Article workspace: instructors write and submit, reviewers approve and publish. */
export const ArticlesStudio: React.FC = () => {
  const api = useApi();
  const reviewer = can(api.user, "articles.publish", "articles.manage");
  const [filter, setFilter] = useState<Filter>(reviewer ? "all" : "mine");
  const [rows, setRows] = useState<ArticleRow[]>([]);
  const [total, setTotal] = useState(0);
  const [reviewCount, setReviewCount] = useState<number | undefined>();
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null | undefined>(undefined); // undefined = list, null = new

  const load = async () => {
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (filter === "mine") params.set("mine", "1");
    else if (filter !== "all") params.set("status", filter);
    try {
      setLoading(true); setError(null);
      const data = await api.get<{ articles: ArticleRow[]; total: number; reviewCount?: number }>(`/admin/site/articles?${params}`);
      setRows(data.articles); setTotal(data.total); setReviewCount(data.reviewCount);
    } catch (err: any) { setError(err.message); } finally { setLoading(false); }
  };
  useEffect(() => { if (open === undefined) load(); }, [filter, offset, open]);

  if (open !== undefined) {
    // Full-screen page outside the console's animated (transformed) container.
    return createPortal(
      <Suspense fallback={<div style={{ position: "fixed", inset: 0, zIndex: 60, background: "#fff", display: "grid", placeItems: "center", color: "var(--text-secondary)" }}>กำลังโหลดตัวแก้ไข…</div>}>
        <ArticleEditor articleId={open} onClose={() => setOpen(undefined)} />
      </Suspense>,
      document.body
    );
  }

  const tabs: [Filter, string][] = reviewer
    ? [["all", "ทั้งหมด"], ["review", `รอตรวจ${reviewCount ? ` (${reviewCount})` : ""}`], ["mine", "ของฉัน"], ["draft", "ฉบับร่าง"], ["published", "เผยแพร่แล้ว"]]
    : [["mine", "บทความของฉัน"], ["draft", "ฉบับร่าง"], ["review", "รอตรวจ"], ["published", "เผยแพร่แล้ว"]];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 26, margin: 0 }}>บทความ</h1>
          <p style={{ color: "var(--text-secondary)", margin: "6px 0 0", fontSize: 14 }}>
            {reviewer
              ? "เขียน ตรวจ และเผยแพร่บทความบนเว็บไซต์ · บทความที่ส่งตรวจจะขึ้นก่อน"
              : "เขียนบทความด้วยตัวแก้ไขแบบ Notion แล้วกดส่งตรวจ ผู้ดูแลจะอนุมัติก่อนขึ้นเว็บ"}
          </p>
        </div>
        {can(api.user, "articles.write", "articles.publish", "articles.manage") && (
          <button className="tech-button-primary" onClick={() => setOpen(null)} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Plus size={16} /> เขียนบทความใหม่
          </button>
        )}
      </div>

      <nav role="tablist" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
        {tabs.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={filter === key} onClick={() => { setFilter(key); setOffset(0); }}
            className={filter === key ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "6px 14px", fontSize: 14 }}>
            {label}
          </button>
        ))}
      </nav>

      <ErrorBox message={error} />
      <div className="glass-panel" style={{ padding: 0, overflowX: "auto" }}>
        {loading ? <Empty text="กำลังโหลด…" /> : rows.length === 0 ? <Empty text="ยังไม่มีบทความในหมวดนี้" /> : (
          <table style={tableStyle}>
            <thead><tr>
              <th style={thStyle}>บทความ</th><th style={thStyle}>สถานะ</th><th style={thStyle}>ผู้เขียน</th><th style={thStyle}>แก้ไขล่าสุด</th>
            </tr></thead>
            <tbody>
              {rows.map(a => (
                <tr key={a.id} onClick={() => setOpen(a.id)} style={{ cursor: "pointer" }}>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                      {a.cover_url
                        ? <img src={a.cover_url} alt="" style={{ width: 56, height: 40, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />
                        : <span style={{ width: 56, height: 40, borderRadius: 6, background: "#f0f2f5", display: "grid", placeItems: "center", flexShrink: 0 }}><FileText size={16} color="#98a2b3" /></span>}
                      <div style={{ minWidth: 0 }}>
                        <button onClick={e => { e.stopPropagation(); setOpen(a.id); }} style={{ border: 0, background: "none", padding: 0, font: "inherit", fontWeight: 600, textAlign: "left", cursor: "pointer", color: "inherit" }}>{a.title}</button>
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{a.category || "ไม่มีหมวดหมู่"} · /blog/{a.slug}</div>
                        {a.review_note && a.status === "draft" && <div style={{ fontSize: 12, color: "#7a4b00", marginTop: 4 }}>ความเห็นผู้ตรวจ: {a.review_note}</div>}
                      </div>
                    </div>
                  </td>
                  <td style={tdStyle}><Chip {...STATUS[a.status]} /></td>
                  <td style={tdStyle}>{a.author_name || "—"}{a.author_id === api.user?.id ? " (คุณ)" : ""}</td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{formatDateTime(a.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {total > PAGE && (
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginTop: 12, fontSize: 14 }}>
          <span>{offset + 1}–{Math.min(offset + PAGE, total)} จาก {total}</span>
          <button className="tech-button-outline" disabled={offset === 0} onClick={() => setOffset(o => Math.max(0, o - PAGE))}>ก่อนหน้า</button>
          <button className="tech-button-outline" disabled={offset + PAGE >= total} onClick={() => setOffset(o => o + PAGE)}>ถัดไป</button>
        </div>
      )}
    </div>
  );
};
