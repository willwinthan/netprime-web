import React, { useEffect, useRef, useState } from "react";
import { API_BASE_URL, apiFetch } from "../../hooks/useApi";
import { publicPost } from "../site/PublicSections";
import { Link } from "../../site/router";

/**
 * Floating sales assistant for the public website. Answers from published courses, sessions,
 * articles and FAQ only (server-side retrieval), and hands off to staff through the existing
 * contact form endpoint (/public/inquiries). Hidden when the admin switches the chatbot off.
 */

interface Source { type: "course" | "session" | "article" | "faq"; title: string; url: string }
interface ChatMessage { role: "user" | "assistant"; text: string; sources?: Source[]; mock?: boolean; handoff?: boolean; suggestions?: string[]; stream?: boolean }

const SOURCE_LABEL: Record<Source["type"], string> = { course: "คอร์ส", session: "รอบอบรม", article: "บทความ", faq: "คำถามที่พบบ่อย" };
const TURNSTILE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
const GREETING = "สวัสดีครับ สอบถามเรื่องคอร์ส รอบอบรม การชำระเงิน ใบประกาศนียบัตร หรือการเดินทางได้เลย หรือเลือกคำถามด้านล่าง";

/** Renders **bold** and [text](/internal-link) only; everything else is plain text. */
function renderReply(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={key++}>{m[1]}</strong>);
    else if (m[3].startsWith("/") && !m[3].startsWith("//")) out.push(<Link key={key++} to={m[3]}>{m[2]}</Link>);
    else out.push(m[2]);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---------- Typing effect ----------
// The whole reply has already arrived; it is only shown a little at a time, like typing.

/** Pieces the text is revealed by: a whole markdown link, "**", or one grapheme (keeps Thai vowels and tone marks with their consonant). */
const graphemes = typeof Intl !== "undefined" && (Intl as any).Segmenter ? new (Intl as any).Segmenter("th", { granularity: "grapheme" }) : null;
function revealUnits(text: string): string[] {
  const units: string[] = [];
  for (const part of text.split(/(\[[^\]]+\]\([^)\s]+\)|\*\*)/)) {
    if (!part) continue;
    if (part === "**" || part.startsWith("[")) units.push(part);
    else if (graphemes) for (const g of graphemes.segment(part)) units.push(g.segment);
    else units.push(...Array.from(part));
  }
  return units;
}

/** Typing time grows with the length of the reply in three steps; a very short reply finishes sooner (25 ms a piece at most). */
const TYPING_TIERS = [
  { upTo: 200, ms: 1200 },      // one or two sentences
  { upTo: 500, ms: 2500 },      // a typical FAQ answer
  { upTo: Infinity, ms: 4000 }  // a list of courses or a long answer
];
function typingDuration(chars: number, pieces: number): number {
  const tier = TYPING_TIERS.find(t => chars <= t.upTo)!;
  return Math.min(tier.ms, pieces * 25);
}

const TYPING_CSS = `@keyframes np-caret { 50% { opacity: 0 } }
.np-streaming::after { content: ""; display: inline-block; width: 2px; height: 1.05em; margin-left: 2px; vertical-align: -0.15em; background: var(--ps-brand-strong); animation: np-caret .8s steps(1) infinite; }
@keyframes np-fade-in { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
.np-fade-in { animation: np-fade-in .3s ease-out both; }
@media (prefers-reduced-motion: reduce) { .np-fade-in { animation: none; } .np-streaming::after { animation: none; } }`;

const StreamedReply: React.FC<{ text: string; onProgress: () => void; onDone: () => void }> = ({ text, onProgress, onDone }) => {
  const [shown, setShown] = useState("");
  const progress = useRef(onProgress);
  const done = useRef(onDone);
  progress.current = onProgress;
  done.current = onDone;
  useEffect(() => {
    const units = revealUnits(text);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || document.hidden || units.length < 2) { setShown(text); done.current(); return; }
    // Progress follows the clock, not the frame count, so a throttled tab still finishes on time.
    const duration = typingDuration(text.length, units.length);
    const started = performance.now();
    let count = 0, partial = "", frame = 0;
    const step = () => {
      const target = Math.min(units.length, Math.ceil((performance.now() - started) / duration * units.length));
      while (count < target) partial += units[count++];
      // Close an open ** so half-revealed bold text does not show the asterisks.
      const open = (partial.match(/\*\*/g) || []).length % 2 === 1;
      setShown(open ? partial + "**" : partial);
      progress.current();
      if (count < units.length) frame = requestAnimationFrame(step);
      else done.current();
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text]);
  return <span className={shown === text ? undefined : "np-streaming"}>{renderReply(shown)}</span>;
};

const Turnstile: React.FC<{ onToken: (token: string) => void }> = ({ onToken }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!TURNSTILE_KEY || !ref.current) return;
    const render = () => (window as any).turnstile?.render(ref.current, { sitekey: TURNSTILE_KEY, callback: onToken });
    if ((window as any).turnstile) { render(); return; }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.onload = render;
    document.head.appendChild(script);
  }, []);
  return TURNSTILE_KEY ? <div ref={ref} /> : null;
};

