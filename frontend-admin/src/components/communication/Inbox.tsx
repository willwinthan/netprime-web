import React, { useEffect, useRef, useState } from "react";
import { MessageSquare, Send, Paperclip, Plus, Search, X } from "lucide-react";
import { useApi, hasRole, API_BASE_URL } from "../../hooks/useApi";
import { ErrorBox, Empty, formatDateTime } from "../site-admin/ui";

interface Thread { id: string; other_id: string; other_name: string; other_role: string; last_body: string | null; last_message_at: string | null; unread_count: number }
interface Message { id: string; sender_id: string; sender_name: string; body: string; has_attachment: number; attachment_type: string | null; created_at: string }
interface Contact { id: string; name: string; email?: string; role: string; context?: string }

const ROLE_LABEL: Record<string, string> = { admin: "ผู้ดูแลระบบ", coordinator: "เจ้าหน้าที่", instructor: "ผู้สอน", partner: "องค์กร", student: "ผู้เรียน" };
const MAX_ATTACHMENT = 5 * 1024 * 1024;

/** Private image shown through an authenticated fetch (attachments are not public URLs). */
const AttachmentImage: React.FC<{ messageId: string; token: string | null }> = ({ messageId, token }) => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    fetch(`${API_BASE_URL}/inbox/messages/${messageId}/attachment`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.ok ? r.blob() : null)
      .then(blob => { if (blob && !revoked) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } })
      .catch(() => undefined);
    return () => { revoked = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [messageId, token]);
  return url ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="ไฟล์แนบ" style={{ maxWidth: "240px", maxHeight: "240px", borderRadius: "8px", display: "block", marginTop: "6px" }} /></a>
    : <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>กำลังโหลดรูป…</span>;
};

/**
 * Direct messages (learner ↔ instructor/staff). `startWithUserId` opens (or creates) the thread with that user —
 * staff use it from a user's profile. `onUnreadChange` reports the total unread count (e.g. for a badge).
 */
