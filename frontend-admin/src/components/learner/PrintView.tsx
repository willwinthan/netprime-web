import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { CertificateTemplate, useCertificateTemplate } from "../certificates/CertificateTemplate";

/**
 * Print-only documents (receipt / tax invoice, credit note, quotation, certificate). The portal renders
 * next to the app root; print CSS hides everything else so the browser's "บันทึกเป็น PDF" produces just the document.
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

/** School tax profile (GET /student/payment-instructions → seller, /manage/tax-profile). */
export interface SellerProfile {
  company_name: string; tax_id: string; branch: string; address: string; phone?: string; vat_registered: boolean;
}

export interface ReceiptData {
  receipt_no: string; reference: string; paid_at: string | null; course_title: string; user_name: string; user_email: string;
  list_price: number; amount: number; amount_received: number | null; voucher_code: string | null; status: string;
  kind?: string; vat_rate?: number | null; tax_invoice_no?: string | null; tax_invoice_at?: string | null;
  buyer_name?: string | null; buyer_tax_id?: string | null; buyer_branch?: string | null; buyer_address?: string | null;
  partner_name?: string | null; seats?: number | null; installment_count?: number;
}

/** One installment printed as its own receipt. */
export interface InstallmentReceipt {
  seq: number; amount: number; amount_received: number | null; paid_at: string | null; receipt_no: string;
  tax_invoice_no: string | null; vat_rate: number | null; status: string;
}

const money = (value: number) => value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const thaiDate = (value: string | null | undefined) => {
  if (!value) return "-";
  const date = new Date(value.includes("T") || value.includes("Z") ? value : value.replace(" ", "T") + "Z");
  return isNaN(date.getTime()) ? value : date.toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" });
};
/** 0105556000009 → 0-1055-56000-00-9 */
const formatTaxId = (id: string | null | undefined) => id && /^\d{13}$/.test(id) ? `${id[0]}-${id.slice(1, 5)}-${id.slice(5, 10)}-${id.slice(10, 12)}-${id[12]}` : id || "-";
const branchLabel = (branch: string | null | undefined) => !branch || branch === "สำนักงานใหญ่" ? "สำนักงานใหญ่" : `สาขาที่ ${branch}`;

/** VAT-inclusive split computed in satang (same rule as the server's utils/tax.ts). */
export function vatSplit(amount: number, rate: number | null | undefined) {
  const total = Math.round((Number(amount) || 0) * 100);
  const r = rate && rate > 0 ? rate : 0;
  const vat = r ? Math.round((total * r) / (100 + r)) : 0;
  return { total: total / 100, base: (total - vat) / 100, vat: vat / 100, rate: r };
}

const cell: React.CSSProperties = { padding: "10px 12px", borderBottom: "1px solid #e2e8f0", fontSize: "13px" };
const page = (orientation: "portrait" | "landscape" = "portrait"): React.CSSProperties => ({
  width: orientation === "portrait" ? "210mm" : "297mm", minHeight: orientation === "portrait" ? "297mm" : "210mm", padding: "18mm", boxSizing: "border-box"
});

const DocHeader: React.FC<{ seller?: SellerProfile | null; title: string; subtitle: string; copy?: string }> = ({ seller, title, subtitle, copy }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "3px solid #e56b25", paddingBottom: "12px", gap: "16px" }}>
    <div style={{ fontSize: "12px", color: "#475569", lineHeight: 1.6 }}>
      <div style={{ fontSize: "22px", fontWeight: 800, color: "#e56b25" }}>NetPrime</div>
      {seller?.company_name ? <div style={{ fontWeight: 700, color: "#0f172a" }}>{seller.company_name}</div> : <div>ศูนย์ฝึกอบรมไอที NetPrime</div>}
      {seller?.address && <div style={{ maxWidth: "95mm" }}>{seller.address}</div>}
      {seller?.tax_id && <div>เลขประจำตัวผู้เสียภาษี {formatTaxId(seller.tax_id)} ({branchLabel(seller.branch)})</div>}
      {seller?.phone && <div>โทร {seller.phone}</div>}
    </div>
    <div style={{ textAlign: "right" }}>
      <div style={{ fontSize: "19px", fontWeight: 800 }}>{title}</div>
      <div style={{ fontSize: "12px", color: "#475569" }}>{subtitle}</div>
      {copy && <div style={{ fontSize: "11px", color: "#64748b", marginTop: "4px" }}>{copy}</div>}
    </div>
  </div>
);

