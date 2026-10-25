import React, { useEffect, useMemo, useState } from "react";
import { UserPlus, Search, ShieldCheck, Users, KeyRound, LogOut, RotateCcw, Save, Mail, Upload, Filter, ListChecks, Download } from "lucide-react";
import { can, useApi } from "../hooks/useApi";
import { Chip, Modal, Field, ErrorBox, Empty, grid2, tableStyle, thStyle, tdStyle, formatDateTime } from "../components/site-admin/ui";
import { UserDetailPage } from "../components/people/UserDetailPage";
import { ImportUsersDialog } from "../components/people/ImportUsersDialog";
import { SegmentsPanel } from "../components/people/SegmentsPanel";
import { ProfileFieldsPanel } from "../components/people/ProfileFieldsPanel";
import { PeopleMeta, postForDownload } from "../components/people/shared";

type Role = "admin" | "coordinator" | "instructor" | "partner" | "student";
type Api = ReturnType<typeof useApi>;

interface Account {
  id: string; name: string; email: string; role: Role; roles: Role[]; partner_id: string | null;
  company_name: string | null; partner_type: string | null; status: "active" | "suspended";
  created_at: string; last_login_at: string | null;
  email_verified_at?: string | null;
  /** Expiry of the newest unused invitation link; set while the person has not chosen a password yet. */
  invite_expires_at?: string | null;
  tags?: string[];
}
interface Partner { id: string; company_name: string; partner_type: "company" | "university"; total_seats: number; allocated_seats: number }
interface Meta { roles: Array<{ key: Role; label: string; description: string }>; partners: Partner[]; canManage: boolean; actorRole: Role; actorRoles?: Role[] }

export const ROLE_TONE: Record<Role, { color: string; bg: string }> = {
  admin: { color: "#b42318", bg: "rgba(239,68,68,0.1)" },
  coordinator: { color: "var(--accent)", bg: "var(--accent-glow)" },
  instructor: { color: "#9a5b00", bg: "rgba(245,158,11,0.14)" },
  partner: { color: "var(--secondary)", bg: "var(--secondary-glow)" },
  student: { color: "var(--primary)", bg: "var(--primary-glow)" }
};

const ROLE_ORDER: Role[] = ["admin", "coordinator", "instructor", "partner", "student"];
const STAFF: Role[] = ["admin", "coordinator", "instructor"];

type Tab = "users" | "segments" | "fields" | "roles";

/** Users (with tags, segments, CSV import, bulk actions and the user 360 page), custom profile fields and the role permission matrix. */
export const UsersPage: React.FC = () => {
  const api = useApi();
  const [tab, setTab] = useState<Tab>("users");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [peopleMeta, setPeopleMeta] = useState<PeopleMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [segmentFilter, setSegmentFilter] = useState("");
  const loadPeopleMeta = () => { if (can(api.user, "users.view")) api.get<PeopleMeta>("/admin/people-meta").then(setPeopleMeta).catch(() => undefined); };
  useEffect(() => { api.get<Meta>("/admin/accounts/meta").then(setMeta).catch(err => setError(err.message)); loadPeopleMeta(); }, [api.token]);
  const tabButton = (key: Tab, icon: React.ReactNode, label: string) => (
    <button role="tab" aria-selected={tab === key} onClick={() => { setTab(key); setDetailId(null); }} className={tab === key ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "8px 14px", fontSize: 13 }}>{icon}{label}</button>
  );

  if (detailId) return <UserDetailPage userId={detailId} onBack={() => { setDetailId(null); loadPeopleMeta(); }} />;

  return (
    <div>
      <div className="header-row">
        <div>
          <h1 className="header-title">ผู้ใช้และสิทธิ์</h1>
          <p className="header-desc">เพิ่มผู้ใช้ กำหนดบทบาท (1 บัญชีมีได้หลายบทบาท) ระงับบัญชี และกำหนดว่าแต่ละบทบาทใช้ฟีเจอร์ใดได้บ้าง</p>
        </div>
      </div>
      <nav role="tablist" style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
        {can(api.user, "users.view") && tabButton("users", <Users size={16} />, "ผู้ใช้")}
        {can(api.user, "users.view") && tabButton("segments", <Filter size={16} />, "กลุ่มผู้ใช้")}
        {can(api.user, "users.view", "users.import") && tabButton("fields", <ListChecks size={16} />, "ฟิลด์โปรไฟล์")}
        {tabButton("roles", <ShieldCheck size={16} />, "บทบาทและสิทธิ์")}
      </nav>
      <ErrorBox message={error} />
      {meta && tab === "users" && can(api.user, "users.view") && (
        <UsersTab api={api} meta={meta} people={peopleMeta} onOpen={setDetailId} onPeopleChanged={loadPeopleMeta}
          segmentFilter={segmentFilter} setSegmentFilter={setSegmentFilter} />
      )}
      {tab === "segments" && can(api.user, "users.view") && (
        <SegmentsPanel meta={peopleMeta} partners={meta?.partners ?? []} canEdit={can(api.user, "users.import", "users.manage")}
          onOpenSegment={id => { setSegmentFilter(id); setTab("users"); loadPeopleMeta(); }} />
      )}
      {tab === "fields" && can(api.user, "users.view", "users.import") && <ProfileFieldsPanel canEdit={can(api.user, "users.import")} />}
      {(tab === "roles" || (!can(api.user, "users.view") && tab !== "fields")) && <RolesTab api={api} />}
    </div>
  );
};