export const Inbox: React.FC<{ startWithUserId?: string; initialThreadId?: string; onUnreadChange?: (n: number) => void }> = ({ startWithUserId, initialThreadId, onUnreadChange }) => {
  const api = useApi();
  const me = api.user;
  const staff = hasRole(me, "admin", "coordinator", "instructor");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(initialThreadId ?? null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [other, setOther] = useState<{ id: string; name: string; roles: string[] } | null>(null);
  const [canReply, setCanReply] = useState(true);
  const [draft, setDraft] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [query, setQuery] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadThreads = async () => {
    try {
      const data = await api.get<{ threads: Thread[]; unread: number }>("/inbox/threads");
      setThreads(data.threads);
      onUnreadChange?.(data.unread);
    } catch (err: any) { setError(err.message); }
  };

  const openThread = async (id: string) => {
    try {
      setActiveId(id);
      setError(null);
      const data = await api.get<{ thread: { other: typeof other; can_reply: boolean }; messages: Message[] }>(`/inbox/threads/${id}/messages`);
      setMessages(data.messages);
      setOther(data.thread.other);
      setCanReply(data.thread.can_reply);
      setThreads(list => {
        const next = list.map(t => t.id === id ? { ...t, unread_count: 0 } : t);
        onUnreadChange?.(next.reduce((n, t) => n + t.unread_count, 0));
        return next;
      });
    } catch (err: any) { setError(err.message); }
  };

  const startWith = async (userId: string) => {
    try {
      setError(null);
      const data = await api.post<{ thread: { id: string } }>("/inbox/threads", { user_id: userId });
      setPicking(false);
      await loadThreads();
      await openThread(data.thread.id);
    } catch (err: any) { setError(err.message); }
  };

  useEffect(() => {
    loadThreads();
    if (startWithUserId) startWith(startWithUserId);
    else if (initialThreadId) openThread(initialThreadId);
  }, [api.token, startWithUserId, initialThreadId]);

  // Light polling while the inbox is open.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      loadThreads();
      if (activeId) api.get<{ messages: Message[] }>(`/inbox/threads/${activeId}/messages`).then(d => setMessages(d.messages)).catch(() => undefined);
    }, 20000);
    return () => window.clearInterval(timer);
  }, [activeId, api.token]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages.length, activeId]);

  useEffect(() => {
    if (!picking) return;
    if (staff && query.trim().length < 2) { setContacts([]); return; }
    const timer = window.setTimeout(() => {
      api.get<{ contacts: Contact[] }>(`/inbox/contacts${staff ? `?q=${encodeURIComponent(query.trim())}` : ""}`)
        .then(d => setContacts(d.contacts)).catch(err => setError(err.message));
    }, staff ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [picking, query]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeId || (!draft.trim() && !file)) return;
    try {
      setBusy(true);
      setError(null);
      let message: Message;
      if (file) {
        const form = new FormData();
        form.append("body", draft.trim());
        form.append("file", file);
        message = (await api.request<{ message: Message }>(`/inbox/threads/${activeId}/messages`, { method: "POST", body: form })).message;
      } else {
        message = (await api.post<{ message: Message }>(`/inbox/threads/${activeId}/messages`, { body: draft.trim() })).message;
      }
      setMessages(list => [...list, message]);
      setDraft("");
      setFile(null);
      loadThreads();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const pickFile = (f: File | undefined) => {
    if (!f) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) { setError("แนบได้เฉพาะรูป PNG, JPG, WEBP หรือ GIF"); return; }
    if (f.size > MAX_ATTACHMENT) { setError("ไฟล์แนบต้องไม่เกิน 5 MB"); return; }
    setError(null);
    setFile(f);
  };

  return (
    <div className="glass-card" style={{ padding: 0, display: "grid", gridTemplateColumns: "minmax(220px, 300px) 1fr", minHeight: "480px", overflow: "hidden" }}>
      <aside style={{ borderRight: "1px solid rgba(0,0,0,0.06)", display: "flex", flexDirection: "column" }} aria-label="รายการบทสนทนา">
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "14px 16px", borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
          <MessageSquare size={16} />
          <strong style={{ flex: 1, fontSize: "15px" }}>ข้อความ</strong>
          <button type="button" onClick={() => setPicking(p => !p)} aria-label="ข้อความใหม่" title="ข้อความใหม่" className="tech-button-outline" style={{ padding: "4px 8px", borderRadius: "99px" }}>
            {picking ? <X size={14} /> : <Plus size={14} />}
          </button>
        </div>
        {picking && (
          <div style={{ padding: "10px 12px", borderBottom: "1px solid rgba(0,0,0,0.06)", background: "rgba(99,102,241,0.04)" }}>
            {staff && (
              <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" }}>
                <Search size={14} />
                <input className="form-input" autoFocus aria-label="ค้นหาผู้ใช้" placeholder="ค้นหาชื่อหรืออีเมล" value={query} onChange={e => setQuery(e.target.value)} style={{ padding: "6px 10px", fontSize: "13px" }} />
              </div>
            )}
            {contacts.length === 0
              ? <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{staff ? "พิมพ์อย่างน้อย 2 ตัวอักษร" : "ยังไม่มีผู้สอนหรือเจ้าหน้าที่ที่ส่งข้อความได้"}</div>
              : contacts.map(ct => (
                <button key={ct.id} type="button" onClick={() => startWith(ct.id)}
                  style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", padding: "6px 4px", cursor: "pointer", fontSize: "13px" }}>
                  <strong>{ct.name}</strong> <span style={{ color: "var(--text-muted)", fontSize: "11px" }}>{ROLE_LABEL[ct.role] ?? ct.role}{ct.context ? ` • ${ct.context}` : ""}{ct.email ? ` • ${ct.email}` : ""}</span>
                </button>
              ))}
          </div>
        )}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {threads.length === 0 ? <Empty text="ยังไม่มีบทสนทนา" /> : threads.map(t => (
            <button key={t.id} type="button" onClick={() => openThread(t.id)} aria-current={t.id === activeId}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "12px 16px", border: "none", borderBottom: "1px solid rgba(0,0,0,0.04)", cursor: "pointer",
                background: t.id === activeId ? "var(--primary-glow)" : "transparent" }}>
              <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <strong style={{ flex: 1, fontSize: "14px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.other_name}</strong>
                {t.unread_count > 0 && <span aria-label={`${t.unread_count} ข้อความใหม่`} style={{ background: "var(--danger)", color: "#fff", borderRadius: "99px", fontSize: "11px", padding: "1px 7px" }}>{t.unread_count}</span>}
              </div>
              <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{ROLE_LABEL[t.other_role] ?? t.other_role}</div>
              <div style={{ fontSize: "12px", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.last_body || (t.last_message_at ? "รูปภาพ" : "เริ่มบทสนทนา")}</div>
            </button>
          ))}
        </div>
      </aside>

      <section style={{ display: "flex", flexDirection: "column", minWidth: 0 }} aria-label="บทสนทนา">
        {!activeId ? <Empty text="เลือกบทสนทนา หรือกด + เพื่อส่งข้อความถึงผู้สอน/เจ้าหน้าที่" /> : (
          <>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
              <strong>{other?.name ?? ""}</strong>
              {other && <span style={{ fontSize: "12px", color: "var(--text-muted)", marginLeft: "8px" }}>{other.roles.map(r => ROLE_LABEL[r] ?? r).join(", ")}</span>}
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "10px", maxHeight: "520px" }} aria-live="polite">
              {messages.length === 0 && <Empty text="ยังไม่มีข้อความ" />}
              {messages.map(m => {
                const mine = m.sender_id === me?.id;
                return (
                  <div key={m.id} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "75%" }}>
                    <div style={{ background: mine ? "var(--primary)" : "rgba(15,23,42,0.06)", color: mine ? "#fff" : "var(--text-primary)", padding: "8px 12px", borderRadius: "14px", whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "14px" }}>
                      {m.body}
                      {m.has_attachment ? <AttachmentImage messageId={m.id} token={api.token} /> : null}
                    </div>
                    <div style={{ fontSize: "10px", color: "var(--text-muted)", textAlign: mine ? "right" : "left", marginTop: "2px" }}>{formatDateTime(m.created_at)}</div>
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>
            <div style={{ padding: "0 18px" }}><ErrorBox message={error} /></div>
            {canReply ? (
              <form onSubmit={send} style={{ display: "flex", gap: "8px", padding: "12px 18px", borderTop: "1px solid rgba(0,0,0,0.06)", alignItems: "flex-end" }}>
                <button type="button" onClick={() => fileRef.current?.click()} aria-label="แนบรูป" title="แนบรูป (ไม่เกิน 5 MB)" style={{ background: "none", border: "none", cursor: "pointer", color: file ? "var(--primary)" : "var(--text-secondary)", padding: "8px" }}>
                  <Paperclip size={18} />
                </button>
                <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => { pickFile(e.target.files?.[0]); e.target.value = ""; }} />
                <div style={{ flex: 1 }}>
                  {file && <div style={{ fontSize: "12px", marginBottom: "4px" }}>แนบ: {file.name} <button type="button" onClick={() => setFile(null)} style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer" }}>ลบ</button></div>}
                  <textarea className="form-input" aria-label="พิมพ์ข้อความ" rows={2} maxLength={5000} value={draft} placeholder="พิมพ์ข้อความ…" onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement)?.requestSubmit(); } }}
                    style={{ width: "100%", resize: "vertical", boxSizing: "border-box" }} />
                </div>
                <button type="submit" className="tech-button-primary" disabled={busy || (!draft.trim() && !file)} aria-label="ส่ง" style={{ padding: "10px 14px" }}><Send size={16} /></button>
              </form>
            ) : (
              <div style={{ padding: "12px 18px", fontSize: "13px", color: "var(--text-muted)", borderTop: "1px solid rgba(0,0,0,0.06)" }}>ไม่สามารถตอบกลับบทสนทนานี้ได้</div>
            )}
          </>
        )}
      </section>
    </div>
  );
};

/** Small unread badge count for a nav button (polls every minute). */
export function useInboxUnread(): number {
  const api = useApi();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!api.token) return;
    const load = () => api.get<{ unread: number }>("/inbox/unread").then(d => setCount(d.unread)).catch(() => undefined);
    load();
    const timer = window.setInterval(() => { if (!document.hidden) load(); }, 60000);
    return () => window.clearInterval(timer);
  }, [api.token]);
  return count;
}
