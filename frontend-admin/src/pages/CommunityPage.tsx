import React, { useEffect, useState } from "react";
import { Users, Pin, Lock, EyeOff, Eye, Flag, ThumbsUp, Heart, Lightbulb, Bell, BellOff, ArrowLeft, MessageCircle, Trash2, Plus } from "lucide-react";
import { useApi, API_BASE_URL } from "../hooks/useApi";
import { ErrorBox, Empty, Modal, Field, formatDateTime } from "../components/site-admin/ui";
import { RichTextEditor, SafeHtml } from "../components/communication/RichTextEditor";

interface Space {
  id: string; course_id: string | null; course_title: string | null; name: string; description: string | null; posting: string;
  post_count?: number; following?: number | boolean; can_moderate?: boolean; can_post?: boolean; archived_at?: string | null;
}
interface Post {
  id: string; space_id: string; author_id: string | null; author_name: string | null; title: string; body: string; body_html: string;
  pinned: number; locked: number; hidden: number; created_at: string; last_activity_at: string; comment_count: number; reaction_count: number;
  my_reactions: string | null; following?: boolean;
}
interface Comment { id: string; author_id: string | null; author_name: string | null; body: string; body_html: string; hidden: number; created_at: string; reaction_count: number; my_reactions: string | null }

const REACTIONS: Array<{ key: string; label: string; icon: React.ReactNode }> = [
  { key: "like", label: "ถูกใจ", icon: <ThumbsUp size={13} /> },
  { key: "love", label: "รักเลย", icon: <Heart size={13} /> },
  { key: "insightful", label: "ได้ความรู้", icon: <Lightbulb size={13} /> }
];

