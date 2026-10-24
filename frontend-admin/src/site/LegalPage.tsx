import React, { useEffect, useMemo, useState } from "react";
import { publicGet } from "../components/site/PublicSections";
import { formatDate } from "../components/site-admin/ui";
import { Markdown, parseMarkdown } from "./Markdown";
import { usePageMeta } from "./router";

export type LegalKey = "privacy" | "terms" | "refund-policy";

/** Path → page key for the public router (/privacy, /terms, /refund-policy). */
export const LEGAL_PATHS: Record<string, LegalKey> = { "/privacy": "privacy", "/terms": "terms", "/refund-policy": "refund-policy" };

interface LegalContent { key: LegalKey; title: string; content: string; updated_at: string | null; is_default: boolean }

/** Privacy policy, terms and refund policy; Markdown edited by coordinators in the content console. */
export const LegalPage: React.FC<{ pageKey: LegalKey }> = ({ pageKey }) => {
  const [page, setPage] = useState<LegalContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPage(null);
    setError(null);
    publicGet<{ page: LegalContent }>(`/legal/${pageKey}`).then(d => setPage(d.page)).catch(() => setError("โหลดเนื้อหาไม่สำเร็จ กรุณาลองใหม่"));
  }, [pageKey]);
  usePageMeta(page?.title ?? null, page ? page.content.replace(/[>#*\[\]_`]/g, "").slice(0, 160) : null);
  const blocks = useMemo(() => parseMarkdown(page?.content || ""), [page?.content]);

  return (
    <article className="ps-container" style={{ maxWidth: 820, paddingTop: 40, paddingBottom: 48 }}>
      {error && <p role="alert" style={{ color: "#b42318" }}>{error}</p>}
      {!page && !error && <p className="ps-muted">กำลังโหลด…</p>}
      {page && (
        <>
          <h1 style={{ fontSize: 34, margin: "0 0 6px" }}>{page.title}</h1>
          {page.updated_at && <p className="ps-muted" style={{ margin: "0 0 24px", fontSize: 14 }}>ปรับปรุงล่าสุด {formatDate(page.updated_at)}</p>}
          <Markdown blocks={blocks} />
        </>
      )}
    </article>
  );
};
