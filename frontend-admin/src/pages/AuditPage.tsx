import React from "react";
import { AuditPanel } from "../components/site-admin/ContentPanels";

/** School-wide change history (who changed what, when) — moved out of the website console. */
export const AuditPage: React.FC = () => (
  <div>
    <div className="header-row">
      <div>
        <h1 className="header-title">ประวัติการแก้ไข</h1>
        <p className="header-desc">บันทึกการเปลี่ยนแปลงของเจ้าหน้าที่ทั้งระบบ เช่น รอบอบรม คอร์ส ผู้ใช้ สิทธิ์ และการลบข้อมูลสำคัญ</p>
      </div>
    </div>
    <AuditPanel />
  </div>
);

export default AuditPage;
