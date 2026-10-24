import React, { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * Print-only documents (receipt, certificate). The portal renders next to the app root; print CSS hides
 * everything else so the browser's "บันทึกเป็น PDF" produces just the document.
 */
export const PrintPortal: React.FC<{ orientation: "portrait" | "landscape"; onDone: () => void; children: React.ReactNode }> = ({ orientation, onDone, children }) => {
  useEffect(() => {
    let finished = false;
    const done = () => { if (!finished) { finished = true; onDone(); } };
    window.addEventListener("afterprint", done);
    // Let the portal paint before opening the print dialog.
    const timer = window.setTimeout(() => { window.print(); window.setTimeout(done, 500); }, 150);
    return () => { window.clearTimeout(timer); window.removeEventListener("afterprint", done); };
  }, []);

  return createPortal(
    <div className="np-print-root">
      <style>{`
        .np-print-root { display: none; }
        @media print {
          @page { size: A4 ${orientation}; margin: 0; }
          html, body { background: #fff !important; }
          body > *:not(.np-print-root) { display: none !important; }
          .np-print-root { display: block; color: #0f172a; font-family: "Sarabun", "Noto Sans Thai", Inter, sans-serif;
            -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
      {children}
    </div>,
    document.body
  );
};

export interface ReceiptData {
  receipt_no: string; reference: string; paid_at: string | null; course_title: string; user_name: string; user_email: string;
  list_price: number; amount: number; amount_received: number | null; voucher_code: string | null; status: string;
}

const money = (value: number) => value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const thaiDate = (value: string | null) => {
  if (!value) return "-";
  const date = new Date(value.includes("T") || value.includes("Z") ? value : value.replace(" ", "T") + "Z");
  return isNaN(date.getTime()) ? value : date.toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" });
};

const cell: React.CSSProperties = { padding: "10px 12px", borderBottom: "1px solid #e2e8f0", fontSize: "13px" };

export const ReceiptDocument: React.FC<{ order: ReceiptData }> = ({ order }) => {
  const discount = Math.max(0, order.list_price - order.amount);
  const paid = order.amount_received ?? order.amount;
  return (
    <div style={{ width: "210mm", minHeight: "297mm", padding: "20mm", boxSizing: "border-box" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "3px solid #e56b25", paddingBottom: "12px" }}>
        <div>
          <div style={{ fontSize: "24px", fontWeight: 800, color: "#e56b25" }}>NetPrime</div>
          <div style={{ fontSize: "12px", color: "#475569" }}>ศูนย์ฝึกอบรมไอที NetPrime</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "20px", fontWeight: 800 }}>ใบเสร็จรับเงิน</div>
          <div style={{ fontSize: "12px", color: "#475569" }}>Receipt</div>
        </div>
      </div>

      <table style={{ width: "100%", marginTop: "18px", fontSize: "13px" }}>
        <tbody>
          <tr><td style={{ color: "#64748b", width: "30%" }}>เลขที่ใบเสร็จ</td><td style={{ fontFamily: "monospace", fontWeight: 700 }}>{order.receipt_no}</td></tr>
          <tr><td style={{ color: "#64748b" }}>เลขที่คำสั่งซื้อ</td><td style={{ fontFamily: "monospace" }}>{order.reference}</td></tr>
          <tr><td style={{ color: "#64748b" }}>วันที่ชำระ</td><td>{thaiDate(order.paid_at)}</td></tr>
          <tr><td style={{ color: "#64748b" }}>ได้รับเงินจาก</td><td>{order.user_name} ({order.user_email})</td></tr>
        </tbody>
      </table>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "24px" }}>
        <thead>
          <tr style={{ background: "#f1f5f9" }}>
            <th style={{ ...cell, textAlign: "left" }}>รายการ</th>
            <th style={{ ...cell, textAlign: "right", width: "30%" }}>จำนวนเงิน (บาท)</th>
          </tr>
        </thead>
        <tbody>
          <tr><td style={cell}>ค่าลงทะเบียนคอร์ส: {order.course_title}</td><td style={{ ...cell, textAlign: "right" }}>{money(order.list_price)}</td></tr>
          {discount > 0 && (
            <tr><td style={cell}>ส่วนลด{order.voucher_code ? ` (โค้ด ${order.voucher_code})` : ""}</td><td style={{ ...cell, textAlign: "right" }}>-{money(discount)}</td></tr>
          )}
          <tr><td style={{ ...cell, fontWeight: 700 }}>ยอดสุทธิ</td><td style={{ ...cell, textAlign: "right", fontWeight: 700 }}>{money(order.amount)}</td></tr>
          <tr><td style={{ ...cell, fontWeight: 700 }}>ยอดที่ได้รับชำระ (โอนเงิน)</td><td style={{ ...cell, textAlign: "right", fontWeight: 800, fontSize: "15px" }}>{money(paid)}</td></tr>
        </tbody>
      </table>

      {order.status === "refunded" && (
        <p style={{ marginTop: "16px", color: "#dc2626", fontWeight: 700 }}>คำสั่งซื้อนี้ถูกยกเลิก/คืนเงินแล้ว</p>
      )}
      <p style={{ marginTop: "48px", fontSize: "12px", color: "#64748b" }}>
        เอกสารนี้ออกโดยระบบหลังเจ้าหน้าที่ยืนยันการโอนเงิน ใช้เป็นหลักฐานการชำระเงินได้
      </p>
    </div>
  );
};

export interface CertificateData {
  certificate_code: string; issued_at: string; student_name: string; course_title: string; revoked_at?: string | null;
}

export const CertificateDocument: React.FC<{ cert: CertificateData; verifyUrl: string }> = ({ cert, verifyUrl }) => (
  <div style={{ width: "297mm", height: "210mm", padding: "12mm", boxSizing: "border-box" }}>
    <div style={{ height: "100%", boxSizing: "border-box", border: "3px solid #e56b25", outline: "1px solid #f59e0b", outlineOffset: "-10px",
      padding: "18mm 22mm", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", position: "relative" }}>
      {cert.revoked_at && (
        <div style={{ position: "absolute", top: "40%", left: 0, right: 0, transform: "rotate(-12deg)", fontSize: "64px", fontWeight: 900, color: "rgba(220,38,38,0.35)" }}>
          เพิกถอนแล้ว
        </div>
      )}
      <div style={{ fontSize: "26px", fontWeight: 800, color: "#e56b25", letterSpacing: "0.05em" }}>NetPrime</div>
      <div style={{ fontSize: "30px", fontWeight: 800, marginTop: "10mm" }}>ใบประกาศนียบัตร</div>
      <div style={{ fontSize: "13px", color: "#64748b", letterSpacing: "0.2em", textTransform: "uppercase" }}>Certificate of Completion</div>
      <div style={{ fontSize: "15px", color: "#475569", marginTop: "10mm" }}>ขอมอบใบประกาศนียบัตรฉบับนี้เพื่อแสดงว่า</div>
      <div style={{ fontSize: "34px", fontWeight: 800, marginTop: "4mm", borderBottom: "1px solid #cbd5e1", padding: "0 16mm 3mm" }}>{cert.student_name}</div>
      <div style={{ fontSize: "15px", color: "#475569", marginTop: "6mm" }}>ได้เรียนจบและผ่านการประเมินของหลักสูตร</div>
      <div style={{ fontSize: "22px", fontWeight: 700, color: "#e56b25", marginTop: "3mm" }}>{cert.course_title}</div>
      <div style={{ marginTop: "auto", width: "100%", display: "flex", justifyContent: "space-between", alignItems: "flex-end", fontSize: "12px", color: "#475569" }}>
        <div style={{ textAlign: "left" }}>
          <div>วันที่ออก: {thaiDate(cert.issued_at)}</div>
          <div style={{ fontFamily: "monospace", fontWeight: 700, color: "#0f172a" }}>รหัสตรวจสอบ: {cert.certificate_code}</div>
          <div>ตรวจสอบได้ที่ {verifyUrl}</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ borderTop: "1px solid #94a3b8", paddingTop: "2mm", minWidth: "60mm" }}>คณะกรรมการ NetPrime</div>
        </div>
      </div>
    </div>
  </div>
);
