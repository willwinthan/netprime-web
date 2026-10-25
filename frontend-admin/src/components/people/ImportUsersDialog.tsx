import React, { useState } from "react";
import { Download, FileUp, Upload } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, ErrorBox, Modal, tableStyle, tdStyle, thStyle, downloadWithAuth } from "../site-admin/ui";
import { noticeStyle, ProfileField, saveBlob } from "./shared";

type Action = "create" | "update" | "skip" | "error";
interface PreviewRow { row_no: number; email: string; name: string; action: Action; errors: string[]; warnings: string[]; roles: string[]; tags: string[]; course_ids: string[] }
interface Preview {
  import_id: string; batch_size: number; unknown_columns: string[];
  summary: { total: number; create: number; update: number; skip: number; error: number };
  rows: PreviewRow[]; records: Array<{ row_no: number; cells: Record<string, string> }>;
}
interface RowResult { row_no: number; email: string; result: "created" | "updated" | "skipped" | "failed"; message: string | null }

const ACTION_CHIP: Record<Action, { label: string; color: string; bg: string }> = {
  create: { label: "สร้างใหม่", color: "var(--accent)", bg: "var(--accent-glow)" },
  update: { label: "อัปเดต", color: "var(--primary)", bg: "var(--primary-glow)" },
  skip: { label: "ข้าม", color: "var(--text-secondary)", bg: "rgba(15,23,42,0.06)" },
  error: { label: "มีปัญหา", color: "#b42318", bg: "rgba(239,68,68,0.1)" }
};

/** CSV template with the standard columns plus every custom field. */
function templateCsv(fields: ProfileField[]): string {
  const header = ["email", "name", "roles", "organization", "tags", "courses", "password", ...fields.map(f => f.key)];
  const sample = ["somchai@example.com", "สมชาย ใจดี", "student", "", "รุ่น1|vip", "", "", ...fields.map(() => "")];
  return "﻿" + header.join(",") + "\r\n" + sample.join(",") + "\r\n";
}

