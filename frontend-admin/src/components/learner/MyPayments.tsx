import React, { useEffect, useState } from "react";
import { Printer, Receipt } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { BankTransfer, CourseOrder, ORDER_STATUS, SlipUpload, TransferInstructions, baht, formatThaiDateTime } from "./CourseOrder";
import { PrintPortal, ReceiptDocument } from "./PrintView";

/** "การชำระเงินของฉัน": order history, transfer details for open orders and printable receipts. */
export const MyPayments: React.FC = () => {
  const api = useApi();
  const [orders, setOrders] = useState<CourseOrder[]>([]);
  const [instructions, setInstructions] = useState<BankTransfer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [printing, setPrinting] = useState<CourseOrder | null>(null);

  const load = async () => {
    try {
      setLoading(true);
      const res = await api.get<{ orders: CourseOrder[]; instructions: BankTransfer }>("/student/orders");
      setOrders(res.orders);
      setInstructions(res.instructions);
      setError(null);
    } catch (err: any) {
      setError(err.message || "โหลดประวัติการชำระเงินไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [api.token]);

  const cancel = async (order: CourseOrder) => {
    if (!window.confirm(`ยกเลิกคำสั่งซื้อ ${order.reference}?`)) return;
    try {
      await api.post(`/student/orders/${order.id}/cancel`, {});
      await load();
    } catch (err: any) {
      setError(err.message || "ยกเลิกไม่สำเร็จ");
    }
  };

  const replace = (next: CourseOrder) => setOrders(list => list.map(o => (o.id === next.id ? next : o)));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "20px" }}>
        <Receipt size={20} color="var(--primary)" />
        <h2 style={{ fontSize: "20px", color: "var(--text-primary)" }}>การชำระเงินของฉัน</h2>
      </div>
      {error && <div className="glass-card" role="alert" style={{ color: "var(--danger)", marginBottom: "16px" }}>{error}</div>}
      {loading && orders.length === 0 ? (
        <div className="glass-card" style={{ textAlign: "center", color: "var(--text-secondary)" }}>กำลังโหลด...</div>
      ) : orders.length === 0 ? (
        <div className="glass-card" style={{ textAlign: "center", color: "var(--text-secondary)", padding: "40px" }}>
          ยังไม่มีคำสั่งซื้อ กดปุ่ม "ซื้อคอร์ส" ในหน้ารายละเอียดคอร์สเพื่อเริ่มต้น
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {orders.map(order => {
            const status = ORDER_STATUS[order.status];
            return (
              <div key={order.id} className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap" }}>
                  <div>
                    <h3 style={{ fontSize: "16px", color: "var(--text-primary)" }}>{order.course_title}</h3>
                    <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "monospace" }}>
                      {order.reference}{order.receipt_no ? ` · ใบเสร็จ ${order.receipt_no}` : ""} · สั่งซื้อ {formatThaiDateTime(order.created_at)}
                    </p>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ display: "inline-block", fontSize: "12px", fontWeight: 600, padding: "3px 10px", borderRadius: "99px", color: status.color, background: status.bg }}>
                      {status.label}
                    </span>
                    <div style={{ fontWeight: 800, marginTop: "4px" }}>{order.amount === 0 ? "ฟรี" : baht(order.amount)}</div>
                  </div>
                </div>
                {order.staff_note && order.status !== "paid" && (
                  <p style={{ fontSize: "13px", color: "var(--danger)" }}>หมายเหตุจากเจ้าหน้าที่: {order.staff_note}</p>
                )}
                {order.status === "pending" && instructions && (
                  <>
                    <TransferInstructions order={order} instructions={instructions} />
                    <SlipUpload order={order} onUploaded={replace} />
                    <button type="button" className="tech-button-outline" onClick={() => cancel(order)} style={{ alignSelf: "flex-start", color: "var(--danger)" }}>
                      ยกเลิกคำสั่งซื้อ
                    </button>
                  </>
                )}
                {(order.status === "paid" || order.status === "refunded") && order.receipt_no && (
                  <button type="button" className="tech-button-outline" onClick={() => setPrinting(order)}
                    style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    <Printer size={14} /> พิมพ์ใบเสร็จ / บันทึกเป็น PDF
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {printing && printing.receipt_no && (
        <PrintPortal orientation="portrait" onDone={() => setPrinting(null)}>
          <ReceiptDocument order={{ ...printing, receipt_no: printing.receipt_no }} />
        </PrintPortal>
      )}
    </div>
  );
};
