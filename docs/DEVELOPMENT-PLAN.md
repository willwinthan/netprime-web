# แผนพัฒนา Netprime LMS ให้ครบเส้นทาง

เริ่ม 5 ตุลาคม 2026 ตามผลตรวจใน PROJECT-READINESS.md แผนนี้ครอบคลุมฟีเจอร์ที่มีอยู่ในโครงการ ไม่ถือว่าการมีหน้า UI หรือ endpoint เท่ากับฟีเจอร์เสร็จ

## นิยามคำว่าเสร็จ

แต่ละฟีเจอร์ต้องมี UI ใช้งานได้, server validation, สิทธิ์ระดับผู้ใช้/เจ้าของ/องค์กร, persistence, สถานะ error/empty/loading, การทดสอบทั้งสำเร็จและปฏิเสธ, และ UAT ที่ตรวจข้อมูลจริงใน staging ทุกบริการภายนอกต้องแยกผล mock ออกจาก provider จริง

## ลำดับส่งมอบ

| Phase | ขอบเขต | เกณฑ์ตรวจรับ | สถานะ |
| --- | --- | --- | --- |
| B1 | บัญชี: password login/signup, ปิด impersonation, shared session/logout, validation, secrets/CORS, certificate routing | AUTH-01–04/HTTP-01 ผ่าน, login/signup/logout ใช้ผ่าน UI ได้, regression ไม่ถอยหลัง | ผ่าน local; รอ provider/UAT |
| B2 | RBAC/ownership ทุกโมดูล, partner membership/seats, outsource schema และ state transitions | negative tests ข้ามองค์กร/เจ้าของ, DATA-02/ACCESS-01 ผ่าน, จัด seat พร้อมกันไม่เกินจำนวน | outsource/seat ผ่าน local; ต้องตรวจทุกโมดูล |
| B3 | คอร์สฟรี/ซื้อ/องค์กร, voucher, checkout, provider-verified webhook, replay/idempotency, enrollment expiry | PAY-01–02 ผ่าน; paid/failed/refund/replay/concurrency มีผลถูกต้อง | ปิด bypass แล้ว; ยังไม่มี UI จ่ายจริง/refund/UAT |
| B4 | lesson/quiz/video progress, anti-forgery, notes/Q&A, completion/certificate, gamification | LEARN-01 ผ่าน; completion คำนวณบน server; EXP และใบประกาศไม่ซ้ำ | เกณฑ์ใบประกาศผ่าน local; video/quiz/UAT ยังไม่ครบ |
| C1 | OAuth verified identity/linking, password reset/email verification, invitations, session revocation และ rate limiting | provider contract tests + provider staging; ไม่สร้าง/ผูกบัญชีจากข้อมูล client | รอ |
| C2 | instructor course/lesson/quiz/group/voucher/upload ครบวงจร | owner checks, upload validation/limits, storage lifecycle, quiz reporting, CRUD UAT | รอ B2/B4 |
| C3 | company/university: roster/course allocation/analytics, internship และ outsource | workflow สมัคร/อนุมัติ/logs/milestones/notifications ครบ, ข้อมูลแยกองค์กร | รอ B2/B4 |
| C4 | admin provisioning/audit, notification delivery, AI tutor และ AI project helpers | admin actions audit ได้, pagination/filter, AI/notification failure ชัดเจน | รอ B2 |
| D1 | migration, staging environments, CI, backup/restore, logs/monitoring, dependency baseline | migrate จากข้อมูลเดิมโดยไม่ DROP; rollback drill; release checks ผ่าน | รอ B1–C |
| D2 | UI/E2E ทุกบทบาท, accessibility/mobile, bundle split, performance/load | U01–U16 ผ่านพร้อมหลักฐานและข้อจำกัดที่ยอมรับ; ไม่มี P0/P1 ค้าง | รอ D1 |

## งานย่อยที่ต้องรักษาไว้ใน backlog

- บัญชี: password policy, reset token ใช้ครั้งเดียว/หมดอายุ, email verification, verified organization invitations, admin role assignment, rate limiting, identity linking/unlinking, session lifetime
- Learning: catalog/search/pagination, entitlement สำหรับ video/handout/quiz/Q&A ทุกเส้นทาง, resume, server graded attempts, completion policy, certificate verification/share/reissue/revoke
- Commerce: ราคา/ส่วนลดฝั่ง server, voucher expiry/quota/course/issuer scope, exact money units, provider charge IDs, pending/failed/completed/refunded states, fulfillment atomicity
- Instructor: resource ownership, upload size/content validation, presigned URL expiry/path ownership, groups/member isolation, telemetry ถูกต้องจากข้อมูลจริง
- Partner: seat capacity atomicity, user reassignment/removal policy, company vs university scope, assignment/expiry, report export และความเป็นส่วนตัว
- Career: eligibility, duplicate application/bid, state transitions, rejection/acceptance, log approval, milestone resubmit, idempotent EXP, notification ผู้รับครบ
- Operations: แยก seed/migrations, environment secrets, production feature availability, observability โดยไม่บันทึก secrets, audit log, backup/restore, retention policy
- Frontend: shared auth, return-to route, session expiry/error/retry, role landing, responsive layouts, accessible dialogs/forms, pagination, loading/empty state, lazy loaded consoles

## การตัดสินใจและข้อจำกัด

1. Public signup เป็น student เท่านั้น การเป็น instructor/admin/partner และการเข้าองค์กรต้องผ่านผู้มีสิทธิ์
2. ไม่ใช้ mock identity หรือ passwordless quick switch ในหน้าใช้งานจริง ทดสอบ local ด้วยบัญชี fixture และรหัสผ่านจริง
3. ผู้ใช้ยืนยัน completion policy: เรียนครบทุกบทเรียนและตอบแบบทดสอบถูกอย่างน้อย 80% ของคำถามในคอร์ส
4. OAuth/payment/email/Stream/AI จริงต้องมี staging credentials และ domain ที่ผู้ใช้กำหนด งานโค้ดและ provider stubs ทำได้ก่อน; ยังไม่ deploy หรือเรียกเก็บเงินจริง
5. ยังไม่มี Git repository ใน workspace: ต้องจัด source control/remote ก่อนทำ CI และ release history
6. ส่งมอบเป็น phase ที่ตรวจซ้ำได้ รายงานสถานะแยก implemented / locally verified / provider verified / UAT accepted

## Baseline

ก่อนเริ่ม: smoke 15/15 ผ่าน, readiness 0/11 ผ่าน, TypeScript/build ผ่าน

ตรวจวันที่ 6 ตุลาคม 2026: `check:release` ผ่าน; smoke 15/15, auth 12/12, outsource 2/2, business 2/2, learning 2/2, readiness 11/11, password 3/3, TypeScript และ build ผ่าน การผ่าน local gate ยังไม่รับรองการใช้งานจริง โดยเฉพาะ payment tokenization, provider callbacks, OAuth, video evidence, refund, migration staging และ UAT ทุกบทบาท