const MetaTable: React.FC<{ rows: [string, React.ReactNode][] }> = ({ rows }) => (
  <table style={{ width: "100%", marginTop: "16px", fontSize: "13px", borderCollapse: "collapse" }}>
    <tbody>
      {rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => (
        <tr key={k}><td style={{ color: "#64748b", width: "32%", padding: "2px 0", verticalAlign: "top" }}>{k}</td><td style={{ padding: "2px 0" }}>{v}</td></tr>
      ))}
    </tbody>
  </table>
);

const VatRows: React.FC<{ amount: number; rate: number | null | undefined }> = ({ amount, rate }) => {
  const v = vatSplit(amount, rate);
  if (!v.rate) return null;
  return (
    <>
      <tr><td style={cell}>มูลค่าสินค้า/บริการ (ก่อนภาษีมูลค่าเพิ่ม)</td><td style={{ ...cell, textAlign: "right" }}>{money(v.base)}</td></tr>
      <tr><td style={cell}>ภาษีมูลค่าเพิ่ม {v.rate}%</td><td style={{ ...cell, textAlign: "right" }}>{money(v.vat)}</td></tr>
    </>
  );
};

/**
 * Receipt, combined with a full tax invoice ("ใบเสร็จรับเงิน/ใบกำกับภาษี") when one was issued, or an
 * abbreviated tax invoice when the school is VAT registered. Prices are VAT inclusive. Pass `installment`
 * to print the receipt of one installment.
 */
export const ReceiptDocument: React.FC<{ order: ReceiptData; seller?: SellerProfile | null; installment?: InstallmentReceipt | null }> = ({ order, seller, installment }) => {
  const receiptNo = installment ? installment.receipt_no : order.receipt_no;
  const taxNo = installment ? installment.tax_invoice_no : order.tax_invoice_no;
  const rate = installment ? installment.vat_rate : order.vat_rate;
  const paid = installment ? installment.amount_received ?? installment.amount : order.amount_received ?? order.amount;
  const discount = Math.max(0, order.list_price - order.amount);
  const title = taxNo ? "ใบเสร็จรับเงิน/ใบกำกับภาษี" : rate ? "ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ" : "ใบเสร็จรับเงิน";
  const subtitle = taxNo ? "Receipt / Tax Invoice" : rate ? "Receipt / Abbreviated Tax Invoice" : "Receipt";
  const item = order.kind === "organization" ? `ค่าอบรมองค์กร: ${order.course_title}${order.seats ? ` (เพิ่ม ${order.seats} ที่นั่ง)` : ""}`
    : order.kind === "bundle" ? `ชุดคอร์ส: ${order.course_title}` : order.kind === "membership" ? `สมาชิก: ${order.course_title}` : `ค่าลงทะเบียนคอร์ส: ${order.course_title}`;
  return (
    <div style={page()}>
      <DocHeader seller={seller} title={title} subtitle={subtitle} copy={taxNo ? "ต้นฉบับ (เอกสารออกเป็นชุด)" : undefined} />
      <MetaTable rows={[
        ["เลขที่ใบเสร็จ", <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{receiptNo}</span>],
        ["เลขที่ใบกำกับภาษี", taxNo ? <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{taxNo}</span> : null],
        ["เลขที่คำสั่งซื้อ", <span style={{ fontFamily: "monospace" }}>{order.reference}</span>],
        ["วันที่ชำระ", thaiDate(installment ? installment.paid_at : order.paid_at)],
        ...(taxNo ? [
          ["ผู้ซื้อ", order.buyer_name],
          ["เลขประจำตัวผู้เสียภาษีผู้ซื้อ", `${formatTaxId(order.buyer_tax_id)} (${branchLabel(order.buyer_branch)})`],
          ["ที่อยู่ผู้ซื้อ", order.buyer_address]
        ] as [string, React.ReactNode][] : [["ได้รับเงินจาก", order.partner_name ? `${order.partner_name} (${order.user_name})` : `${order.user_name} (${order.user_email})`]] as [string, React.ReactNode][])
      ]} />

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "22px" }}>
        <thead>
          <tr style={{ background: "#f1f5f9" }}>
            <th style={{ ...cell, textAlign: "left" }}>รายการ</th>
            <th style={{ ...cell, textAlign: "right", width: "32%" }}>จำนวนเงิน (บาท)</th>
          </tr>
        </thead>
        <tbody>
          {installment ? (
            <>
              <tr><td style={cell}>{item}</td><td style={{ ...cell, textAlign: "right", color: "#64748b" }}>ราคารวม {money(order.amount)}</td></tr>
              <tr><td style={cell}>ชำระงวดที่ {installment.seq}/{order.installment_count ?? "-"}</td><td style={{ ...cell, textAlign: "right" }}>{money(installment.amount)}</td></tr>
            </>
          ) : (
            <>
              <tr><td style={cell}>{item}</td><td style={{ ...cell, textAlign: "right" }}>{money(order.list_price)}</td></tr>
              {discount > 0 && (
                <tr><td style={cell}>ส่วนลด{order.voucher_code ? ` (โค้ด ${order.voucher_code})` : ""}</td><td style={{ ...cell, textAlign: "right" }}>-{money(discount)}</td></tr>
              )}
              <tr><td style={{ ...cell, fontWeight: 700 }}>ยอดสุทธิ (รวมภาษีมูลค่าเพิ่มแล้ว ถ้ามี)</td><td style={{ ...cell, textAlign: "right", fontWeight: 700 }}>{money(order.amount)}</td></tr>
            </>
          )}
          <VatRows amount={paid} rate={rate} />
          <tr><td style={{ ...cell, fontWeight: 700 }}>ยอดที่ได้รับชำระ (โอนเงิน)</td><td style={{ ...cell, textAlign: "right", fontWeight: 800, fontSize: "15px" }}>{money(paid)}</td></tr>
        </tbody>
      </table>

      {(order.status === "refunded" || installment?.status === "refunded") && (
        <p style={{ marginTop: "16px", color: "#dc2626", fontWeight: 700 }}>คำสั่งซื้อนี้ถูกยกเลิก/คืนเงินแล้ว (ดูใบลดหนี้)</p>
      )}
      <div style={{ marginTop: "56px", display: "flex", justifyContent: "flex-end" }}>
        <div style={{ textAlign: "center", fontSize: "12px", color: "#475569" }}>
          <div style={{ borderTop: "1px solid #94a3b8", paddingTop: "2mm", minWidth: "60mm" }}>ผู้รับเงิน</div>
        </div>
      </div>
      <p style={{ marginTop: "24px", fontSize: "11px", color: "#64748b" }}>
        เอกสารนี้ออกโดยระบบหลังเจ้าหน้าที่ยืนยันการโอนเงิน ใช้เป็นหลักฐานการชำระเงินได้
      </p>
    </div>
  );
};

