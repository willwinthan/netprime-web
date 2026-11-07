import React, { useEffect, useRef, useState } from "react";
import { FileClock, History, Save, Trash2 } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Empty, ErrorBox, Modal } from "../site-admin/ui";

/**
 * Draft / history bar for the website builder's theme, homepage and menus (API: /site-drafts/:key).
 * Shows whether the editor holds unsaved edits, a saved draft (not public yet) or the published
 * version; saves and discards drafts; and loads an old published version back into the editor, where
 * the live preview shows it before it is published again. Publishing itself stays the panel's button.
 */
interface Props<T> {
  draftKey: "theme" | "home" | "nav";
  /** What the editor holds now. */
  value: T | null;
  /** What is published (set when loaded and after each publish). */
  published: T | null;
  /** Put a draft or an old version into the editor. */
  onLoad: (value: T) => void;
}

interface Version { id: string; published_at: string; published_by_name: string | null }

const thaiTime = (value: string) => new Date(value.replace(" ", "T") + "Z").toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function DraftBar<T>({ draftKey, value, published, onLoad }: Props<T>) {
  const api = useApi();
  const [draft, setDraft] = useState<{ value: T; updated_at: string; by: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<Version[] | null>(null);
  const loaded = useRef(false);

  // Open the saved draft once the published version has loaded.
  useEffect(() => {
    if (!published || loaded.current) return;
    loaded.current = true;
    api.get<{ draft: T | null; updated_at?: string; updated_by_name?: string | null }>(`/site-drafts/${draftKey}`)
      .then(d => {
        if (!d.draft) return;
        setDraft({ value: d.draft, updated_at: d.updated_at!, by: d.updated_by_name ?? null });
        onLoad(d.draft);
      })
      .catch(err => setError(err.message));
  }, [published]);

  // Publishing replaces the draft (the server drops it).
  const lastPublished = useRef(published);
  useEffect(() => {
    if (lastPublished.current && published !== lastPublished.current) { setDraft(null); setNotice(null); }
    lastPublished.current = published;
  }, [published]);

  const flash = (text: string) => { setNotice(text); window.setTimeout(() => setNotice(n => (n === text ? null : n)), 3000); };

  const saveDraft = async () => {
    if (!value) return;
    setBusy(true); setError(null);
    try {
      await api.request(`/site-drafts/${draftKey}`, { method: "PUT", body: JSON.stringify(value) });
      setDraft({ value, updated_at: new Date().toISOString().replace("T", " ").slice(0, 19), by: api.user?.name ?? null });
      flash("บันทึกร่างแล้ว ผู้เข้าชมยังเห็นฉบับที่เผยแพร่อยู่");
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const discard = async () => {
    if (!published || !confirm("ทิ้งฉบับร่างแล้วกลับไปใช้ฉบับที่เผยแพร่อยู่?")) return;
    setBusy(true); setError(null);
    try {
      await api.request(`/site-drafts/${draftKey}`, { method: "DELETE" });
      setDraft(null);
      onLoad(published);
      flash("ทิ้งฉบับร่างแล้ว");
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const openHistory = async () => {
    setError(null);
    try { setHistory((await api.get<{ versions: Version[] }>(`/site-drafts/${draftKey}/versions`)).versions); }
    catch (err: any) { setError(err.message); }
  };

  const restore = async (v: Version) => {
    try {
      const { value: old } = await api.get<{ value: T }>(`/site-drafts/${draftKey}/versions/${v.id}`);
      onLoad(old);
      setHistory(null);
      flash(`นำฉบับวันที่ ${thaiTime(v.published_at)} มาไว้ในตัวแก้แล้ว ตรวจในตัวอย่าง แล้วกดเผยแพร่ถ้าต้องการใช้`);
    } catch (err: any) { setError(err.message); }
  };

  if (!published || !value) return null;
  const unsaved = draft ? !same(value, draft.value) : !same(value, published);
  const status = draft
    ? `กำลังแก้ฉบับร่าง (บันทึกเมื่อ ${thaiTime(draft.updated_at)}${draft.by ? ` โดย ${draft.by}` : ""}) ผู้เข้าชมยังเห็นฉบับที่เผยแพร่`
    : unsaved ? "มีการแก้ที่ยังไม่บันทึก" : "ตรงกับที่เผยแพร่อยู่";

  return (
    <div className="np-draftbar">
      <ErrorBox message={error} />
      <div className="np-draftbar-row">
        <span className={draft || unsaved ? "np-draftbar-status is-pending" : "np-draftbar-status"}>
          <FileClock size={15} /> {status}{draft && unsaved ? " · มีการแก้ที่ยังไม่บันทึก" : ""}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="tech-button-outline" onClick={saveDraft} disabled={busy || !unsaved}><Save size={15} />บันทึกร่าง</button>
        {draft && <button type="button" className="tech-button-outline" onClick={discard} disabled={busy}><Trash2 size={15} />ทิ้งฉบับร่าง</button>}
        <button type="button" className="tech-button-outline" onClick={openHistory}><History size={15} />ประวัติ</button>
      </div>
      {notice && <div role="status" className="np-draftbar-notice">{notice}</div>}
      {history && (
        <Modal title="ประวัติการเผยแพร่" onClose={() => setHistory(null)} width={560}>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 0 }}>เลือกฉบับที่ต้องการ ระบบจะนำมาไว้ในตัวแก้ให้ดูในตัวอย่างก่อน ยังไม่เผยแพร่จนกว่าจะกดเผยแพร่ (เก็บ 30 ฉบับล่าสุด)</p>
          {history.length === 0 ? <Empty text="ยังไม่มีประวัติ ประวัติเริ่มเก็บตั้งแต่การเผยแพร่ครั้งถัดไป" /> : (
            <div style={{ display: "grid", gap: 8 }}>
              {history.map((v, i) => (
                <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px solid var(--border-subtle)", borderRadius: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{thaiTime(v.published_at)}{i === 0 && <span style={{ marginLeft: 8, fontSize: 12, color: "var(--accent)" }}>ฉบับปัจจุบัน</span>}</div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{v.published_by_name ?? "ไม่ทราบผู้เผยแพร่"}</div>
                  </div>
                  <button type="button" className="tech-button-outline" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => restore(v)}>นำมาแก้</button>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