const LeadForm: React.FC<{ lastQuestion: string; onDone: (message: string) => void; onCancel: () => void }> = ({ lastQuestion, onDone, onCancel }) => {
  const [form, setForm] = useState({ name: "", email: "", phone: "", message: lastQuestion ? `สอบถามจากแชทบอท: ${lastQuestion}` : "", consent: false, website: "", turnstile_token: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const data = await publicPost<{ message: string }>("/inquiries", { ...form, topic: "สอบถามผ่านแชทบอท" });
      onDone(data.message);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  const field: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid var(--ps-field)", borderRadius: 10, font: "inherit", fontSize: 14 };
  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderTop: "1px solid var(--ps-line)" }}>
      <strong style={{ fontSize: 14 }}>ให้เจ้าหน้าที่ติดต่อกลับ</strong>
      <input style={field} required maxLength={120} placeholder="ชื่อ-นามสกุล" aria-label="ชื่อ-นามสกุล" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
      <input style={field} required type="email" maxLength={254} placeholder="อีเมล" aria-label="อีเมล" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
      <input style={field} maxLength={30} placeholder="เบอร์โทร (ไม่บังคับ)" aria-label="เบอร์โทร" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
      <textarea style={field} required rows={3} maxLength={3000} aria-label="ข้อความ" value={form.message} onChange={e => setForm({ ...form, message: e.target.value })} />
      <input type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={e => setForm({ ...form, website: e.target.value })} style={{ position: "absolute", left: "-9999px" }} />
      <Turnstile onToken={token => setForm(prev => ({ ...prev, turnstile_token: token }))} />
      <label style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--ps-ink-2)" }}>
        <input type="checkbox" required checked={form.consent} onChange={e => setForm({ ...form, consent: e.target.checked })} />
        <span>ยินยอมให้ติดต่อกลับตาม<Link to="/privacy">นโยบายความเป็นส่วนตัว</Link></span>
      </label>
      {error && <p role="alert" style={{ color: "#b42318", fontSize: 13, margin: 0 }}>{error}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="ps-btn ps-btn-primary" disabled={busy} style={{ flex: 1 }}>{busy ? "กำลังส่ง..." : "ส่งข้อมูล"}</button>
        <button type="button" className="ps-btn" onClick={onCancel}>ยกเลิก</button>
      </div>
    </form>
  );
};

