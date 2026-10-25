import React, { useState, useEffect } from "react";
import { useApi, hasRole } from "../hooks/useApi";
import { MetricsCard } from "../components/MetricsCard";
import { Modal, Field, ErrorBox, Empty, SeatBar, Chip, grid2, tableStyle, thStyle, tdStyle, formatDate } from "../components/site-admin/ui";
import {
  Building2,
  PlusCircle,
  Pencil,
  ArrowRightLeft,
  Users,
  CheckCircle,
  BarChart3
} from "lucide-react";

type PartnerType = "company" | "university";

interface Organization {
  id: string;
  company_name: string;
  tax_id: string | null;
  partner_type: PartnerType;
  total_seats: number;
  allocated_seats: number;
  members: number;
  sponsored_courses: number;
  created_at: string;
}

interface AdminAnalytics {
  totalCorporates: number;
  totalUsers: number;
  totalCourses: number;
  totalEnrollments: number;
}

interface OrgMember {
  id: string;
  email: string;
  name: string;
  role: string;
  roles: string[];
}

const PARTNER_TYPE: Record<PartnerType, { label: string; color: string; bg: string }> = {
  company: { label: "บริษัท", color: "var(--secondary)", bg: "var(--secondary-glow)" },
  university: { label: "มหาวิทยาลัย", color: "var(--accent)", bg: "var(--accent-glow)" }
};

interface OrgForm {
  id: string;
  company_name: string;
  partner_type: PartnerType;
  total_seats: string;
  tax_id: string;
}

const emptyForm: OrgForm = { id: "", company_name: "", partner_type: "company", total_seats: "10", tax_id: "" };

/**
 * Platform overview and organization (partner) management. Individual accounts live on the
 * "ผู้ใช้และสิทธิ์" page; `onOpenUsers` opens it when the shell provides navigation.
 */