export interface CreditNoteData extends ReceiptData {
  credit_note_no: string; credit_note_at: string | null; credit_note_amount: number | null; staff_note: string | null;
  installments?: InstallmentReceipt[];
}

/** ใบลดหนี้ issued when a tax-invoiced order is refunded (amount VAT inclusive). */
export const CreditNoteDocument: React.FC<{ order: CreditNoteData; seller?: SellerProfile | null }> = ({ order, seller }) => {
  const amount = order.credit_note_amount ?? order.amount_received ?? order.amount;
  const rate = order.vat_rate ?? order.installments?.find(i => i.vat_rate)?.vat_rate ?? 0;
  const invoices = [order.tax_invoice_no, ...(order.installments ?? []).map(i => i.tax_invoice_no)].filter(Boolean).join(", ");
  return (
    <div style={page()}>
      <DocHeader seller={seller} title="ใบลดหนี้" subtitle="Credit Note" />
      <MetaTable rows={[
        ["เลขที่ใบลดหนี้", <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{order.credit_note_no}</span>],
        ["วันที่", thaiDate(order.credit_note_at)],
        ["อ้างถึงใบกำกับภาษี", invoices || "-"],
        ["เลขที่คำสั่งซื้อ", order.reference],
        ["ผู้ซื้อ", order.buyer_name || order.user_name],
        ["เลขประจำตัวผู้เสียภาษีผู้ซื้อ", order.buyer_tax_id ? `${formatTaxId(order.buyer_tax_id)} (${branchLabel(order.buyer_branch)})` : null],
        ["ที่อยู่ผู้ซื้อ", order.buyer_address],
        ["เหตุผล", order.staff_note]
      ]} />
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "22px" }}>
        <thead><tr style={{ background: "#f1f5f9" }}><th style={{ ...cell, textAlign: "left" }}>รายการ</th><th style={{ ...cell, textAlign: "right", width: "32%" }}>จำนวนเงิน (บาท)</th></tr></thead>
        <tbody>
          <tr><td style={cell}>ยกเลิก/คืนเงิน: {order.course_title}</td><td style={{ ...cell, textAlign: "right" }}>{money(amount)}</td></tr>
          <VatRows amount={amount} rate={rate} />
          <tr><td style={{ ...cell, fontWeight: 700 }}>รวมมูลค่าที่ลดหนี้</td><td style={{ ...cell, textAlign: "right", fontWeight: 800 }}>{money(amount)}</td></tr>
        </tbody>
      </table>
    </div>
  );
};