export const AiSalesChatWidget: React.FC = () => {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: "assistant", text: GREETING }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [lead, setLead] = useState(false);
  /** Index of the reply being typed out; its sources and buttons appear once it is complete. */
  const [typing, setTyping] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typingRef = useRef<HTMLDivElement>(null);
  /** Keeps the growing reply in view, but never scrolls its first line out of sight. */
  const followReply = () => {
    const list = listRef.current, el = typingRef.current;
    if (!list || !el) return;
    list.scrollTop = Math.min(el.offsetTop - list.offsetTop - 8, list.scrollHeight - list.clientHeight);
  };

  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE_URL}/ai/public/config`).then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!alive) return;
        setEnabled(!!data?.chatbot_enabled);
        if (Array.isArray(data?.suggestions)) setMessages(prev => prev.length === 1 ? [{ ...prev[0], suggestions: data.suggestions.slice(0, 6) }] : prev);
      }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    // While a reply is typed out (and right after), follow its first line instead of jumping to the bottom.
    if (typing !== null) return;
    if (messages[messages.length - 1]?.stream) { followReply(); return; }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, lead, typing]);

  if (!enabled) return null;

  const ask = async (question: string) => {
    const text = question.trim().slice(0, 500);
    if (!text || busy || typing !== null) return;
    const history = messages.slice(1).slice(-6).map(m => ({ role: m.role, text: m.text }));
    setMessages(prev => [...prev, { role: "user", text }]);
    setInput("");
    setBusy(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/ai/public/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text, history })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "ส่งข้อความไม่สำเร็จ กรุณาลองใหม่");
      // Only one question is in flight, so the reply lands right after the question added above.
      setTyping(messages.length + 1);
      setMessages(prev => [...prev, { role: "assistant", text: data.reply, sources: data.sources, mock: data.mock, handoff: data.handoff,
        suggestions: Array.isArray(data.suggestions) ? data.suggestions.slice(0, 4) : undefined, stream: true }]);
    } catch (err: any) {
      setMessages(prev => [...prev, { role: "assistant", text: err.message }]);
    } finally { setBusy(false); }
  };
  const send = (e: React.FormEvent) => { e.preventDefault(); ask(input); };

  const lastQuestion = [...messages].reverse().find(m => m.role === "user")?.text ?? "";

  return (
    <div style={{ position: "fixed", right: 16, bottom: 16, zIndex: 8000, fontSize: 14 }}>
      <style>{TYPING_CSS}</style>
      {open && (
        <div role="dialog" aria-label="ผู้ช่วยตอบคำถาม" className="ps-card"
          style={{ width: "min(360px, calc(100vw - 32px))", height: "min(560px, calc(100vh - 100px))", display: "flex", flexDirection: "column", marginBottom: 12, boxShadow: "0 18px 48px rgba(24,36,67,0.18)", overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", background: "var(--ps-brand-strong)", color: "#fff" }}>
            <strong>ผู้ช่วย NetPrime</strong>
            <button type="button" onClick={() => setOpen(false)} aria-label="ปิดแชท" style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 20, lineHeight: 1 }}>×</button>
          </div>
          <div ref={listRef} aria-live="polite" style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10, background: "var(--ps-cream)" }}>
            {messages.map((m, i) => {
              const isTyping = i === typing;
              // Sources and buttons appear once the reply is fully shown, and fade in if it was typed out.
              const extras = m.stream ? "np-fade-in" : undefined;
              return (
              <div key={i} ref={isTyping ? typingRef : undefined} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%" }}>
                <div style={{ whiteSpace: "pre-wrap", padding: "8px 12px", borderRadius: 14, lineHeight: 1.6,
                  background: m.role === "user" ? "var(--ps-blue)" : "#fff", color: m.role === "user" ? "#fff" : "var(--ps-ink)", border: m.role === "user" ? "none" : "1px solid var(--ps-line)" }}>
                  {m.role === "user" ? m.text : isTyping
                    ? <StreamedReply text={m.text} onProgress={followReply} onDone={() => setTyping(null)} />
                    : renderReply(m.text)}
                </div>
                {!isTyping && m.sources && m.sources.length > 0 && (
                  <div className={extras} style={{ fontSize: 12, color: "var(--ps-ink-2)", marginTop: 4 }}>
                    แหล่งข้อมูล: {m.sources.map((s, si) => <React.Fragment key={si}>{si > 0 && " · "}<Link to={s.url}>{SOURCE_LABEL[s.type]}: {s.title}</Link></React.Fragment>)}
                  </div>
                )}
                {!isTyping && m.mock && <div className={extras} style={{ fontSize: 11, color: "var(--ps-ink-2)", marginTop: 2 }}>สรุปจากรายการบนเว็บไซต์โดยตรง</div>}
                {!isTyping && m.suggestions && m.suggestions.length > 0 && i === messages.length - 1 && !busy && (
                  <div className={extras} style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                    {m.suggestions.map(q => (
                      <button key={q} type="button" onClick={() => ask(q)}
                        style={{ fontSize: 12, padding: "5px 10px", borderRadius: 999, border: "1px solid var(--ps-line)", background: "#fff", color: "var(--ps-brand-strong)", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                        {q}
                      </button>
                    ))}
                  </div>
                )}
                {!isTyping && m.handoff && !lead && (
                  <button type="button" className={`ps-btn${extras ? ` ${extras}` : ""}`} style={{ marginTop: 6, fontSize: 13 }} onClick={() => setLead(true)}>ให้เจ้าหน้าที่ติดต่อกลับ</button>
                )}
              </div>
              );
            })}
            {busy && <div style={{ color: "var(--ps-ink-2)", fontSize: 13 }}>กำลังพิมพ์...</div>}
          </div>
          {lead ? (
            <LeadForm lastQuestion={lastQuestion} onCancel={() => setLead(false)}
              onDone={message => { setLead(false); setMessages(prev => [...prev, { role: "assistant", text: message }]); }} />
          ) : (
            <>
              <form onSubmit={send} style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--ps-line)" }}>
                <input value={input} onChange={e => setInput(e.target.value)} maxLength={500} placeholder="พิมพ์คำถาม..." aria-label="พิมพ์คำถาม"
                  style={{ flex: 1, padding: "8px 12px", border: "1px solid var(--ps-field)", borderRadius: 10, font: "inherit" }} />
                <button type="submit" className="ps-btn ps-btn-primary" disabled={busy || typing !== null || !input.trim()}>ส่ง</button>
              </form>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "0 12px 10px", fontSize: 11, color: "var(--ps-ink-2)" }}>
                <span>ตอบจากข้อมูลบนเว็บไซต์ อาจคลาดเคลื่อนได้</span>
                <button type="button" onClick={() => setLead(true)} style={{ background: "none", border: "none", color: "var(--ps-brand-strong)", cursor: "pointer", fontSize: 11, padding: 0 }}>ให้เจ้าหน้าที่ติดต่อกลับ</button>
              </div>
            </>
          )}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="ps-btn ps-btn-primary"
          style={{ borderRadius: 999, minHeight: 52, padding: "0 20px", boxShadow: "0 10px 28px rgba(194,84,26,0.35)" }}>
          {open ? "ปิดแชท" : "สอบถามเรา"}
        </button>
      </div>
    </div>
  );
};