/** `onOpenAnalytics` opens the school dashboard (pages/AnalyticsDashboard) when the shell provides it. */
export const AdminConsole: React.FC<{ onOpenUsers?: () => void; onOpenAnalytics?: () => void }> = ({ onOpenUsers, onOpenAnalytics }) => {
  const api = useApi();
  const [data, setData] = useState<AdminAnalytics | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Create / edit organization (editing = the organization's id; "" = new)
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<OrgForm>(emptyForm);
  const [actionLoading, setActionLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Transfer an employee between organizations
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferFrom, setTransferFrom] = useState("");
  const [transferMembers, setTransferMembers] = useState<OrgMember[]>([]);
  const [transferUser, setTransferUser] = useState("");
  const [transferTo, setTransferTo] = useState("");
  const [transferError, setTransferError] = useState<string | null>(null);

  const isAdmin = hasRole(api.user, "admin");

  const fetchAdminData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [analyticsRes, orgRes] = await Promise.all([
        api.get<AdminAnalytics>("/admin/analytics"),
        api.get<{ organizations: Organization[] }>("/admin/organizations")
      ]);
      setData(analyticsRes);
      setOrganizations(orgRes.organizations);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "โหลดข้อมูลหน้าผู้ดูแลระบบไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      fetchAdminData();
    }
  }, [api.token]);

  // Members of the source organization for the transfer dialog
  useEffect(() => {
    setTransferUser("");
    setTransferMembers([]);
    if (!showTransfer || !transferFrom) return;
    api.get<{ users: OrgMember[] }>(`/admin/accounts?partner_id=${encodeURIComponent(transferFrom)}&limit=100`)
      .then(res => setTransferMembers(res.users))
      .catch((err: any) => setTransferError(err.message || "โหลดรายชื่อสมาชิกไม่สำเร็จ"));
  }, [showTransfer, transferFrom]);

  const openCreate = () => {
    setForm(emptyForm);
    setModalError(null);
    setEditing("");
  };

  const openEdit = (org: Organization) => {
    setForm({ id: org.id, company_name: org.company_name, partner_type: org.partner_type, total_seats: String(org.total_seats), tax_id: org.tax_id || "" });
    setModalError(null);
    setEditing(org.id);
  };

  const editingOrg = editing ? organizations.find(o => o.id === editing) : undefined;

  const handleSaveOrganization = async (e: React.FormEvent) => {
    e.preventDefault();
    const seats = Number(form.total_seats);
    if (!form.company_name.trim() || !Number.isInteger(seats) || seats < 1) {
      setModalError("กรุณากรอกชื่อองค์กรและจำนวนที่นั่งเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป");
      return;
    }
    if (editingOrg && seats < editingOrg.allocated_seats) {
      setModalError(`จำนวนที่นั่งต้องไม่น้อยกว่าที่ใช้อยู่ (${editingOrg.allocated_seats} ที่นั่ง)`);
      return;
    }

    try {
      setActionLoading(true);
      setModalError(null);
      const payload = { company_name: form.company_name.trim(), partner_type: form.partner_type, total_seats: seats, tax_id: form.tax_id.trim() };
      if (editing) {
        await api.patch(`/admin/organizations/${encodeURIComponent(editing)}`, payload);
        setNotice(`บันทึกข้อมูล ${payload.company_name} แล้ว`);
      } else {
        await api.post("/admin/organizations", { ...payload, id: form.id.trim() || undefined });
        setNotice(`สร้างองค์กร ${payload.company_name} แล้ว`);
      }
      setEditing(null);
      await fetchAdminData();
    } catch (err: any) {
      console.error(err);
      setModalError(err.message || "บันทึกข้อมูลองค์กรไม่สำเร็จ");
    } finally {
      setActionLoading(false);
    }
  };

  const openTransfer = (fromId = "") => {
    setTransferError(null);
    setTransferFrom(fromId);
    setTransferTo("");
    setShowTransfer(true);
  };

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!transferUser || !transferTo) {
      setTransferError("กรุณาเลือกพนักงานและองค์กรปลายทาง");
      return;
    }
    try {
      setActionLoading(true);
      setTransferError(null);
      const res = await api.post<{ message: string; suspended_enrollments: number }>(
        `/admin/users/${encodeURIComponent(transferUser)}/transfer`, { partner_id: transferTo });
      const member = transferMembers.find(m => m.id === transferUser);
      setNotice(`${member?.name || "พนักงาน"}: ${res.message}` +
        (res.suspended_enrollments ? ` (ระงับคอร์สที่องค์กรเดิมสนับสนุน ${res.suspended_enrollments} คอร์ส)` : ""));
      setShowTransfer(false);
      await fetchAdminData();
    } catch (err: any) {
      setTransferError(err.message || "ย้ายองค์กรไม่สำเร็จ");
    } finally {
      setActionLoading(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="glass-card animate-fade-in" style={{ padding: "40px", textAlign: "center", borderLeft: "4px solid var(--danger)" }}>
        <h2 style={{ color: "var(--danger)" }}>ต้องใช้สิทธิ์ผู้ดูแลระบบ</h2>
        <p style={{ color: "var(--text-secondary)", marginTop: "8px" }}>
          หน้านี้สำหรับผู้ดูแลระบบเท่านั้น กรุณาเข้าสู่ระบบด้วยบัญชีที่มีสิทธิ์เพื่อดำเนินการต่อ
        </p>
      </div>
    );
  }

  const targetOrg = organizations.find(o => o.id === transferTo);

  return (
    <div>
      <div className="header-row">
        <div>
          <h1 className="header-title">จัดการระบบส่วนกลาง</h1>
          <p className="header-desc">
            ดูภาพรวมของระบบและจัดการองค์กรลูกค้า (บริษัทและมหาวิทยาลัย) พร้อมโควตาที่นั่ง
          </p>
        </div>

        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <button onClick={fetchAdminData} className="tech-button-outline" style={{ borderRadius: "1rem" }}>
            รีเฟรชข้อมูล
          </button>
          <button onClick={() => openTransfer()} className="tech-button-outline" style={{ borderRadius: "1rem" }}>
            <ArrowRightLeft size={16} />
            ย้ายพนักงานระหว่างองค์กร
          </button>
          <button onClick={openCreate} className="tech-button-primary" style={{ borderRadius: "1rem" }}>
            <PlusCircle size={18} />
            เพิ่มองค์กร
          </button>
        </div>
      </div>

      {error && (
        <div className="glass-card" style={{ borderLeft: "4px solid var(--danger)", background: "rgba(239, 68, 68, 0.08)", color: "var(--danger)", padding: "16px", marginBottom: "24px" }}>
          <strong>แจ้งเตือนผู้ดูแลระบบ:</strong> {error}
        </div>
      )}

      {notice && (
        <div role="status" className="glass-card" style={{ borderLeft: "4px solid var(--accent)", background: "rgba(16, 185, 129, 0.08)", color: "var(--accent)", padding: "16px", marginBottom: "24px", display: "flex", alignItems: "center", gap: "8px" }}>
          <CheckCircle size={16} />
          <span style={{ flex: 1 }}>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="ปิด" style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>×</button>
        </div>
      )}

      {loading && !data ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "64px" }}>
          <div className="spinner" style={{ border: "3px solid var(--border-subtle)", borderTop: "3px solid var(--primary)", borderRadius: "50%", width: "40px", height: "40px", animation: "spin 1s linear infinite" }} />
        </div>
      ) : data ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>

          {/* Diagnostic Metrics Row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "24px" }}>
            <MetricsCard title="องค์กรที่ลงทะเบียน" value={data.totalCorporates} subValue="บริษัทและมหาวิทยาลัย" icon="Building" color="purple" />
            <MetricsCard title="ผู้ใช้ทั้งหมด" value={data.totalUsers} subValue="ผู้เรียน พาร์ตเนอร์ ผู้สอน" icon="Users" color="blue" />
            <MetricsCard title="หลักสูตรที่เปิดอยู่" value={data.totalCourses} subValue="เนื้อหาหลักสูตรในระบบ" icon="FolderGit2" color="accent" />
            <MetricsCard title="การลงทะเบียนเรียน" value={data.totalEnrollments} subValue="ทุกสถานะ" icon="Activity" color="purple" />
          </div>

          {/* Full KPIs, charts, online users and events live on the school dashboard */}
          {onOpenAnalytics && (
            <div className="glass-card" style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
              <BarChart3 size={22} color="var(--primary)" />
              <div style={{ flex: 1, minWidth: "220px" }}>
                <h3 style={{ fontSize: "16px", color: "var(--text-primary)" }}>แดชบอร์ดโรงเรียนและรายงาน</h3>
                <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "4px" }}>
                  ผู้สมัครใหม่ ยอดขาย ผู้เรียนที่ใช้งาน ผู้ใช้ออนไลน์ บันทึกกิจกรรม และรายงานส่งออก CSV
                </p>
              </div>
              <button onClick={onOpenAnalytics} className="tech-button-primary" style={{ borderRadius: "1rem" }}>
                เปิดแดชบอร์ด
              </button>
            </div>
          )}

          {/* Accounts moved to the users & permissions page */}
          <div className="glass-card" style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
            <Users size={22} color="var(--primary)" />
            <div style={{ flex: 1, minWidth: "220px" }}>
              <h3 style={{ fontSize: "16px", color: "var(--text-primary)" }}>จัดการบัญชีผู้ใช้</h3>
              <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "4px" }}>
                ค้นหา เพิ่ม ระงับบัญชี และกำหนดบทบาทได้ที่หน้า "ผู้ใช้และสิทธิ์"
              </p>
            </div>
            {onOpenUsers && (
              <button onClick={onOpenUsers} className="tech-button-outline" style={{ borderRadius: "1rem" }}>
                ไปที่ผู้ใช้และสิทธิ์
              </button>
            )}
          </div>

          {/* Organizations */}
          <div className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <h3 style={{ fontSize: "18px", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
              <Building2 size={18} color="var(--primary)" />
              องค์กรลูกค้า
            </h3>

            {organizations.length === 0 ? (
              <Empty text="ยังไม่มีองค์กร กด &quot;เพิ่มองค์กร&quot; เพื่อเริ่มต้น" />
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>องค์กร</th>
                      <th style={thStyle}>ประเภท</th>
                      <th style={thStyle}>ที่นั่งที่ใช้</th>
                      <th style={thStyle}>สมาชิก</th>
                      <th style={thStyle}>คอร์สที่สนับสนุน</th>
                      <th style={thStyle}>สร้างเมื่อ</th>
                      <th style={thStyle}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {organizations.map(org => (
                      <tr key={org.id}>
                        <td style={tdStyle}>
                          <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{org.company_name}</div>
                          <div style={{ fontSize: "12px", fontFamily: "monospace", color: "var(--text-muted)" }}>{org.id}</div>
                          {org.tax_id && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>เลขผู้เสียภาษี {org.tax_id}</div>}
                        </td>
                        <td style={tdStyle}><Chip {...(PARTNER_TYPE[org.partner_type] || PARTNER_TYPE.company)} /></td>
                        <td style={tdStyle}><SeatBar taken={org.allocated_seats} capacity={org.total_seats} /></td>
                        <td style={tdStyle}>{org.members}</td>
                        <td style={tdStyle}>{org.sponsored_courses}</td>
                        <td style={{ ...tdStyle, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{formatDate(org.created_at)}</td>
                        <td style={{ ...tdStyle, whiteSpace: "nowrap", textAlign: "right" }}>
                          <button onClick={() => openEdit(org)} className="tech-button-outline" style={{ padding: "6px 12px", borderRadius: "1rem", fontSize: "12px" }}>
                            <Pencil size={14} />
                            แก้ไข
                          </button>
                          {" "}
                          <button onClick={() => openTransfer(org.id)} className="tech-button-outline" style={{ padding: "6px 12px", borderRadius: "1rem", fontSize: "12px" }}>
                            <ArrowRightLeft size={14} />
                            ย้ายพนักงาน
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

        </div>
      ) : null}

      {/* Create / Edit Organization */}
      {editing !== null && (
        <Modal title={editing ? `แก้ไของค์กร: ${editingOrg?.company_name ?? ""}` : "เพิ่มองค์กร"} onClose={() => !actionLoading && setEditing(null)} width={560}>
          <ErrorBox message={modalError} />
          <form onSubmit={handleSaveOrganization}>
            <div style={grid2}>
              <Field label="ชื่อบริษัท/องค์กร" span>
                <input type="text" className="form-input" required maxLength={200} placeholder="เช่น บริษัท เอ็กซ์ จำกัด"
                  value={form.company_name} onChange={e => setForm({ ...form, company_name: e.target.value })} />
              </Field>
              <Field label="ประเภทองค์กร">
                <select className="form-input" value={form.partner_type} onChange={e => setForm({ ...form, partner_type: e.target.value as PartnerType })}>
                  <option value="company">บริษัท</option>
                  <option value="university">มหาวิทยาลัย</option>
                </select>
              </Field>
              <Field label="จำนวนที่นั่งตามโควตา" hint={editingOrg ? `ใช้อยู่ ${editingOrg.allocated_seats} ที่นั่ง ลดต่ำกว่านี้ไม่ได้` : undefined}>
                <input type="number" className="form-input" required min={editingOrg ? Math.max(1, editingOrg.allocated_seats) : 1} max={100000}
                  value={form.total_seats} onChange={e => setForm({ ...form, total_seats: e.target.value })} />
              </Field>
              <Field label="เลขประจำตัวผู้เสียภาษี (ไม่บังคับ)">
                <input type="text" className="form-input" maxLength={40}
                  value={form.tax_id} onChange={e => setForm({ ...form, tax_id: e.target.value })} />
              </Field>
              {!editing && (
                <Field label="รหัสองค์กรที่กำหนดเอง (ไม่บังคับ)" hint="a-z 0-9 _ - เว้นว่างเพื่อสร้างอัตโนมัติ">
                  <input type="text" className="form-input" placeholder="เช่น partner_acme" pattern="[A-Za-z0-9_\-]{3,64}"
                    value={form.id} onChange={e => setForm({ ...form, id: e.target.value })} />
                </Field>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "24px" }}>
              <button type="button" onClick={() => setEditing(null)} className="tech-button-outline" style={{ borderRadius: "1rem" }}>ยกเลิก</button>
              <button type="submit" disabled={actionLoading} className="tech-button-primary" style={{ borderRadius: "1rem" }}>
                {actionLoading ? "กำลังบันทึก..." : editing ? "บันทึก" : "เพิ่มองค์กร"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Transfer employee */}
      {showTransfer && (
        <Modal title="ย้ายพนักงานระหว่างองค์กร" onClose={() => !actionLoading && setShowTransfer(false)} width={560}>
          <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: "16px" }}>
            ระบบตรวจที่นั่งว่างขององค์กรปลายทาง คืนที่นั่งให้องค์กรเดิม และระงับคอร์สที่องค์กรเดิมสนับสนุนซึ่งยังเรียนไม่จบ คอร์สที่พนักงานซื้อเองยังเรียนต่อได้
          </p>
          <ErrorBox message={transferError} />
          <form onSubmit={handleTransfer}>
            <div style={grid2}>
              <Field label="องค์กรเดิม">
                <select className="form-input" value={transferFrom} onChange={e => setTransferFrom(e.target.value)} required>
                  <option value="">เลือกองค์กร</option>
                  {organizations.map(o => <option key={o.id} value={o.id}>{o.company_name}</option>)}
                </select>
              </Field>
              <Field label="พนักงาน">
                <select className="form-input" value={transferUser} onChange={e => setTransferUser(e.target.value)} required disabled={!transferFrom}>
                  <option value="">{transferFrom && transferMembers.length === 0 ? "ไม่มีสมาชิก" : "เลือกพนักงาน"}</option>
                  {transferMembers.map(m => <option key={m.id} value={m.id}>{m.name} ({m.email})</option>)}
                </select>
              </Field>
              <Field label="องค์กรปลายทาง" span
                hint={targetOrg ? `ที่นั่งว่าง ${Math.max(0, targetOrg.total_seats - targetOrg.allocated_seats)} จาก ${targetOrg.total_seats} ที่นั่ง` : undefined}>
                <select className="form-input" value={transferTo} onChange={e => setTransferTo(e.target.value)} required>
                  <option value="">เลือกองค์กร</option>
                  {organizations.filter(o => o.id !== transferFrom).map(o => <option key={o.id} value={o.id}>{o.company_name}</option>)}
                </select>
              </Field>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "24px" }}>
              <button type="button" onClick={() => setShowTransfer(false)} className="tech-button-outline" style={{ borderRadius: "1rem" }}>ยกเลิก</button>
              <button type="submit" disabled={actionLoading} className="tech-button-primary" style={{ borderRadius: "1rem" }}>
                {actionLoading ? "กำลังย้าย..." : "ย้ายองค์กร"}
              </button>
            </div>
          </form>
        </Modal>
      )}

    </div>
  );
};
export default AdminConsole;
