import React, { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Edit3, Plus, Trash2 } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, Empty, ErrorBox, Field, Modal, grid2, tableStyle, tdStyle, thStyle } from "../site-admin/ui";
import { baht } from "../learner/CourseOrder";
import { CourseOption, PRODUCT_KIND, PRODUCT_STATUS, Product, ProductKind } from "./types";

/** Products beyond single courses (commerce.manage): bundles / learning paths, memberships, installment course packages. */
export const ProductsManager: React.FC = () => {
  const api = useApi();
  const [products, setProducts] = useState<Product[]>([]);
  const [courses, setCourses] = useState<CourseOption[]>([]);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setLoading(true);
      setProducts((await api.get<{ products: Product[] }>("/manage/products")).products);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    api.get<CourseOption[]>("/courses").then(list => setCourses(list.map(c => ({ id: c.id, title: c.title, price: Math.round(c.price || 0) })))).catch(() => undefined);
  }, [api.token]);

  const remove = async (p: Product) => {
    if (!window.confirm(`ลบแพ็กเกจ "${p.title}"?`)) return;
    try {
      await api.request(`/manage/products/${p.id}`, { method: "DELETE" });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>ชุดคอร์ส (แสดงเป็นเส้นทางการเรียนได้) สมาชิกรายช่วง และคอร์สแบบผ่อนชำระ ทุกแพ็กเกจชำระด้วยการโอนเงิน</p>
        <button type="button" className="tech-button-primary" onClick={() => setEditing("new")}><Plus size={16} />สร้างแพ็กเกจ</button>
      </div>
      <ErrorBox message={error} />
      <div className="glass-card" style={{ padding: "8px", overflowX: "auto" }}>
        {loading ? <Empty text="กำลังโหลด…" /> : products.length === 0 ? <Empty text="ยังไม่มีแพ็กเกจ" /> : (
          <table style={tableStyle}>
            <thead><tr><th style={thStyle}>แพ็กเกจ</th><th style={thStyle}>ประเภท</th><th style={thStyle}>ราคา</th><th style={thStyle}>ผ่อน</th><th style={thStyle}>ขายแล้ว</th><th style={thStyle}>สถานะ</th><th style={thStyle}></th></tr></thead>
            <tbody>
              {products.map(p => (
                <tr key={p.id}>
                  <td style={tdStyle}>
                    <strong>{p.title}</strong>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                      {p.all_courses ? "ทุกคอร์สที่เปิดสอน" : p.courses.map(c => c.title).join(" → ")}
                    </div>
                  </td>
                  <td style={tdStyle}>{PRODUCT_KIND[p.kind]}{p.is_path ? " · เส้นทาง" : ""}{p.access_days ? ` · ${p.access_days} วัน` : ""}</td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{baht(p.price)}{p.savings > 0 && <div style={{ fontSize: "12px", color: "var(--accent)" }}>ประหยัด {baht(p.savings)}</div>}</td>
                  <td style={tdStyle}>{p.max_installments > 1 ? `${p.max_installments} งวด` : "-"}</td>
                  <td style={tdStyle}>{p.sold ?? 0}</td>
                  <td style={tdStyle}><Chip {...PRODUCT_STATUS[p.status]} /></td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    <button type="button" className="tech-button-outline" onClick={() => setEditing(p)} style={{ padding: "4px 10px", fontSize: "12px" }} aria-label="แก้ไข"><Edit3 size={14} /></button>{" "}
                    {!p.sold && <button type="button" className="tech-button-outline" onClick={() => remove(p)} style={{ padding: "4px 10px", fontSize: "12px", color: "var(--danger)" }} aria-label="ลบ"><Trash2 size={14} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <ProductDialog product={editing === "new" ? null : editing} courses={courses} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
};

const ProductDialog: React.FC<{ product: Product | null; courses: CourseOption[]; onClose: () => void; onSaved: () => void }> = ({ product, courses, onClose, onSaved }) => {
  const api = useApi();
  const [v, setV] = useState({
    kind: (product?.kind ?? "bundle") as ProductKind, title: product?.title ?? "", description: product?.description ?? "", price: String(product?.price ?? ""),
    status: product?.status ?? "draft", course_id: product?.course_id ?? "", course_ids: product?.courses.map(c => c.course_id) ?? [] as string[],
    access_days: product?.access_days ? String(product.access_days) : "", all_courses: product?.all_courses ?? false, is_path: product?.is_path ?? false,
    path_certificate: product?.path_certificate ?? false, max_installments: product?.max_installments ?? 1, installment_interval_days: String(product?.installment_interval_days ?? 30),
    installment_access: product?.installment_access ?? "first", overdue_grace_days: String(product?.overdue_grace_days ?? 7)
  });
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof v>(key: K, value: (typeof v)[K]) => setV(prev => ({ ...prev, [key]: value }));
  const separate = v.course_ids.reduce((sum, id) => sum + (courses.find(c => c.id === id)?.price ?? 0), 0);
  const move = (index: number, delta: number) => {
    const list = [...v.course_ids];
    const [item] = list.splice(index, 1);
    list.splice(index + delta, 0, item);
    set("course_ids", list);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setBusy(true);
      setError(null);
      const body = { ...v, price: Number(v.price), access_days: v.access_days ? Number(v.access_days) : null, installment_interval_days: Number(v.installment_interval_days),
        overdue_grace_days: Number(v.overdue_grace_days) };
      if (product) await api.request(`/manage/products/${product.id}`, { method: "PUT", body: JSON.stringify(body) });
      else await api.post("/manage/products", body);
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={product ? `แก้ไข ${product.title}` : "สร้างแพ็กเกจ"} onClose={onClose} width={720}>
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <ErrorBox message={error} />
        <div style={grid2}>
          <Field label="ประเภท">
            <select className="form-input" value={v.kind} disabled={!!product} onChange={e => set("kind", e.target.value as ProductKind)}>
              {(Object.keys(PRODUCT_KIND) as ProductKind[]).map(k => <option key={k} value={k}>{PRODUCT_KIND[k]}</option>)}
            </select>
          </Field>
          <Field label="สถานะ">
            <select className="form-input" value={v.status} onChange={e => set("status", e.target.value as Product["status"])}>
              <option value="draft">ร่าง</option><option value="published">เปิดขาย</option><option value="archived">เลิกขาย</option>
            </select>
          </Field>
          <Field label="ชื่อแพ็กเกจ" span><input className="form-input" required value={v.title} onChange={e => set("title", e.target.value)} maxLength={200} /></Field>
          <Field label="คำอธิบาย" span><textarea className="form-input" rows={2} value={v.description} onChange={e => set("description", e.target.value)} maxLength={5000} /></Field>
          <Field label="ราคา (บาท รวม VAT แล้ว ถ้ามี)"><input className="form-input" type="number" min={0} step={1} required value={v.price} onChange={e => set("price", e.target.value)} /></Field>
          <Field label={v.kind === "membership" ? "ระยะเวลาสมาชิก (วัน)" : "เข้าเรียนได้ (วัน, เว้นว่าง = ตลอดชีพ)"}>
            <input className="form-input" type="number" min={1} max={3650} required={v.kind === "membership"} value={v.access_days} onChange={e => set("access_days", e.target.value)} />
          </Field>
        </div>

        {v.kind === "course" && (
          <Field label="คอร์ส">
            <select className="form-input" required value={v.course_id} onChange={e => set("course_id", e.target.value)}>
              <option value="">เลือกคอร์ส</option>
              {courses.map(c => <option key={c.id} value={c.id}>{c.title} ({baht(c.price)})</option>)}
            </select>
          </Field>
        )}
        {v.kind === "membership" && (
          <label style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <input type="checkbox" checked={v.all_courses} onChange={e => set("all_courses", e.target.checked)} /> เข้าเรียนได้ทุกคอร์สที่เปิดสอน (รวมคอร์สใหม่ที่เผยแพร่ภายหลัง)
          </label>
        )}
        {v.kind !== "course" && !(v.kind === "membership" && v.all_courses) && (
          <div className="glass-card" style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
            <strong style={{ fontSize: "14px" }}>คอร์สในแพ็กเกจ{v.is_path ? " (เรียงตามลำดับการเรียน)" : ""}</strong>
            {v.course_ids.map((id, i) => (
              <div key={id} style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px" }}>
                <span style={{ flex: 1 }}>{i + 1}. {courses.find(c => c.id === id)?.title ?? id}</span>
                <button type="button" className="tech-button-outline" disabled={i === 0} onClick={() => move(i, -1)} style={{ padding: "2px 6px" }} aria-label="เลื่อนขึ้น"><ArrowUp size={12} /></button>
                <button type="button" className="tech-button-outline" disabled={i === v.course_ids.length - 1} onClick={() => move(i, 1)} style={{ padding: "2px 6px" }} aria-label="เลื่อนลง"><ArrowDown size={12} /></button>
                <button type="button" className="tech-button-outline" onClick={() => set("course_ids", v.course_ids.filter(x => x !== id))} style={{ padding: "2px 6px", color: "var(--danger)" }} aria-label="นำออก"><Trash2 size={12} /></button>
              </div>
            ))}
            <div style={{ display: "flex", gap: "8px" }}>
              <select className="form-input" value={pick} onChange={e => setPick(e.target.value)}>
                <option value="">เพิ่มคอร์ส…</option>
                {courses.filter(c => !v.course_ids.includes(c.id)).map(c => <option key={c.id} value={c.id}>{c.title} ({baht(c.price)})</option>)}
              </select>
              <button type="button" className="tech-button-outline" disabled={!pick} onClick={() => { set("course_ids", [...v.course_ids, pick]); setPick(""); }}>เพิ่ม</button>
            </div>
            {v.kind === "bundle" && separate > 0 && (
              <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>ราคาซื้อแยกรวม {baht(separate)}{Number(v.price) < separate ? ` · ผู้ซื้อประหยัด ${baht(separate - Number(v.price))}` : ""}</p>
            )}
          </div>
        )}
        {v.kind === "bundle" && (
          <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
            <label style={{ display: "flex", gap: "8px", alignItems: "center" }}><input type="checkbox" checked={v.is_path} onChange={e => set("is_path", e.target.checked)} /> แสดงเป็นเส้นทางการเรียน</label>
            {v.is_path && <label style={{ display: "flex", gap: "8px", alignItems: "center" }}><input type="checkbox" checked={v.path_certificate} onChange={e => set("path_certificate", e.target.checked)} /> มีใบประกาศเมื่อจบเส้นทาง</label>}
          </div>
        )}

        <div style={grid2}>
          <Field label="ผ่อนได้สูงสุด">
            <select className="form-input" value={v.max_installments} onChange={e => set("max_installments", Number(e.target.value))}>
              <option value={1}>ไม่เปิดผ่อน</option>
              {[2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n} งวด</option>)}
            </select>
          </Field>
          {v.max_installments > 1 && (<>
            <Field label="ระยะห่างแต่ละงวด (วัน)"><input className="form-input" type="number" min={7} max={90} value={v.installment_interval_days} onChange={e => set("installment_interval_days", e.target.value)} /></Field>
            <Field label="เปิดสิทธิ์เข้าเรียน">
              <select className="form-input" value={v.installment_access} onChange={e => set("installment_access", e.target.value as "first" | "full")}>
                <option value="first">หลังยืนยันงวดแรก</option><option value="full">เมื่อชำระครบทุกงวด</option>
              </select>
            </Field>
            <Field label="ระงับสิทธิ์เมื่อเลยกำหนดเกิน (วัน)"><input className="form-input" type="number" min={0} max={60} value={v.overdue_grace_days} onChange={e => set("overdue_grace_days", e.target.value)} /></Field>
          </>)}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={busy}>{busy ? "กำลังบันทึก…" : "บันทึก"}</button>
        </div>
      </form>
    </Modal>
  );
};

export default ProductsManager;
