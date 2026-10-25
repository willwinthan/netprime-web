import React, { useState } from "react";
import { Sparkles } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { ErrorBox } from "../site-admin/ui";
import { AI_DISCLAIMER, MockNotice } from "./aiShared";

type WriteAction = "improve" | "shorten" | "translate_en" | "translate_th" | "seo";

const ACTIONS: Array<[WriteAction, string]> = [
  ["improve", "ปรับให้อ่านง่าย"], ["shorten", "ย่อให้สั้นลง"], ["translate_en", "แปล ไทย → อังกฤษ"], ["translate_th", "แปล อังกฤษ → ไทย"], ["seo", "เสนอชื่อเรื่องและคำโปรย (SEO)"]
];

/**
 * "AI ช่วยเขียน" panel for the article editor. The editor passes the current text (selection or
 * Markdown body) and title, and decides what to do with the result through the callbacks.
 * Not mounted yet — see docs/ADMIN-GUIDE.md (ArticleEditor/ArticlesStudio mount point).
 */
export const AiWritingHelper: React.FC<{
  text: string;
  title?: string;
  onReplace?: (text: string) => void;
  onInsert?: (text: string) => void;
  onTitle?: (title: string) => void;
  onExcerpt?: (excerpt: string) => void;
}> = ({ text, title, onReplace, onInsert, onTitle, onExcerpt }) => {
  const api = useApi();
  const [busy, setBusy] = useState<WriteAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ action: WriteAction; result: string; titles?: string[]; excerpt?: string; mock: boolean } | null>(null);

  const run = async (action: WriteAction) => {
    setBusy(action); setError(null);
    try {
      setResult(await api.post("/ai/write", { action, text: text.slice(0, 8000), title }));
    } catch (err: any) { setError(err.message); } finally { setBusy(null); }
  };

  return (
    <div className="glass-card" style={{ padding: 16, borderRadius: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontWeight: 600 }}>
        <Sparkles size={16} color="var(--primary)" /> AI ช่วยเขียน
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {ACTIONS.map(([action, label]) => (
          <button key={action} type="button" className="tech-button-outline" style={{ fontSize: 13, borderRadius: "0.75rem" }}
            disabled={!!busy || (!text.trim() && !(action === "seo" && title))} onClick={() => run(action)}>
            {busy === action ? "กำลังทำงาน..." : label}
          </button>
        ))}
      </div>
      {text.length > 8000 && <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>ใช้เฉพาะ 8,000 ตัวอักษรแรก</p>}
      <div style={{ marginTop: 10 }}><ErrorBox message={error} /></div>
      {result && (
        <div style={{ marginTop: 10 }}>
          <MockNotice mock={result.mock} />
          {result.action === "seo" ? (
            <div style={{ marginTop: 8, fontSize: 14 }}>
              <strong>ชื่อเรื่องที่แนะนำ</strong>
              <ul style={{ paddingLeft: 18 }}>
                {result.titles?.map((t, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>{t} {onTitle && <button type="button" className="tech-button-outline" style={{ fontSize: 12, padding: "2px 8px" }} onClick={() => onTitle(t)}>ใช้ชื่อนี้</button>}</li>
                ))}
              </ul>
              {result.excerpt && (
                <p><strong>คำโปรย:</strong> {result.excerpt} {onExcerpt && <button type="button" className="tech-button-outline" style={{ fontSize: 12, padding: "2px 8px" }} onClick={() => onExcerpt(result.excerpt!)}>ใช้คำโปรยนี้</button>}</p>
              )}
            </div>
          ) : (
            <>
              <textarea className="form-input" readOnly rows={8} value={result.result} style={{ marginTop: 8, width: "100%" }} aria-label="ผลลัพธ์จาก AI" />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                {onReplace && <button type="button" className="tech-button-primary" style={{ fontSize: 13 }} onClick={() => onReplace(result.result)}>แทนที่ข้อความ</button>}
                {onInsert && <button type="button" className="tech-button-outline" style={{ fontSize: 13 }} onClick={() => onInsert(result.result)}>แทรกต่อท้าย</button>}
                <button type="button" className="tech-button-outline" style={{ fontSize: 13 }} onClick={() => navigator.clipboard?.writeText(result.result)}>คัดลอก</button>
              </div>
            </>
          )}
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>{AI_DISCLAIMER}</p>
        </div>
      )}
    </div>
  );
};
