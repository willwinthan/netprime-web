import React, { useEffect, useState } from "react";
import { Save, Palette } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { ErrorBox, Empty, Field, grid2 } from "../site-admin/ui";
import { Card, Notice, Toggle, put } from "./shared";

export interface SchoolSettings {
  school_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  support_email: string | null;
  timezone: string;
  default_language: "th" | "en";
  signup: { open: boolean; allowed_domains: string[]; require_email_verification: boolean };
  maintenance: { active: boolean; message: string | null; level: "info" | "warning" };
}

const TIMEZONES = ["Asia/Bangkok", "Asia/Singapore", "Asia/Tokyo", "Asia/Ho_Chi_Minh", "Asia/Jakarta", "Asia/Kolkata", "Europe/London", "UTC"];

/** School identity, contact, timezone/language, sign-up terms and maintenance banner. */
export const SchoolSettingsPanel: React.FC<{ onOpenBranding?: () => void }> = ({ onOpenBranding }) => {
  const api = useApi();
  const [form, setForm] = useState<SchoolSettings | null>(null);
  const [domains, setDomains] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ settings: SchoolSettings }>("/admin/platform/settings")
      .then(data => { setForm(data.settings); setDomains(data.settings.signup.allowed_domains.join(", ")); })
      .catch(err => setError(err.message));
  }, [api.token]);

  if (!form) return <><ErrorBox message={error} /><Empty text="กำลังโหลด…" /></>;
  const set = <K extends keyof SchoolSettings>(key: K, value: SchoolSettings[K]) => { setNotice(null); setForm(prev => ({ ...prev!, [key]: value })); };
  const text = (key: "school_name" | "contact_email" | "contact_phone" | "support_email") =>
    (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value as any);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      setSaving(true);
      setError(null);
      const body = { ...form, signup: { ...form.signup, allowed_domains: domains } };
      const data = await put<{ settings: SchoolSettings; message: string }>(api, "/admin/platform/settings", body);
      setForm(data.settings);
      setDomains(data.settings.signup.allowed_domains.join(", "));
      setNotice(data.message);
    } catch (err: any) { setError(err.message); } finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} style={{ display: "grid", gap: "20px", maxWidth: "880px" }}>
      <ErrorBox message={error} />
      <Notice message={notice} />
      <Card title="ข้อมูลโรงเรียน" description="ชื่อและช่องทางติดต่อที่แสดงในอีเมลและหน้าเว็บ"
        actions={onOpenBranding && <button type="button" className="tech-button-outline" onClick={onOpenBranding}><Palette size={16} />โลโก้ สี และธีม</button>}>
        <div style={grid2}>
          <Field label="ชื่อโรงเรียน *"><input className="form-input" required maxLength={120} value={form.school_name} onChange={text("school_name")} /></Field>
          <Field label="อีเมลติดต่อ"><input className="form-input" type="email" maxLength={254} value={form.contact_email || ""} onChange={text("contact_email")} /></Field>
          <Field label="เบอร์โทร"><input className="form-input" maxLength={40} value={form.contact_phone || ""} onChange={text("contact_phone")} /></Field>
          <Field label="อีเมลฝ่ายช่วยเหลือผู้เรียน" hint="แสดงในหน้าช่วยเหลือและท้ายอีเมล"><input className="form-input" type="email" maxLength={254} value={form.support_email || ""} onChange={text("support_email")} /></Field>
          <Field label="เขตเวลา" hint="ใช้แสดงเวลาเรียนสดและรายงาน">
            <select className="form-input" value={form.timezone} onChange={e => set("timezone", e.target.value)}>
              {[...new Set([form.timezone, ...TIMEZONES])].map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </Field>
          <Field label="ภาษาเริ่มต้น">
            <select className="form-input" value={form.default_language} onChange={e => set("default_language", e.target.value as "th" | "en")}>
              <option value="th">ไทย</option>
              <option value="en">English</option>
            </select>
          </Field>
        </div>
      </Card>

      <Card title="เงื่อนไขการสมัครสมาชิก" description="ใช้กับการสมัครด้วยตนเองบนหน้าเว็บ (ผู้ดูแลยังเพิ่มผู้ใช้ นำเข้า CSV หรือใช้ SSO/API ได้ตามปกติ)">
        <div style={{ display: "grid", gap: "14px" }}>
          <Toggle checked={form.signup.open} onChange={v => set("signup", { ...form.signup, open: v })} label="เปิดให้สมัครสมาชิกด้วยตนเอง" />
          <Field label="โดเมนอีเมลที่อนุญาต" hint="เว้นว่าง = ทุกโดเมน · คั่นด้วยจุลภาค เช่น company.co.th, university.ac.th">
            <input className="form-input" value={domains} onChange={e => { setNotice(null); setDomains(e.target.value); }} placeholder="company.co.th" />
          </Field>
          <Toggle checked={form.signup.require_email_verification} onChange={v => set("signup", { ...form.signup, require_email_verification: v })}
            label="ต้องยืนยันอีเมลก่อนเริ่มเรียน" hint="ผู้เรียนที่ยังไม่ยืนยันอีเมลจะเข้าเรียนสดและบทเรียนที่เปิดใช้การตรวจนี้ไม่ได้ (ผู้สอนและเจ้าหน้าที่ไม่ถูกจำกัด)" />
        </div>
      </Card>

      <Card title="ประกาศปิดปรับปรุงระบบ" description="แถบแจ้งเตือนบนหน้าเว็บและคอนโซล เช่น แจ้งช่วงเวลาปิดปรับปรุง">
        <div style={{ display: "grid", gap: "14px" }}>
          <Toggle checked={form.maintenance.active} onChange={v => set("maintenance", { ...form.maintenance, active: v })} label="แสดงประกาศ" />
          <div style={grid2}>
            <Field label="ข้อความ" span><input className="form-input" maxLength={300} value={form.maintenance.message || ""} onChange={e => set("maintenance", { ...form.maintenance, message: e.target.value })} placeholder="ระบบจะปิดปรับปรุงวันเสาร์ 22:00–23:00 น." /></Field>
            <Field label="ระดับ">
              <select className="form-input" value={form.maintenance.level} onChange={e => set("maintenance", { ...form.maintenance, level: e.target.value as "info" | "warning" })}>
                <option value="info">แจ้งให้ทราบ</option>
                <option value="warning">คำเตือน</option>
              </select>
            </Field>
          </div>
        </div>
      </Card>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="submit" className="tech-button-primary" disabled={saving}><Save size={16} />{saving ? "กำลังบันทึก…" : "บันทึกการตั้งค่า"}</button>
      </div>
    </form>
  );
};