/** Upload → preview with per-row validation → commit in batches → downloadable result report. */
export const ImportUsersDialog: React.FC<{ fields: ProfileField[]; onClose: () => void; onDone: () => void }> = ({ fields, onClose, onDone }) => {
  const api = useApi();
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"skip" | "update">("skip");
  const [setup, setSetup] = useState<"invite" | "password">("invite");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [results, setResults] = useState<RowResult[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const runPreview = async () => {
    if (!file) return;
    try {
      setBusy(true);
      setError(null);
      setResults(null);
      if (file.size > 3_000_000) throw new Error("ไฟล์ใหญ่เกินไป (ไม่เกิน 3 MB)");
      const csv = await file.text();
      setPreview(await api.post<Preview>("/admin/people/import/preview", { csv, filename: file.name, mode, setup }));
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const commit = async () => {
    if (!preview) return;
    const records = preview.records;
    const all: RowResult[] = [];
    try {
      setBusy(true);
      setError(null);
      for (let i = 0; i < records.length; i += preview.batch_size) {
        setProgress({ done: i, total: records.length });
        const batch = records.slice(i, i + preview.batch_size);
        // A failed request (network) can simply be retried: rows already saved are not applied twice.
        let res: { results: RowResult[] } | null = null;
        for (let attempt = 0; attempt < 3 && !res; attempt++) {
          try { res = await api.post<{ results: RowResult[] }>(`/admin/people/import/${preview.import_id}/commit`, { records: batch }); }
          catch (err) { if (attempt === 2) throw err; }
        }
        all.push(...res!.results);
      }
      setProgress({ done: records.length, total: records.length });
      setResults(all);
      onDone();
    } catch (err: any) {
      setResults(all);
      setError(`${err.message} — กด "นำเข้า" อีกครั้งเพื่อทำต่อ แถวที่บันทึกแล้วจะไม่ถูกสร้างซ้ำ`);
    } finally { setBusy(false); }
  };

  const counts = results?.reduce((acc, r) => ({ ...acc, [r.result]: (acc[r.result] ?? 0) + 1 }), {} as Record<string, number>);
  const shownRows = preview ? (onlyProblems ? preview.rows.filter(r => r.action === "error" || r.warnings.length) : preview.rows) : [];
  const resultOf = (row: number) => results?.find(r => r.row_no === row);

  return (
    <Modal title="นำเข้าผู้ใช้จาก CSV" onClose={onClose} width={980}>
      <ErrorBox message={error} />
      <div style={{ display: "grid", gap: 14 }}>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)" }}>
          ไฟล์ UTF-8 (มีหรือไม่มี BOM) ไม่เกิน 2,000 แถว คอลัมน์: <code>email</code> (จำเป็น), <code>name</code>, <code>roles</code> (คั่นด้วย |),
          {" "}<code>organization</code> (รหัสหรือชื่อองค์กร), <code>tags</code>, <code>courses</code> (รหัสคอร์สที่จะลงทะเบียนให้), <code>password</code> และรหัสฟิลด์เพิ่มเติม
          {" "}<button type="button" className="tech-button-outline" style={{ padding: "2px 10px", fontSize: 12, borderWidth: 1 }}
            onClick={() => saveBlob(new Blob([templateCsv(fields)], { type: "text/csv;charset=utf-8" }), "netprime-users-template.csv")}><Download size={12} />ดาวน์โหลดแม่แบบ</button>
        </p>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
          <label className="tech-button-outline" style={{ cursor: "pointer" }}>
            <FileUp size={16} />{file ? file.name : "เลือกไฟล์ CSV"}
            <input type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={e => { setFile(e.target.files?.[0] ?? null); setPreview(null); setResults(null); }} />
          </label>
          <fieldset style={{ border: 0, padding: 0, margin: 0, fontSize: 14, display: "grid", gap: 4 }}>
            <legend className="form-label">บัญชีที่มีอยู่แล้ว</legend>
            <label><input type="radio" checked={mode === "skip"} onChange={() => { setMode("skip"); setPreview(null); }} /> ข้าม</label>
            <label><input type="radio" checked={mode === "update"} onChange={() => { setMode("update"); setPreview(null); }} /> อัปเดต (เพิ่มบทบาท แท็ก คอร์ส และฟิลด์ ไม่ลดสิทธิ์เดิม)</label>
          </fieldset>
          <fieldset style={{ border: 0, padding: 0, margin: 0, fontSize: 14, display: "grid", gap: 4 }}>
            <legend className="form-label">บัญชีใหม่</legend>
            <label><input type="radio" checked={setup === "invite"} onChange={() => { setSetup("invite"); setPreview(null); }} /> ส่งลิงก์เชิญทางอีเมล (แนะนำ)</label>
            <label><input type="radio" checked={setup === "password"} onChange={() => { setSetup("password"); setPreview(null); }} /> ใช้รหัสผ่านชั่วคราวจากคอลัมน์ password</label>
          </fieldset>
          <button type="button" className="tech-button-primary" disabled={!file || busy} onClick={runPreview} style={{ marginLeft: "auto" }}>{busy && !preview ? "กำลังตรวจ…" : "ตรวจสอบไฟล์"}</button>
        </div>

        {preview && (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 14 }}>
              <strong>{preview.summary.total.toLocaleString("th-TH")} แถว:</strong>
              <Chip {...ACTION_CHIP.create} label={`สร้างใหม่ ${preview.summary.create}`} />
              <Chip {...ACTION_CHIP.update} label={`อัปเดต ${preview.summary.update}`} />
              <Chip {...ACTION_CHIP.skip} label={`ข้าม ${preview.summary.skip}`} />
              <Chip {...ACTION_CHIP.error} label={`มีปัญหา ${preview.summary.error}`} />
              <label style={{ marginLeft: "auto" }}><input type="checkbox" checked={onlyProblems} onChange={e => setOnlyProblems(e.target.checked)} /> แสดงเฉพาะแถวที่มีปัญหา/คำเตือน</label>
            </div>
            {preview.unknown_columns.length > 0 && (
              <div style={{ ...noticeStyle, background: "#fff4dc", color: "#7a4b00", marginBottom: 0 }}>ไม่รู้จักคอลัมน์: {preview.unknown_columns.join(", ")} (จะไม่ถูกนำเข้า)</div>
            )}
            <div style={{ maxHeight: 360, overflow: "auto", border: "1px solid rgba(15,23,42,0.08)", borderRadius: 12 }}>
              <table style={tableStyle}>
                <thead><tr><th style={thStyle}>แถว</th><th style={thStyle}>อีเมล / ชื่อ</th><th style={thStyle}>บทบาท</th><th style={thStyle}>ผลตรวจ</th>{results && <th style={thStyle}>ผลนำเข้า</th>}</tr></thead>
                <tbody>
                  {shownRows.slice(0, 500).map(r => {
                    const result = resultOf(r.row_no);
                    return (
                      <tr key={r.row_no}>
                        <td style={tdStyle}>{r.row_no}</td>
                        <td style={tdStyle}>{r.email}<div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{r.name}</div></td>
                        <td style={{ ...tdStyle, fontSize: 13 }}>{r.roles.join(", ")}{r.tags.length > 0 && <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>แท็ก: {r.tags.join(", ")}</div>}</td>
                        <td style={tdStyle}><Chip {...ACTION_CHIP[r.action]} />
                          {r.errors.map(e => <div key={e} style={{ fontSize: 12, color: "#b42318" }}>{e}</div>)}
                          {r.warnings.map(w => <div key={w} style={{ fontSize: 12, color: "#9a5b00" }}>{w}</div>)}</td>
                        {results && <td style={{ ...tdStyle, fontSize: 13 }}>{result ? <>{result.result}{result.message && <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{result.message}</div>}</> : "-"}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {shownRows.length > 500 && <p style={{ fontSize: 13, color: "var(--text-secondary)", padding: "0 12px" }}>แสดง 500 แถวแรก ดูทั้งหมดในรายงานผลหลังนำเข้า</p>}
            </div>
            {progress && busy && <div role="status" style={{ fontSize: 14 }}>กำลังนำเข้า {progress.done.toLocaleString("th-TH")} / {progress.total.toLocaleString("th-TH")} แถว…</div>}
            {results && counts && (
              <div role="status" style={noticeStyle}>
                นำเข้าแล้ว: สร้างใหม่ {counts.created ?? 0} · อัปเดต {counts.updated ?? 0} · ข้าม {counts.skipped ?? 0} · ไม่สำเร็จ {counts.failed ?? 0}
              </div>
            )}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
              {results && <button type="button" className="tech-button-outline" onClick={() => downloadWithAuth(`/admin/people/import/${preview.import_id}/report`, api.token, `import-report-${preview.import_id}.csv`).catch(err => setError(err.message))}><Download size={16} />ดาวน์โหลดรายงานผล</button>}
              <button type="button" className="tech-button-outline" onClick={onClose}>ปิด</button>
              <button type="button" className="tech-button-primary" disabled={busy || preview.summary.create + preview.summary.update === 0}
                onClick={commit}><Upload size={16} />{busy ? "กำลังนำเข้า…" : `นำเข้า ${preview.summary.create + preview.summary.update} แถว`}</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};