export interface QuoteData {
  quote_no: string; title: string; company_name?: string; tax_id?: string | null; contact_name: string | null; contact_email: string | null;
  buyer_address: string | null; buyer_branch: string | null; seats: number; price: number; valid_until: string; created_at: string;
  note: string | null; status: string; courses: { course_id: string; title: string; price: number }[];
}

/** ใบเสนอราคา for an organization (seats + courses, VAT inclusive total). */
export const QuoteDocument: React.FC<{ quote: QuoteData; seller?: SellerProfile | null }> = ({ quote, seller }) => {
  const rate = seller?.vat_registered ? 7 : 0;
  return (
    <div style={page()}>
      <DocHeader seller={seller} title="ใบเสนอราคา" subtitle="Quotation" />
      <MetaTable rows={[
        ["เลขที่", <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{quote.quote_no}</span>],
        ["วันที่", thaiDate(quote.created_at)],
        ["ยืนราคาถึง", thaiDate(quote.valid_until)],
        ["เสนอ", quote.company_name],
        ["ที่อยู่", quote.buyer_address],
        ["ผู้ติดต่อ", [quote.contact_name, quote.contact_email].filter(Boolean).join(" · ")],
        ["หัวข้อ", quote.title]
      ]} />
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "22px" }}>
        <thead><tr style={{ background: "#f1f5f9" }}><th style={{ ...cell, textAlign: "left" }}>รายการ</th><th style={{ ...cell, textAlign: "right", width: "32%" }}>หมายเหตุ</th></tr></thead>
        <tbody>
          {quote.seats > 0 && <tr><td style={cell}>ที่นั่งผู้เรียนเพิ่ม {quote.seats.toLocaleString("th-TH")} ที่นั่ง</td><td style={{ ...cell, textAlign: "right" }}>-</td></tr>}
          {quote.courses.map(c => (
            <tr key={c.course_id}><td style={cell}>คอร์ส: {c.title}</td><td style={{ ...cell, textAlign: "right", color: "#64748b" }}>ราคาปกติ/คน {money(c.price)}</td></tr>
          ))}
          <VatRows amount={quote.price} rate={rate} />
          <tr><td style={{ ...cell, fontWeight: 700 }}>ราคารวมทั้งสิ้น{rate ? " (รวมภาษีมูลค่าเพิ่มแล้ว)" : ""}</td><td style={{ ...cell, textAlign: "right", fontWeight: 800, fontSize: "15px" }}>{money(quote.price)}</td></tr>
        </tbody>
      </table>
      {quote.note && <p style={{ marginTop: "16px", fontSize: "13px", whiteSpace: "pre-wrap" }}>{quote.note}</p>}
      <p style={{ marginTop: "16px", fontSize: "12px", color: "#475569" }}>ชำระโดยการโอนเงินเข้าบัญชีบริษัทหลังยืนยันใบเสนอราคา เมื่อได้รับชำระ ระบบจะเพิ่มที่นั่งและเปิดคอร์สให้องค์กรทันที</p>
      <div style={{ marginTop: "56px", display: "flex", justifyContent: "space-between", fontSize: "12px", color: "#475569" }}>
        <div style={{ borderTop: "1px solid #94a3b8", paddingTop: "2mm", minWidth: "60mm", textAlign: "center" }}>ผู้เสนอราคา</div>
        <div style={{ borderTop: "1px solid #94a3b8", paddingTop: "2mm", minWidth: "60mm", textAlign: "center" }}>ผู้อนุมัติสั่งซื้อ</div>
      </div>
    </div>
  );
};

export interface CertificateData {
  certificate_code: string; issued_at: string; student_name: string; course_title: string; revoked_at?: string | null;
}

/** Built-in certificate design (fallback when no template is available, and for path certificates). */
export const CertificateDocument: React.FC<{ cert: CertificateData; verifyUrl: string; caption?: string }> = ({ cert, verifyUrl, caption }) => (
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
      <div style={{ fontSize: "15px", color: "#475569", marginTop: "6mm" }}>{caption ?? "ได้เรียนจบและผ่านการประเมินของหลักสูตร"}</div>
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

/**
 * Prints a course certificate with the school's template (website designer). The template loads first,
 * then the PrintPortal opens in the template's orientation; without a template the built-in look is used.
 */
export const CertificatePrint: React.FC<{ cert: CertificateData; verifyUrl: string; courseId?: string | null; onDone: () => void }> = ({ cert, verifyUrl, courseId, onDone }) => {
  const { config, loading } = useCertificateTemplate({ courseId, code: courseId ? null : cert.certificate_code });
  if (loading) return null;
  return (
    <PrintPortal orientation={config?.orientation ?? "landscape"} onDone={onDone}>
      <CertificateTemplate config={config} data={cert} verifyUrl={verifyUrl} />
    </PrintPortal>
  );
};