async function uploadCommunityImage(file: File, token: string | null): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE_URL}/community/images`, { method: "POST", body: form, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "อัปโหลดรูปไม่สำเร็จ");
  return data.url;
}

const pill: React.CSSProperties = { padding: "3px 10px", fontSize: "12px", borderRadius: "99px", display: "inline-flex", gap: "4px", alignItems: "center", cursor: "pointer" };

/**
 * Community: school-wide spaces plus the spaces of the learner's courses.
 * `courseId` locks the view to that course's space (course page tab); `initialPostId` opens a post (notification link).
 */
export const CommunityPage: React.FC<{ courseId?: string; initialPostId?: string }> = ({ courseId, initialPostId }) => {
  const api = useApi();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [canCreate, setCanCreate] = useState(false);
  const [space, setSpace] = useState<Space | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [postId, setPostId] = useState<string | null>(initialPostId ?? null);
  const [post, setPost] = useState<Post | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [postRights, setPostRights] = useState<{ can_moderate: boolean; can_post: boolean }>({ can_moderate: false, can_post: false });
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState<{ type: "post" | "comment"; id: string } | null>(null);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [spaceForm, setSpaceForm] = useState({ name: "", description: "", posting: "everyone" });

  const fail = (err: any) => setError(err.message);

  const loadSpaces = async () => {
    if (courseId) {
      const data = await api.get<{ space: Space }>(`/community/courses/${encodeURIComponent(courseId)}/space`);
      setSpaces([data.space]);
      return data.space;
    }
    const data = await api.get<{ spaces: Space[]; can_create: boolean }>("/community/spaces");
    setSpaces(data.spaces);
    setCanCreate(data.can_create);
    return data.spaces[0] ?? null;
  };

  const openSpace = async (s: Space) => {
    try {
      setError(null);
      setPostId(null);
      setPost(null);
      const data = await api.get<{ space: Space; posts: Post[] }>(`/community/spaces/${s.id}/posts`);
      setSpace(data.space);
      setPosts(data.posts);
    } catch (err) { fail(err); }
  };

  const openPost = async (id: string) => {
    try {
      setError(null);
      const data = await api.get<{ post: Post; comments: Comment[]; space: { id: string; can_moderate: boolean; can_post: boolean } }>(`/community/posts/${id}`);
      setPostId(id);
      setPost(data.post);
      setComments(data.comments);
      setPostRights({ can_moderate: data.space.can_moderate, can_post: data.space.can_post });
    } catch (err) { fail(err); setPostId(null); }
  };

  useEffect(() => {
    loadSpaces().then(async first => {
      if (first) await openSpace(first);
      if (initialPostId) await openPost(initialPostId);
    }).catch(fail);
  }, [api.token, courseId]);

  const createPost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!space) return;
    try {
      setBusy(true);
      await api.post(`/community/spaces/${space.id}/posts`, { title, body });
      setTitle(""); setBody(""); setComposing(false);
      await openSpace(space);
    } catch (err) { fail(err); } finally { setBusy(false); }
  };

  const addComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!postId) return;
    try {
      setBusy(true);
      await api.post(`/community/posts/${postId}/comments`, { body: comment });
      setComment("");
      await openPost(postId);
    } catch (err) { fail(err); } finally { setBusy(false); }
  };

  const react = async (targetType: "post" | "comment", targetId: string, reaction: string) => {
    try {
      await api.post("/community/reactions", { target_type: targetType, target_id: targetId, reaction });
      if (postId) await openPost(postId); else if (space) await openSpace(space);
    } catch (err) { fail(err); }
  };

  const moderate = async (changes: Record<string, boolean>) => {
    if (!post) return;
    try {
      await api.post(`/community/posts/${post.id}/moderate`, changes);
      await openPost(post.id);
    } catch (err) { fail(err); }
  };

  const moderateComment = async (id: string, hidden: boolean) => {
    try {
      await api.post(`/community/comments/${id}/moderate`, { hidden });
      if (postId) await openPost(postId);
    } catch (err) { fail(err); }
  };

  const remove = async (kind: "posts" | "comments", id: string) => {
    if (!window.confirm(kind === "posts" ? "ลบโพสต์นี้?" : "ลบความคิดเห็นนี้?")) return;
    try {
      await api.request(`/community/${kind}/${id}`, { method: "DELETE" });
      if (kind === "posts") { setPostId(null); setPost(null); if (space) await openSpace(space); }
      else if (postId) await openPost(postId);
    } catch (err) { fail(err); }
  };

  const toggleFollow = async (targetType: "space" | "post", targetId: string, follow: boolean) => {
    try {
      await api.post("/community/follow", { target_type: targetType, target_id: targetId, follow });
      if (targetType === "space" && space) await openSpace(space); else if (postId) await openPost(postId);
    } catch (err) { fail(err); }
  };

  const submitReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reporting) return;
    try {
      const res = await api.post<{ message: string }>("/community/reports", { target_type: reporting.type, target_id: reporting.id, reason });
      setNotice(res.message);
      setReporting(null);
      setReason("");
    } catch (err) { fail(err); }
  };

  const createSpace = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/community/spaces", spaceForm);
      setCreatingSpace(false);
      setSpaceForm({ name: "", description: "", posting: "everyone" });
      await loadSpaces();
    } catch (err) { fail(err); }
  };

  const reactionBar = (targetType: "post" | "comment", id: string, mine: string | null, count: number) => {
    const set = new Set((mine || "").split(",").filter(Boolean));
    return (
      <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
        {REACTIONS.map(r => (
          <button key={r.key} type="button" onClick={() => react(targetType, id, r.key)} aria-pressed={set.has(r.key)} title={r.label}
            className={set.has(r.key) ? "tech-button-primary" : "tech-button-outline"} style={pill}>{r.icon}{r.label}</button>
        ))}
        {count > 0 && <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{count} รีแอกชัน</span>}
      </div>
    );
  };

  const authorLine = (name: string | null, at: string) => (
    <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{name ?? "ผู้ใช้ที่ลบแล้ว"} • {formatDateTime(at)}</span>
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: courseId ? "1fr" : "minmax(200px, 260px) 1fr", gap: "20px", alignItems: "start" }}>
      {!courseId && (
        <aside className="glass-card" style={{ padding: "16px" }} aria-label="ห้องชุมชน">
          <h2 style={{ fontSize: "16px", display: "flex", gap: "8px", alignItems: "center", marginBottom: "10px" }}><Users size={16} />ชุมชน</h2>
          {spaces.map(s => (
            <button key={s.id} type="button" onClick={() => openSpace(s)} aria-current={space?.id === s.id}
              style={{ display: "block", width: "100%", textAlign: "left", border: "none", borderRadius: "8px", padding: "8px 10px", marginBottom: "4px", cursor: "pointer",
                background: space?.id === s.id ? "var(--primary-glow)" : "transparent" }}>
              <div style={{ fontWeight: 600, fontSize: "14px" }}>{s.name}</div>
              <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{s.course_id ? `คอร์ส: ${s.course_title ?? ""}` : "ห้องรวม"} • {s.post_count ?? 0} โพสต์</div>
            </button>
          ))}
          {canCreate && (
            <button type="button" className="tech-button-outline" onClick={() => setCreatingSpace(true)} style={{ ...pill, marginTop: "8px" }}><Plus size={12} />สร้างห้อง</button>
          )}
        </aside>
      )}

      <main className="glass-card" style={{ padding: "20px", minWidth: 0 }}>
        <ErrorBox message={error} />
        {notice && <div role="status" style={{ color: "var(--accent)", fontSize: "13px", marginBottom: "10px" }}>{notice}</div>}
        {postId && post ? (
          <article>
            <button type="button" onClick={() => { setPostId(null); setPost(null); if (space) openSpace(space); }} className="tech-button-outline" style={{ ...pill, marginBottom: "12px" }}>
              <ArrowLeft size={12} />กลับไปห้อง
            </button>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              {post.pinned ? <Pin size={14} color="var(--warning)" aria-label="ปักหมุด" /> : null}
              {post.locked ? <Lock size={14} aria-label="ล็อก" /> : null}
              {post.hidden ? <span style={{ fontSize: "11px", color: "var(--danger)" }}>(ซ่อนอยู่)</span> : null}
              <h2 style={{ fontSize: "20px", margin: 0, flex: 1 }}>{post.title}</h2>
            </div>
            {authorLine(post.author_name, post.created_at)}
            <SafeHtml html={post.body_html} style={{ margin: "14px 0", fontSize: "14px" }} />
            {reactionBar("post", post.id, post.my_reactions, post.reaction_count)}
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "10px" }}>
              <button type="button" className="tech-button-outline" style={pill} onClick={() => toggleFollow("post", post.id, !post.following)}>
                {post.following ? <><BellOff size={12} />เลิกติดตาม</> : <><Bell size={12} />ติดตาม</>}
              </button>
              {post.author_id !== api.user?.id && <button type="button" className="tech-button-outline" style={pill} onClick={() => setReporting({ type: "post", id: post.id })}><Flag size={12} />รายงาน</button>}
              {(post.author_id === api.user?.id || postRights.can_moderate) && <button type="button" className="tech-button-outline" style={{ ...pill, color: "var(--danger)" }} onClick={() => remove("posts", post.id)}><Trash2 size={12} />ลบ</button>}
              {postRights.can_moderate && (
                <>
                  <button type="button" className="tech-button-outline" style={pill} onClick={() => moderate({ pinned: !post.pinned })}><Pin size={12} />{post.pinned ? "เลิกปักหมุด" : "ปักหมุด"}</button>
                  <button type="button" className="tech-button-outline" style={pill} onClick={() => moderate({ locked: !post.locked })}><Lock size={12} />{post.locked ? "ปลดล็อก" : "ล็อก"}</button>
                  <button type="button" className="tech-button-outline" style={pill} onClick={() => moderate({ hidden: !post.hidden })}>{post.hidden ? <><Eye size={12} />แสดง</> : <><EyeOff size={12} />ซ่อน</>}</button>
                </>
              )}
            </div>

            <h3 style={{ fontSize: "15px", marginTop: "24px", display: "flex", gap: "6px", alignItems: "center" }}><MessageCircle size={15} />ความคิดเห็น ({comments.filter(c => !c.hidden).length})</h3>
            {comments.length === 0 && <Empty text="ยังไม่มีความคิดเห็น" />}
            {comments.map(cm => (
              <div key={cm.id} style={{ borderTop: "1px solid rgba(0,0,0,0.05)", padding: "12px 0", opacity: cm.hidden ? 0.55 : 1 }}>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <strong style={{ fontSize: "13px" }}>{cm.author_name ?? "ผู้ใช้ที่ลบแล้ว"}</strong>
                  <span style={{ fontSize: "11px", color: "var(--text-muted)", flex: 1 }}>{formatDateTime(cm.created_at)}{cm.hidden ? " • ซ่อนอยู่" : ""}</span>
                  {cm.author_id !== api.user?.id && <button type="button" onClick={() => setReporting({ type: "comment", id: cm.id })} aria-label="รายงานความคิดเห็น" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}><Flag size={12} /></button>}
                  {postRights.can_moderate && <button type="button" onClick={() => moderateComment(cm.id, !cm.hidden)} aria-label={cm.hidden ? "แสดงความคิดเห็น" : "ซ่อนความคิดเห็น"} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}>{cm.hidden ? <Eye size={12} /> : <EyeOff size={12} />}</button>}
                  {(cm.author_id === api.user?.id || postRights.can_moderate) && <button type="button" onClick={() => remove("comments", cm.id)} aria-label="ลบความคิดเห็น" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--danger)" }}><Trash2 size={12} /></button>}
                </div>
                <SafeHtml html={cm.body_html} style={{ fontSize: "14px", margin: "4px 0 6px" }} />
                {reactionBar("comment", cm.id, cm.my_reactions, cm.reaction_count)}
              </div>
            ))}
            {(!post.locked || postRights.can_moderate) ? (
              <form onSubmit={addComment} style={{ marginTop: "14px", display: "grid", gap: "8px" }}>
                <RichTextEditor value={comment} onChange={setComment} rows={3} label="ความคิดเห็น" placeholder="แสดงความคิดเห็น…" onUploadImage={f => uploadCommunityImage(f, api.token)} />
                <div><button type="submit" className="tech-button-primary" disabled={busy || !comment.trim()} style={{ padding: "6px 16px" }}>ส่งความคิดเห็น</button></div>
              </form>
            ) : <p style={{ fontSize: "13px", color: "var(--text-muted)", marginTop: "12px" }}>โพสต์นี้ปิดการแสดงความคิดเห็นแล้ว</p>}
          </article>
        ) : space ? (
          <>
            <div style={{ display: "flex", gap: "10px", alignItems: "flex-start", flexWrap: "wrap", marginBottom: "14px" }}>
              <div style={{ flex: 1, minWidth: "200px" }}>
                <h2 style={{ fontSize: "18px", margin: 0 }}>{space.name}</h2>
                {space.description && <p style={{ fontSize: "13px", color: "var(--text-secondary)", margin: "4px 0 0" }}>{space.description}</p>}
              </div>
              <button type="button" className="tech-button-outline" style={pill} onClick={() => toggleFollow("space", space.id, !space.following)}>
                {space.following ? <><BellOff size={12} />เลิกติดตามห้อง</> : <><Bell size={12} />แจ้งเตือนโพสต์ใหม่</>}
              </button>
              {space.can_post && !composing && <button type="button" className="tech-button-primary" style={pill} onClick={() => setComposing(true)}><Plus size={12} />โพสต์ใหม่</button>}
            </div>
            {composing && (
              <form onSubmit={createPost} style={{ display: "grid", gap: "10px", marginBottom: "18px" }}>
                <input className="form-input" aria-label="หัวข้อโพสต์" placeholder="หัวข้อ" maxLength={200} value={title} onChange={e => setTitle(e.target.value)} required />
                <RichTextEditor value={body} onChange={setBody} rows={6} placeholder="เขียนโพสต์ (รองรับ Markdown และรูปภาพ)" onUploadImage={f => uploadCommunityImage(f, api.token)} />
                <div style={{ display: "flex", gap: "8px" }}>
                  <button type="submit" className="tech-button-primary" disabled={busy || !title.trim() || !body.trim()} style={{ padding: "6px 16px" }}>{busy ? "กำลังโพสต์…" : "โพสต์"}</button>
                  <button type="button" className="tech-button-outline" onClick={() => setComposing(false)} style={{ padding: "6px 16px" }}>ยกเลิก</button>
                </div>
              </form>
            )}
            {posts.length === 0 ? <Empty text="ยังไม่มีโพสต์ในห้องนี้ เริ่มบทสนทนาแรกได้เลย" /> : posts.map(p => (
              <button key={p.id} type="button" onClick={() => openPost(p.id)}
                style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", borderTop: "1px solid rgba(0,0,0,0.05)", padding: "12px 4px", cursor: "pointer", opacity: p.hidden ? 0.55 : 1 }}>
                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                  {p.pinned ? <Pin size={13} color="var(--warning)" aria-label="ปักหมุด" /> : null}
                  {p.locked ? <Lock size={13} aria-label="ล็อก" /> : null}
                  <strong style={{ fontSize: "15px", color: "var(--text-primary)" }}>{p.title}</strong>
                  {p.hidden ? <span style={{ fontSize: "11px", color: "var(--danger)" }}>(ซ่อนอยู่)</span> : null}
                </div>
                {authorLine(p.author_name, p.created_at)}
                <span style={{ fontSize: "12px", color: "var(--text-muted)", marginLeft: "10px" }}>💬 {p.comment_count} • 👍 {p.reaction_count}</span>
              </button>
            ))}
          </>
        ) : <Empty text="ยังไม่มีห้องที่คุณเข้าถึงได้" />}
      </main>

      {reporting && (
        <Modal title="รายงานเนื้อหาไม่เหมาะสม" onClose={() => setReporting(null)} width={480}>
          <form onSubmit={submitReport} style={{ display: "grid", gap: "12px" }}>
            <Field label="เหตุผล" hint="ทีมงานจะตรวจสอบและดำเนินการ ผู้โพสต์จะไม่เห็นชื่อผู้รายงาน">
              <textarea className="form-input" rows={4} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} required />
            </Field>
            <div><button type="submit" className="tech-button-primary" disabled={!reason.trim()} style={{ padding: "6px 16px" }}>ส่งรายงาน</button></div>
          </form>
        </Modal>
      )}
      {creatingSpace && (
        <Modal title="สร้างห้องชุมชน" onClose={() => setCreatingSpace(false)} width={480}>
          <form onSubmit={createSpace} style={{ display: "grid", gap: "12px" }}>
            <Field label="ชื่อห้อง"><input className="form-input" maxLength={120} value={spaceForm.name} onChange={e => setSpaceForm({ ...spaceForm, name: e.target.value })} required /></Field>
            <Field label="คำอธิบาย"><input className="form-input" maxLength={500} value={spaceForm.description} onChange={e => setSpaceForm({ ...spaceForm, description: e.target.value })} /></Field>
            <Field label="ใครโพสต์ได้">
              <select className="form-input" value={spaceForm.posting} onChange={e => setSpaceForm({ ...spaceForm, posting: e.target.value })}>
                <option value="everyone">ทุกคนที่เข้าห้องได้</option>
                <option value="staff">เฉพาะทีมงาน (ผู้เรียนแสดงความคิดเห็นได้)</option>
              </select>
            </Field>
            <div><button type="submit" className="tech-button-primary" style={{ padding: "6px 16px" }}>สร้างห้อง</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
};

export default CommunityPage;