// ==========================================
// Users list
// ==========================================

const PAGE = 25;

const UsersTab: React.FC<{
  api: Api; meta: Meta; people: PeopleMeta | null; onOpen: (id: string) => void; onPeopleChanged: () => void;
  segmentFilter: string; setSegmentFilter: (id: string) => void;
}> = ({ api, meta, people, onOpen, onPeopleChanged, segmentFilter, setSegmentFilter }) => {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ users: Account[]; total: number; roleCounts: Record<string, number> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const roleLabel = (key: Role) => meta.roles.find(r => r.key === key)?.label ?? key;

  useEffect(() => { const t = window.setTimeout(() => { setSearch(query.trim()); setPage(0); }, 300); return () => window.clearTimeout(t); }, [query]);
  const load = () => {
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
    if (search) params.set("q", search);
    if (role) params.set("role", role);
    if (status) params.set("status", status);
    if (tag) params.set("tag", tag);
    if (segmentFilter) params.set("segment_id", segmentFilter);
    api.get<typeof data>(`/admin/accounts?${params}`).then(d => { setData(d); setError(null); }).catch(err => setError(err.message));
  };
  useEffect(load, [search, role, status, tag, segmentFilter, page, api.token]);
  const canImport = can(api.user, "users.import");
  const canTag = meta.canManage || canImport;
  const pageIds = data?.users.map(u => u.id) ?? [];
  const allOnPage = pageIds.length > 0 && pageIds.every(id => selected.has(id));
  const toggle = (id: string) => setSelected(s => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const togglePage = () => setSelected(s => { const next = new Set(s); pageIds.forEach(id => allOnPage ? next.delete(id) : next.add(id)); return next; });
  const pages = data ? Math.ceil(data.total / PAGE) : 0;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 20 }}>
        {meta.roles.map(r => (
          <button key={r.key} onClick={() => { setRole(role === r.key ? "" : r.key); setPage(0); }} className="glass-card"
            style={{ padding: "14px 16px", textAlign: "left", cursor: "pointer", border: role === r.key ? `2px solid ${ROLE_TONE[r.key].color}` : "1px solid rgba(0,0,0,0.06)" }}>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{r.label}</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: ROLE_TONE[r.key].color }}>{data?.roleCounts[r.key] ?? "–"}</div>
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 260px", maxWidth: 420, padding: "0 12px", border: "1px solid rgba(15,23,42,0.12)", borderRadius: 12, background: "#fff" }}>
          <Search size={16} color="var(--text-secondary)" />
          <span className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>ค้นหาชื่อหรืออีเมล</span>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="ค้นหาชื่อหรืออีเมล" style={{ flex: 1, minHeight: 42, border: 0, outline: "none", background: "transparent", font: "inherit" }} />
        </label>
        <select className="form-input" aria-label="กรองตามบทบาท" value={role} onChange={e => { setRole(e.target.value); setPage(0); }} style={{ width: "auto", background: "#fff", borderColor: "rgba(15,23,42,0.12)" }}>
          <option value="">ทุกบทบาท</option>
          {meta.roles.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <select className="form-input" aria-label="กรองตามสถานะ" value={status} onChange={e => { setStatus(e.target.value); setPage(0); }} style={{ width: "auto", background: "#fff", borderColor: "rgba(15,23,42,0.12)" }}>
          <option value="">ทุกสถานะ</option><option value="active">ใช้งานอยู่</option><option value="suspended">ถูกระงับ</option>
        </select>
        {people && people.tags.length > 0 && (
          <select className="form-input" aria-label="กรองตามแท็ก" value={tag} onChange={e => { setTag(e.target.value); setPage(0); }} style={{ width: "auto", background: "#fff", borderColor: "rgba(15,23,42,0.12)" }}>
            <option value="">ทุกแท็ก</option>
            {people.tags.map(t => <option key={t.tag} value={t.tag}>{t.tag} ({t.users})</option>)}
          </select>
        )}
        {people && people.segments.length > 0 && (
          <select className="form-input" aria-label="กรองตามกลุ่มผู้ใช้" value={segmentFilter} onChange={e => { setSegmentFilter(e.target.value); setPage(0); }} style={{ width: "auto", background: "#fff", borderColor: "rgba(15,23,42,0.12)" }}>
            <option value="">ทุกกลุ่ม</option>
            {people.segments.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {canImport && <button className="tech-button-outline" onClick={() => setImporting(true)}><Upload size={16} />นำเข้า CSV</button>}
          {meta.canManage && <button className="tech-button-primary" onClick={() => setEditing("new")}><UserPlus size={16} />เพิ่มผู้ใช้</button>}
        </div>
      </div>
      {selected.size > 0 && (
        <BulkBar api={api} ids={Array.from(selected)} people={people} canManage={meta.canManage} canTag={canTag}
          onClear={() => setSelected(new Set())} onDone={message => { setNotice(message); load(); onPeopleChanged(); }} onError={setError} />
      )}

      <ErrorBox message={error} />
      {notice && <div role="status" style={{ padding: "10px 14px", borderRadius: 10, background: "var(--accent-glow)", color: "var(--accent)", marginBottom: 14, fontSize: 14 }}>{notice}</div>}
      <div className="glass-card" style={{ padding: 8, overflowX: "auto" }}>
        {!data ? <Empty text="กำลังโหลด…" /> : data.users.length === 0 ? <Empty text="ไม่พบผู้ใช้ที่ตรงกับเงื่อนไข" /> : (
          <table style={tableStyle}>
            <thead><tr><th style={{ ...thStyle, width: 32 }}><input type="checkbox" aria-label="เลือกทุกคนในหน้านี้" checked={allOnPage} onChange={togglePage} /></th><th style={thStyle}>ผู้ใช้</th><th style={thStyle}>บทบาท</th><th style={thStyle}>องค์กร</th><th style={thStyle}>สถานะ</th><th style={thStyle}>เข้าสู่ระบบล่าสุด</th><th style={thStyle}></th></tr></thead>
            <tbody>
              {data.users.map(u => (
                <tr key={u.id} style={{ opacity: u.status === "suspended" ? 0.6 : 1, background: selected.has(u.id) ? "rgba(59,130,246,0.05)" : undefined }}>
                  <td style={tdStyle}><input type="checkbox" aria-label={`เลือก ${u.name}`} checked={selected.has(u.id)} onChange={() => toggle(u.id)} /></td>
                  <td style={tdStyle}><button onClick={() => onOpen(u.id)} title="ดูรายละเอียดผู้ใช้" style={{ background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit", color: "inherit", textAlign: "left" }}><strong style={{ textDecoration: "underline", textDecorationColor: "rgba(15,23,42,0.2)" }}>{u.name}</strong></button>{u.id === api.user?.id && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}> (คุณ)</span>}<div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{u.email}</div>
                    {u.invite_expires_at && !u.last_login_at
                      ? <div style={{ fontSize: 12, color: "#9a5b00" }}>รอตั้งรหัสผ่านจากคำเชิญ</div>
                      : u.email_verified_at === null && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>ยังไม่ยืนยันอีเมล</div>}
                    {u.tags && u.tags.length > 0 && <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>{u.tags.map(t => <span key={t} style={{ fontSize: 11, padding: "1px 8px", borderRadius: 99, background: "var(--secondary-glow)", color: "var(--secondary)" }}>{t}</span>)}</div>}</td>
                  <td style={tdStyle}><div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{(u.roles?.length ? u.roles : [u.role]).map(r => <Chip key={r} label={roleLabel(r)} {...ROLE_TONE[r]} />)}</div></td>
                  <td style={tdStyle}>{u.company_name || "-"}</td>
                  <td style={tdStyle}>{u.status === "active" ? <Chip label="ใช้งานอยู่" color="var(--accent)" bg="var(--accent-glow)" /> : <Chip label="ถูกระงับ" color="#b42318" bg="rgba(239,68,68,0.1)" />}</td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap", fontSize: 13 }}>{u.last_login_at ? formatDateTime(u.last_login_at) : "ยังไม่เคย"}</td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    <button className="tech-button-outline" style={{ padding: "4px 12px", fontSize: 12, borderWidth: 1 }} onClick={() => onOpen(u.id)}>ดูข้อมูล</button>{" "}
                    {meta.canManage && <button className="tech-button-outline" style={{ padding: "4px 12px", fontSize: 12, borderWidth: 1 }} onClick={() => setEditing(u)}>จัดการ</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {pages > 1 && (
        <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 14, alignItems: "center" }}>
          <button className="tech-button-outline" disabled={page === 0} onClick={() => setPage(page - 1)} style={{ padding: "6px 14px" }}>ก่อนหน้า</button>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>หน้า {page + 1} / {pages} · {data?.total} คน</span>
          <button className="tech-button-outline" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} style={{ padding: "6px 14px" }}>ถัดไป</button>
        </div>
      )}
      {importing && <ImportUsersDialog fields={people?.fields ?? []} onClose={() => setImporting(false)} onDone={() => { load(); onPeopleChanged(); }} />}
      {editing && <AccountDialog api={api} meta={meta} account={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={message => { setEditing(null); setNotice(message ?? null); load(); }} />}
    </div>
  );
};

// ==========================================
// Bulk actions on the selection
// ==========================================

const BulkBar: React.FC<{
  api: Api; ids: string[]; people: PeopleMeta | null; canManage: boolean; canTag: boolean;
  onClear: () => void; onDone: (message: string) => void; onError: (message: string | null) => void;
}> = ({ api, ids, people, canManage, canTag, onClear, onDone, onError }) => {
  const [tag, setTag] = useState("");
  const [courseId, setCourseId] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (body: Record<string, unknown>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      setBusy(true);
      onError(null);
      const res = await api.post<{ message: string; failed: Array<{ user_id: string; error: string }> }>("/admin/people/bulk", { ...body, user_ids: ids });
      onDone(res.failed.length ? `${res.message}: ${Array.from(new Set(res.failed.map(f => f.error))).join(" · ")}` : res.message);
    } catch (err: any) { onError(err.message); } finally { setBusy(false); }
  };
  const exportSelected = async () => {
    try { setBusy(true); await postForDownload("/admin/people/export", api.token, { user_ids: ids }, `netprime-users-${new Date().toISOString().slice(0, 10)}.csv`); }
    catch (err: any) { onError(err.message); } finally { setBusy(false); }
  };
  const small: React.CSSProperties = { padding: "6px 12px", fontSize: 13 };
  return (
    <div className="glass-card" role="region" aria-label="จัดการผู้ใช้ที่เลือก" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "10px 14px", marginBottom: 14 }}>
      <strong style={{ fontSize: 14 }}>เลือก {ids.length} คน</strong>
      <button className="tech-button-outline" style={small} onClick={onClear}>ล้างการเลือก</button>
      {canTag && <>
        <input className="form-input" list="bulk-tags" placeholder="แท็ก" maxLength={50} value={tag} onChange={e => setTag(e.target.value)} style={{ width: 160, minHeight: 36 }} />
        <datalist id="bulk-tags">{people?.tags.map(t => <option key={t.tag} value={t.tag} />)}</datalist>
        <button className="tech-button-outline" style={small} disabled={busy || !tag.trim()} onClick={() => run({ action: "add_tag", tag })}>เพิ่มแท็ก</button>
        <button className="tech-button-outline" style={small} disabled={busy || !tag.trim()} onClick={() => run({ action: "remove_tag", tag })}>ลบแท็ก</button>
      </>}
      {canManage && <>
        <select className="form-input" aria-label="คอร์สที่จะลงทะเบียนให้" value={courseId} onChange={e => setCourseId(e.target.value)} style={{ width: 220, minHeight: 36 }}>
          <option value="">— คอร์ส —</option>
          {people?.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
        <button className="tech-button-outline" style={small} disabled={busy || !courseId} onClick={() => run({ action: "enroll", course_id: courseId }, `ลงทะเบียนเรียนให้ ${ids.length} คน?`)}>ลงทะเบียนเรียน</button>
        <button className="tech-button-outline" style={small} disabled={busy} onClick={() => run({ action: "suspend" }, `ระงับบัญชี ${ids.length} คน?`)}>ระงับบัญชี</button>
        <button className="tech-button-outline" style={small} disabled={busy} onClick={() => run({ action: "activate" })}>เปิดใช้งาน</button>
      </>}
      <button className="tech-button-outline" style={small} disabled={busy} onClick={exportSelected}><Download size={14} />ส่งออก CSV</button>
    </div>
  );
};

// ==========================================
// Create / edit account
// ==========================================

const AccountDialog: React.FC<{ api: Api; meta: Meta; account: Account | null; onClose: () => void; onSaved: (message?: string) => void }> = ({ api, meta, account, onClose, onSaved }) => {
  const isNew = !account;
  const self = account?.id === api.user?.id;
  const [form, setForm] = useState({
    name: account?.name ?? "", email: account?.email ?? "", password: "",
    roles: (account?.roles?.length ? account.roles : [account?.role ?? "student"]) as Role[],
    partner_id: account?.partner_id ?? "", status: account?.status ?? "active",
    // New accounts: email a set-password link (default) or type an initial password.
    setup: "invite" as "invite" | "password"
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const actorIsAdmin = (meta.actorRoles ?? [meta.actorRole]).includes("admin");
  const roles = meta.roles.filter(r => r.key !== "admin" || actorIsAdmin);
  // Admins may add roles to themselves but keep their admin role; nobody else edits their own roles.
  const rolesLocked = self && !actorIsAdmin;
  const lockedRole = (key: Role) => rolesLocked || (self && key === "admin");
  const toggleRole = (key: Role) => setForm(f => ({
    ...f, roles: f.roles.includes(key) ? f.roles.filter(r => r !== key) : ROLE_ORDER.filter(r => r === key || f.roles.includes(r))
  }));
  const needsOrg = form.roles.includes("partner");
  const allowsOrg = form.roles.length > 0 && form.roles.every(r => r === "partner" || r === "student");
  const original = account ? (account.roles?.length ? account.roles : [account.role]) : [];
  const changingRole = !isNew && (original.length !== form.roles.length || original.some(r => !form.roles.includes(r)));
  const studyingStaff = form.roles.includes("student") && form.roles.some(r => STAFF.includes(r));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setBusy(true);
      setError(null);
      if (!form.roles.length) throw new Error("เลือกบทบาทอย่างน้อย 1 บทบาท");
      const partner_id = allowsOrg && form.partner_id ? form.partner_id : null;
      if (isNew) {
        const credentials = form.setup === "invite" ? { invite: true } : { password: form.password };
        await api.post("/admin/accounts", { name: form.name, email: form.email, ...credentials, roles: form.roles, partner_id });
        onSaved(form.setup === "invite" ? `สร้างบัญชีและส่งลิงก์เชิญไปที่ ${form.email.trim()} แล้ว (ใช้ได้ 7 วัน)` : undefined);
      } else {
        await api.patch(`/admin/accounts/${account!.id}`, { name: form.name, ...(changingRole ? { roles: form.roles } : {}), partner_id, status: form.status });
        onSaved();
      }
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  const action = async (path: string, body: unknown, done: string) => {
    try { setBusy(true); setError(null); await api.post(path, body); setNotice(done); setNewPassword(""); }
    catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Modal title={isNew ? "เพิ่มผู้ใช้" : `จัดการ ${account!.name}`} onClose={onClose} width={640}>
      <ErrorBox message={error} />
      {notice && <div role="status" style={{ padding: "10px 14px", borderRadius: 10, background: "var(--accent-glow)", color: "var(--accent)", marginBottom: 14, fontSize: 14 }}>{notice}</div>}
      <form onSubmit={save} style={grid2}>
        <Field label="ชื่อ"><input className="form-input" required maxLength={120} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></Field>
        <Field label="อีเมล (ใช้เข้าสู่ระบบ)">{isNew
          ? <input className="form-input" type="email" required maxLength={254} value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
          : <input className="form-input" value={form.email} disabled />}</Field>
        <fieldset style={{ gridColumn: "1 / -1", border: 0, padding: 0, margin: 0 }}>
          <legend className="form-label" style={{ marginBottom: 8 }}>
            บทบาท <span style={{ fontWeight: 400, color: "var(--text-secondary)" }}>
              {rolesLocked ? "(แก้บทบาทของตัวเองไม่ได้)" : "· เลือกได้หลายบทบาท ได้สิทธิ์รวมของทุกบทบาท"}
            </span>
          </legend>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8 }}>
            {roles.map(r => {
              const on = form.roles.includes(r.key);
              const locked = lockedRole(r.key);
              return (
                <label key={r.key} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: 12, cursor: locked ? "default" : "pointer", opacity: locked && !on ? 0.6 : 1,
                  border: on ? `2px solid ${ROLE_TONE[r.key].color}` : "1px solid rgba(15,23,42,0.12)", background: on ? ROLE_TONE[r.key].bg : "#fff" }}>
                  <input type="checkbox" checked={on} disabled={locked} onChange={() => toggleRole(r.key)} style={{ marginTop: 3 }} />
                  <span><strong style={{ fontSize: 14 }}>{r.label}</strong><br /><span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{r.description}</span></span>
                </label>
              );
            })}
          </div>
          {form.roles.length === 0 && <p style={{ margin: "8px 0 0", fontSize: 13, color: "#b42318" }}>เลือกบทบาทอย่างน้อย 1 บทบาท</p>}
          {form.roles.length > 0 && !allowsOrg && form.roles.some(r => r === "partner" || r === "student") && (
            <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>บัญชีที่เป็นเจ้าหน้าที่หรือผู้สอนผูกกับองค์กรไม่ได้ ระบบจะบันทึกเป็นผู้เรียนรายบุคคล</p>
          )}
        </fieldset>
        {allowsOrg && (
          <Field label={needsOrg ? "องค์กร *" : "องค์กร (ถ้าเป็นพนักงานหรือนักศึกษาขององค์กร)"} span>
            <select className="form-input" required={needsOrg} value={form.partner_id} onChange={e => setForm(f => ({ ...f, partner_id: e.target.value }))}>
              <option value="">{needsOrg ? "เลือกองค์กร" : "— ผู้เรียนรายบุคคล —"}</option>
              {meta.partners.map(p => <option key={p.id} value={p.id}>{p.company_name} ({p.partner_type === "university" ? "มหาวิทยาลัย" : "บริษัท"} · ที่นั่ง {p.allocated_seats}/{p.total_seats})</option>)}
            </select>
          </Field>
        )}
        {isNew && (
          <fieldset style={{ gridColumn: "1 / -1", border: 0, padding: 0, margin: 0, display: "grid", gap: 8 }}>
            <legend className="form-label" style={{ marginBottom: 8 }}>การตั้งรหัสผ่าน</legend>
            {([["invite", "ส่งลิงก์เชิญทางอีเมล", "ผู้ใช้ตั้งรหัสผ่านเองจากลิงก์ (ใช้ได้ 7 วัน) และอีเมลถือว่ายืนยันแล้ว"],
               ["password", "ตั้งรหัสผ่านเอง", "กำหนดรหัสผ่านเริ่มต้น แล้วแจ้งผู้ใช้ทางช่องทางที่ปลอดภัย"]] as const).map(([key, label, hint]) => (
              <label key={key} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 14, cursor: "pointer" }}>
                <input type="radio" name="setup" checked={form.setup === key} onChange={() => setForm(f => ({ ...f, setup: key }))} style={{ marginTop: 3 }} />
                <span><strong>{label}</strong><br /><span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{hint}</span></span>
              </label>
            ))}
          </fieldset>
        )}
        {isNew && form.setup === "password" && (
          <Field label="รหัสผ่านเริ่มต้น" hint="อย่างน้อย 12 ตัวอักษร แจ้งผู้ใช้ทางช่องทางที่ปลอดภัย" span>
            <input className="form-input" type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
          </Field>
        )}
        {!isNew && !self && (
          <label style={{ gridColumn: "1 / -1", display: "flex", gap: 10, alignItems: "center", fontSize: 14 }}>
            <input type="checkbox" checked={form.status === "suspended"} onChange={e => setForm(f => ({ ...f, status: e.target.checked ? "suspended" : "active" }))} style={{ width: 18, height: 18 }} />
            ระงับบัญชี (เข้าสู่ระบบไม่ได้ และหลุดจากทุกอุปกรณ์ทันที)
          </label>
        )}
        {studyingStaff && (
          <p style={{ gridColumn: "1 / -1", margin: 0, fontSize: 13, color: "var(--text-secondary)", background: "rgba(15,23,42,0.04)", padding: "10px 12px", borderRadius: 10 }}>
            เจ้าหน้าที่ที่เรียนด้วยจะเห็นเมนู "การเรียนของฉัน" ลงเรียนและรับใบประกาศได้ แต่ไม่นับในรายชื่อผู้เรียนของผู้สอน และไม่ขึ้นตารางอันดับ
          </p>
        )}
        {changingRole && (
          <p style={{ gridColumn: "1 / -1", margin: 0, fontSize: 13, color: "#7a4b00", background: "#fff4dc", padding: "10px 12px", borderRadius: 10 }}>
            บทบาทใหม่มีผลทันทีในคำขอถัดไปของผู้ใช้ ข้อมูลเดิม เช่น คอร์สที่เคยสอนหรือประวัติการเรียน ยังอยู่ครบ
          </p>
        )}
        <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={busy}>{busy ? "กำลังบันทึก…" : isNew ? "สร้างบัญชี" : "บันทึก"}</button>
        </div>
      </form>

      {!isNew && !self && (
        <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid rgba(0,0,0,0.06)", display: "grid", gap: 12 }}>
          <strong style={{ fontSize: 14 }}>ความปลอดภัยของบัญชี</strong>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input className="form-input" type="password" placeholder="รหัสผ่านใหม่ (12 ตัวอักษรขึ้นไป)" autoComplete="new-password" minLength={12} value={newPassword} onChange={e => setNewPassword(e.target.value)} style={{ flex: "1 1 240px" }} />
            <button className="tech-button-outline" disabled={busy || newPassword.length < 12} onClick={() => action(`/admin/accounts/${account!.id}/password`, { password: newPassword }, "ตั้งรหัสผ่านใหม่แล้ว และให้ผู้ใช้ออกจากระบบทุกอุปกรณ์")}><KeyRound size={16} />ตั้งรหัสผ่านใหม่</button>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {account!.status === "active" && (
              <button className="tech-button-outline" disabled={busy} title="ส่งลิงก์ตั้งรหัสผ่านใหม่ทางอีเมล ลิงก์เดิมจะใช้ไม่ได้"
                onClick={() => action(`/admin/accounts/${account!.id}/invite`, {}, `ส่งคำเชิญไปที่ ${account!.email} อีกครั้งแล้ว (ใช้ได้ 7 วัน)`)}><Mail size={16} />ส่งคำเชิญอีกครั้ง</button>
            )}
            <button className="tech-button-outline" disabled={busy} onClick={() => action(`/admin/accounts/${account!.id}/sign-out`, {}, "ให้ผู้ใช้ออกจากระบบทุกอุปกรณ์แล้ว")}><LogOut size={16} />ออกจากระบบทุกอุปกรณ์</button>
          </div>
        </div>
      )}
    </Modal>
  );
};

// ==========================================
// Role permission matrix
// ==========================================

interface RolesData {
  roles: Array<{ key: Role; label: string; description: string; locked: boolean; permissions: string[] }>;
  permissions: Array<{ key: string; group: string; label: string; grantable: boolean }>;
  defaults: Record<string, string[]>;
  canEdit: boolean;
}

const RolesTab: React.FC<{ api: Api }> = ({ api }) => {
  const [data, setData] = useState<RolesData | null>(null);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const load = () => api.get<RolesData>("/admin/roles").then(d => {
    setData(d);
    setDraft(Object.fromEntries(d.roles.map(r => [r.key, r.permissions])));
  }).catch(err => setError(err.message));
  useEffect(() => { load(); }, [api.token]);

  const groups = useMemo(() => {
    const map = new Map<string, RolesData["permissions"]>();
    data?.permissions.forEach(p => map.set(p.group, [...(map.get(p.group) || []), p]));
    return Array.from(map.entries());
  }, [data]);
  if (!data) return <><ErrorBox message={error} /><Empty text="กำลังโหลด…" /></>;

  const editable = data.roles.filter(r => !r.locked);
  const dirty = (role: string) => JSON.stringify([...(draft[role] || [])].sort()) !== JSON.stringify([...(data.roles.find(r => r.key === role)?.permissions || [])].sort());
  const toggle = (role: string, perm: string) => {
    setSaved(null);
    setDraft(d => ({ ...d, [role]: d[role].includes(perm) ? d[role].filter(p => p !== perm) : [...d[role], perm] }));
  };
  const save = async (role: string) => {
    try {
      setError(null);
      await api.request(`/admin/roles/${role}`, { method: "PUT", body: JSON.stringify({ permissions: draft[role] }) });
      setSaved(`บันทึกสิทธิ์ของ "${data.roles.find(r => r.key === role)?.label}" แล้ว มีผลทันที`);
      await load();
      await api.refreshUser();
    } catch (err: any) { setError(err.message); }
  };

  return (
    <div>
      <p style={{ fontSize: 14, color: "var(--text-secondary)", marginTop: 0 }}>
        บทบาทกำหนดว่าผู้ใช้เห็นคอนโซลไหนและข้อมูลของใคร ส่วนตารางนี้กำหนดฟีเจอร์ที่บทบาทนั้นใช้ได้ ผู้ดูแลระบบมีสิทธิ์ทุกข้อเสมอ
        {!data.canEdit && " (คุณดูได้อย่างเดียว เฉพาะผู้ดูแลระบบที่แก้ไขได้)"}
      </p>
      <ErrorBox message={error} />
      {saved && <div role="status" style={{ padding: "10px 14px", borderRadius: 10, background: "var(--accent-glow)", color: "var(--accent)", marginBottom: 14, fontSize: 14 }}>{saved}</div>}
      <div className="glass-card" style={{ padding: 8, overflowX: "auto" }}>
        <table style={{ ...tableStyle, minWidth: 760 }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, width: "40%" }}>ฟีเจอร์</th>
              {data.roles.map(r => <th key={r.key} style={{ ...thStyle, textAlign: "center" }}><Chip label={r.label} {...ROLE_TONE[r.key]} /></th>)}
            </tr>
          </thead>
          <tbody>
            {groups.map(([group, perms]) => (
              <React.Fragment key={group}>
                <tr><td colSpan={data.roles.length + 1} style={{ ...tdStyle, background: "rgba(15,23,42,0.03)", fontWeight: 700, fontSize: 13 }}>{group}</td></tr>
                {perms.map(p => (
                  <tr key={p.key}>
                    <td style={tdStyle}>{p.label}{!p.grantable && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}> · เฉพาะผู้ดูแลระบบ</span>}</td>
                    {data.roles.map(r => {
                      const checked = r.locked || (draft[r.key] || []).includes(p.key);
                      const disabled = r.locked || !p.grantable || !data.canEdit;
                      return (
                        <td key={r.key} style={{ ...tdStyle, textAlign: "center" }}>
                          <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggle(r.key, p.key)}
                            aria-label={`${r.label}: ${p.label}`} style={{ width: 18, height: 18, cursor: disabled ? "not-allowed" : "pointer" }} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {data.canEdit && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
          {editable.map(r => (
            <div key={r.key} style={{ display: "flex", gap: 6 }}>
              <button className="tech-button-primary" disabled={!dirty(r.key)} onClick={() => save(r.key)} style={{ padding: "8px 14px", fontSize: 13 }}><Save size={14} />บันทึก{r.label}</button>
              <button className="tech-button-outline" title="คืนค่าเริ่มต้น" aria-label={`คืนค่าเริ่มต้นของ${r.label}`} onClick={() => { setSaved(null); setDraft(d => ({ ...d, [r.key]: data.defaults[r.key] || [] })); }} style={{ padding: "8px 10px" }}><RotateCcw size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
