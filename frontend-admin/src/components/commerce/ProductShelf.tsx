import React, { useEffect, useState } from "react";
import { Award, CalendarClock, Layers, Route } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { baht, formatThaiDateTime } from "../learner/CourseOrder";
import { ProductOrderModal } from "./ProductOrderModal";
import { Product } from "./types";

interface MyMembership { id: string; product_id: string; title: string; all_courses: boolean; expires_at: string; status: string; active: boolean; days_left: number }

const card: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "8px" };
const pill = (color: string, bg: string): React.CSSProperties => ({ display: "inline-block", fontSize: "12px", fontWeight: 600, padding: "3px 10px", borderRadius: "99px", color, background: bg });

/**
 * Learner shelf "แพ็กเกจและสมาชิก": bundles (with savings), learning paths, memberships (status, renew)
 * and installment-friendly course packages. Buying opens ProductOrderModal.
 */
export const ProductShelf: React.FC<{ onShowPayments?: () => void; onOpenPath?: (productId: string) => void }> = ({ onShowPayments, onOpenPath }) => {
  const api = useApi();
  const [products, setProducts] = useState<Product[]>([]);
  const [memberships, setMemberships] = useState<MyMembership[]>([]);
  const [buying, setBuying] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setLoading(true);
      const [p, m] = await Promise.all([
        api.get<{ products: Product[] }>("/student/products"),
        api.get<{ memberships: MyMembership[] }>("/student/memberships")
      ]);
      setProducts(p.products);
      setMemberships(m.memberships);
      setError(null);
    } catch (err: any) {
      setError(err.message || "โหลดแพ็กเกจไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [api.token]);

  const groups: [string, React.ReactNode, Product[]][] = [
    ["ชุดคอร์สและเส้นทางการเรียน", <Route size={16} />, products.filter(p => p.kind === "bundle")],
    ["สมาชิกรายช่วง", <CalendarClock size={16} />, products.filter(p => p.kind === "membership")],
    ["คอร์สแบบผ่อนชำระ", <Layers size={16} />, products.filter(p => p.kind === "course")]
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      {error && <div className="glass-card" role="alert" style={{ color: "var(--danger)" }}>{error}</div>}
      {memberships.length > 0 && (
        <div className="glass-card" style={card}>
          <h3 style={{ fontSize: "16px" }}>สมาชิกของฉัน</h3>
          {memberships.map(m => (
            <div key={m.id} style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", fontSize: "13px" }}>
              <span>{m.title}</span>
              <span>
                {m.active
                  ? <span style={pill(m.days_left <= 7 ? "var(--warning)" : "var(--accent)", m.days_left <= 7 ? "rgba(245,158,11,0.12)" : "var(--accent-glow)")}>
                      ใช้งานได้ถึง {formatThaiDateTime(m.expires_at)} (อีก {m.days_left} วัน)</span>
                  : <span style={pill("var(--text-secondary)", "rgba(100,116,139,0.12)")}>{m.status === "suspended" ? "ระงับชั่วคราว (ค้างชำระ)" : "หมดอายุแล้ว"}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      {loading && products.length === 0 ? <div className="glass-card" style={{ textAlign: "center", color: "var(--text-secondary)" }}>กำลังโหลด...</div>
        : products.length === 0 ? <div className="glass-card" style={{ textAlign: "center", color: "var(--text-secondary)", padding: "40px" }}>ยังไม่มีแพ็กเกจที่เปิดขาย</div>
        : groups.filter(([, , list]) => list.length > 0).map(([title, icon, list]) => (
          <div key={title}>
            <h3 style={{ fontSize: "16px", display: "flex", gap: "8px", alignItems: "center", marginBottom: "10px" }}>{icon}{title}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "14px" }}>
              {list.map(p => {
                const ownedAll = p.kind === "bundle" && p.owned_courses === p.courses.length && p.courses.length > 0;
                const member = p.membership?.status === "active";
                return (
                  <div key={p.id} className="glass-card" style={card}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                      <strong style={{ fontSize: "15px" }}>{p.title}</strong>
                      {p.is_path && <span style={pill("var(--primary)", "var(--primary-glow)")}>เส้นทาง</span>}
                    </div>
                    {p.description && <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.5 }}>{p.description}</p>}
                    <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                      {p.kind === "membership" ? `${p.all_courses ? "ทุกคอร์ส" : `${p.course_count} คอร์ส`} · ${p.access_days} วัน`
                        : `${p.course_count} คอร์ส · ${p.access_days ? `${p.access_days} วัน` : "ตลอดชีพ"}`}
                      {p.max_installments > 1 ? ` · ผ่อนได้ ${p.max_installments} งวด` : ""}
                      {p.path_certificate ? " · มีใบประกาศเมื่อจบเส้นทาง" : ""}
                    </p>
                    <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
                      <span style={{ fontSize: "20px", fontWeight: 800, color: "var(--primary)" }}>{baht(p.price)}</span>
                      {p.savings > 0 && <span style={{ fontSize: "12px", color: "var(--accent)", fontWeight: 700 }}>ประหยัด {baht(p.savings)}</span>}
                    </div>
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "auto" }}>
                      {ownedAll ? <span style={pill("var(--accent)", "var(--accent-glow)")}>มีสิทธิ์ครบแล้ว</span>
                        : p.open_order ? <button type="button" className="tech-button-outline" onClick={() => setBuying(p)}>ดูคำสั่งซื้อ {p.open_order.reference}</button>
                        : <button type="button" className="tech-button-primary" onClick={() => setBuying(p)}>{member ? "ต่ออายุ" : "ซื้อ"}</button>}
                      {p.is_path && onOpenPath && (
                        <button type="button" className="tech-button-outline" onClick={() => onOpenPath(p.id)}><Award size={14} />ดูความคืบหน้า</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      {buying && <ProductOrderModal product={buying} onClose={() => { setBuying(null); load(); }} onDone={load} onShowPayments={onShowPayments} />}
    </div>
  );
};

export default ProductShelf;
