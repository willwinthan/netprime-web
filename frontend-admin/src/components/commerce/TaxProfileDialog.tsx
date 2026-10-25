import React, { useEffect, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { Empty, ErrorBox, Field, Modal, grid2 } from "../site-admin/ui";
import { isValidThaiTaxId } from "../learner/CourseOrder";
import { SellerProfile } from "../learner/PrintView";

/** School tax settings for receipts / tax invoices (payments.manage). Prices are VAT 7% inclusive when registered. */
export const TaxProfileDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const api = useApi();
  const [values, setValues] = useState<SellerProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.get<{ profile: SellerProfile }>("/manage/tax-profile").then(d => setValues(d.profile)).catch(err => setError(err.message)); }, []);
  const set = (key: keyof SellerProfile) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setSaved(false);
    setValues(v => v && { ...v, [key]: e.target.value });
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!values) return;
    try {
      setBusy(true);
      setError(null);
      const res = await api.request<{ profile: SellerProfile }>("/manage/tax-profile", { method: "PUT", body: JSON.stringify(values) });
      setValues(res.profile);
      setSaved(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const idOk = !values?.tax_id || isValidThaiTaxId(values.tax_id);

  return (
    <Modal title="ข้อมูลภาษีของโรงเรียน (ใบกำกับภาษี)" onClose={onClose}>
      <ErrorBox message={error} />
      {!values ? <Empty text="กำลังโหลด…" /> : (
        <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={grid2}>
            <Field label="ชื่อผู้ประกอบการ" span><input className="form-input" value={values.company_name} onChange={set("company_name")} maxLength={200} /></Field>
            <Field label="เลขประจำตัวผู้เสียภาษี (13 หลัก)" hint={idOk ? undefined : "เลขไม่ถูกต้อง (ตรวจสอบหลักสุดท้าย)"}>
              <input className="form-input" value={values.tax_id} onChange={set("tax_id")} maxLength={17} inputMode="numeric" />
            </Field>
            <Field label="สาขา" hint="สำนักงานใหญ่ หรือเลขสาขา 5 หลัก"><input className="form-input" value={values.branch} onChange={set("branch")} maxLength={50} /></Field>
            <Field label="ที่อยู่" span><textarea className="form-input" rows={2} value={values.address} onChange={set("address")} maxLength={500} /></Field>
            <Field label="โทรศัพท์"><input className="form-input" value={values.phone ?? ""} onChange={set("phone")} maxLength={50} /></Field>
          </div>
          <label style={{ display: "flex", gap: "8px", alignItems: "center", fontWeight: 600 }}>
            <input type="checkbox" checked={values.vat_registered} onChange={e => { setSaved(false); setValues({ ...values, vat_registered: e.target.checked }); }} />
            จดทะเบียนภาษีมูลค่าเพิ่ม (ราคารวม VAT 7% แล้ว)
          </label>
          <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            เมื่อเปิดใช้ ใบเสร็จทุกใบจะแสดงมูลค่าก่อนภาษีและภาษีมูลค่าเพิ่ม และผู้ซื้อที่ขอใบกำกับภาษีเต็มรูปจะได้เลขที่ใบกำกับภาษี (TI-ปี-ลำดับ) แยกจากเลขใบเสร็จ
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", alignItems: "center" }}>
            {saved && <span style={{ color: "var(--accent)", fontSize: "13px" }}>บันทึกแล้ว</span>}
            <button type="button" className="tech-button-outline" onClick={onClose}>ปิด</button>
            <button type="submit" className="tech-button-primary" disabled={busy || !idOk}>{busy ? "กำลังบันทึก…" : "บันทึก"}</button>
          </div>
        </form>
      )}
    </Modal>
  );
};

export default TaxProfileDialog;
