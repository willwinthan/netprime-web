# ระบบยังไม่สมบูรณ์อย่างไร และต้องทำอะไรก่อนเปิดใช้งาน

ตรวจ 24 ตุลาคม 2026 จากการอ่านโค้ดและรัน `pnpm run check:release` (ผ่านทั้งหมดบนเครื่อง) ต่อจาก [DEVELOPMENT-PLAN.md](DEVELOPMENT-PLAN.md)

## สรุปสั้น

**อัปเดต 24 ต.ค. 2026 (รอบปิดงานก่อน go-live):** ปิด P0 ที่เป็นโค้ดครบแล้ว และทำ workflow ที่ขาดของทุกบทบาท (ตารางสถานะด้านล่าง) `pnpm run check:release` ผ่าน 16 ชุดเทสต์ รวม 122 เทสต์ สิ่งที่เหลือเป็นงานตั้งค่าและทดสอบกับบริการจริง ซึ่งต้องทำบน staging:

1. สร้าง staging + ใส่ secrets/vars (`APP_URL`, `EMAIL_FROM`, Resend domain, Stream) ตาม runbook ใน [CLOUDFLARE-DEPLOY.md](CLOUDFLARE-DEPLOY.md) §14
2. ทดสอบกับบริการจริง: อีเมล (ลืมรหัสผ่าน, คำเชิญ, เตือนก่อนอบรม), Stream (เล่นวิดีโอแบบ signed URL, อัปโหลดไฟล์ใหญ่), Notion import, OAuth
3. ฝ่ายกฎหมายตรวจหน้า นโยบายความเป็นส่วนตัว / เงื่อนไข / นโยบายคืนเงิน (ตอนนี้เป็นร่าง)
4. ใส่บัญชีรับโอนจริงในหน้า "คำสั่งซื้อ" → บัญชีรับโอน และ UAT ตาม workflow ของแต่ละบทบาท
5. สร้าง GitHub repo, commit, push และเปิด CI

การชำระเงินออนไลน์ (Omise) **ปิดไว้ตามที่ตัดสินใจ** ใช้การโอนแล้วให้เจ้าหน้าที่ยืนยันแทน

### สถานะงานรอบนี้

| เรื่อง | สถานะ |
| --- | --- |
| P0 #1 ชำระเงิน | ✅ เปลี่ยนเป็นคำสั่งซื้อ + โอน + แนบสลิป + เจ้าหน้าที่ยืนยัน/ปฏิเสธ/คืนเงิน + ใบเสร็จ (ปิด Omise) |
| P0 #2 upload เขียนทับไฟล์ | ✅ presign เก็บใน KV, ตรวจเจ้าของ/ชนิด/ขนาด, key อยู่ใต้ prefix ของผู้ใช้ |
| P0 #3 voucher | ✅ มีเจ้าของ, จำกัดจำนวนครั้ง, ผูกคอร์สของตัวเอง |
| P0 #4 กลุ่มผู้เรียน | ✅ มีเจ้าของ, กรองทุก query |
| P0 #5 schema production | ✅ `pnpm run db:init-sql` สร้าง init.sql ไม่มี DROP/ข้อมูลเดโม + ทำเครื่องหมาย migration |
| P0 #6 จัดการผู้ใช้ | ✅ (รอบก่อน) + หลายบทบาทต่อบัญชี |
| P0 #7 ลืมรหัสผ่าน/ยืนยันอีเมล/คำเชิญ | ✅ ลิงก์ใช้ครั้งเดียว (เก็บ hash), HR ใช้คำเชิญ, รหัสขั้นต่ำ 12 ตัว |
| P0 #8 rate limit | ✅ login/สมัคร/ลืมรหัส/ยืนยัน (KV) — แนะนำเพิ่ม WAF rule บน production |
| P0 #9 Git/CI/backup | ✅ git init, GitHub Actions, `scripts/backup-d1.sh`, Time Travel — ⏳ ยังไม่ได้ push/รัน CI จริง |
| ลิงก์อีเมล localhost / HTML ไม่ escape | ✅ ใช้ `APP_URL`, escape ทุกค่า, ผู้ส่งตั้งได้ด้วย `EMAIL_FROM` |
| Code sandbox | ✅ ย้ายไป iframe sandbox + CSP + timeout |
| Stream fallback key | ✅ ไม่มี key → 503, ลงลายเซ็น RS256 ถูกตามเอกสาร, อัปโหลดตรงไป Stream (tus) — ⏳ ยังไม่ได้ทดสอบกับบัญชีจริง |
| ใบประกาศ | ✅ พิมพ์/บันทึก PDF, เพิกถอน/ออกใหม่, หน้าตรวจสอบแสดงสถานะเพิกถอน |
| คอร์สต้องอนุมัติก่อนเผยแพร่ | ✅ ร่าง → ส่งตรวจ → อนุมัติ/ส่งกลับ/เก็บถาวร |
| HR นำพนักงานออก/ย้ายองค์กร/export | ✅ คืนที่นั่ง, พักสิทธิ์คอร์สที่องค์กรสนับสนุน, CSV |
| องค์กรประเภทมหาวิทยาลัย/แก้ที่นั่ง | ✅ |
| ผู้สมัครรอบอบรม ↔ บัญชี | ✅ ผูกด้วยอีเมล, เปิดคอร์สออนไลน์ที่ผูกไว้, ส่งคำเชิญ |
| อีเมลเตือนก่อนอบรม | ✅ cron ทุกวัน 08:00 (เตือนก่อน 2 วัน) |
| เนื้อหาหน้าแรก (แบรนด์/บริการ/FAQ) | ✅ แก้ได้ในจัดการเว็บไซต์ |
| PDPA | ✅ หน้านโยบาย (ร่าง), ดาวน์โหลดข้อมูลของฉัน, คำขอลบบัญชี + หน้าดำเนินการของ admin — ⏳ ให้ฝ่ายกฎหมายตรวจข้อความ |
| ประวัติการแก้ไขบทความ/ชนกัน | ✅ เก็บ 30 ฉบับ, กู้คืน, แจ้งเมื่อมีคนแก้ทับ |
| Monitoring | ✅ Workers Logs + คู่มือแจ้งเตือน — ⏳ ยังไม่ได้ตั้งค่าบน dashboard |

ส่วนด้านล่างคือรายงานต้นฉบับก่อนแก้ เก็บไว้อ้างอิง

## P0 — ต้องแก้ก่อนเปิดรับผู้ใช้จริง

| # | ปัญหา | ตำแหน่ง | สิ่งที่ต้องทำ |
| --- | --- | --- | --- |
| 1 | หน้า checkout รับเลขบัตร/CVC เข้ามาใน state ของ React แล้วเรียก `/student/checkout/session` โดยไม่มี `omise_token` → API ตอบ 400 ทุกครั้ง และเสี่ยงผิดมาตรฐาน PCI | `Dashboard.tsx` `handleProcessCheckout` (~บรรทัด 694) | ใช้ Omise.js / Omise Checkout สร้าง token ฝั่ง browser ส่งเฉพาะ token ไม่รับเลขบัตรเอง เพิ่ม `VITE_OMISE_PUBLIC_KEY`, รองรับ 3-D Secure (`authorize_uri`) และ PromptPay, หน้าแสดงผลสำเร็จ/ล้มเหลว |
| 2 | `PUT /instructor/upload/direct` รับ `key` จาก query โดยไม่ตรวจว่าออกจาก presign จริง ไม่ตรวจขนาด/ชนิด → instructor ใดก็เขียนทับไฟล์ใดใน R2 ได้ | `instructor.ts` ~บรรทัด 1094 | เก็บ presign ใน KV (key, ผู้ขอ, ขนาด, mime, หมดอายุ 15 นาที) แล้วตรวจตอน PUT หรือใช้ R2 presigned URL (S3 API) ตรวจ `Content-Length` |
| 3 | Voucher: ลบ voucher ของคนอื่นได้ และสร้าง voucher ให้คอร์สที่ไม่ใช่ของตัวเองได้ ไม่มีจำกัดจำนวนครั้ง | `instructor.ts` `/instructor/vouchers*` | เพิ่ม `created_by`, `max_uses`, `used_count`; ตรวจเจ้าของคอร์ส; นับการใช้ใน webhook เดียวกับ fulfil |
| 4 | Student groups ไม่มีคอลัมน์เจ้าของ → instructor ทุกคนเห็น/ลบ/แก้กลุ่มของกันและกัน | `schema.sql` `student_groups`, `instructor.ts` | เพิ่ม `instructor_id` + migration, กรองทุก query |
| 5 | ไม่มี schema สำหรับสร้างฐานข้อมูล production ใหม่ — `schema.sql` มี `DROP TABLE` + บัญชีเดโมรหัสผ่าน plaintext; migration 0001–0004 สมมติว่ามีฐานข้อมูลเดิม | `backend/schema.sql`, `backend/migrations/` | แยกเป็น `migrations/0000_init.sql` (CREATE อย่างเดียว), `seed/demo.sql` (local เท่านั้น), ใช้ `wrangler d1 migrations apply`; ลบ/เปลี่ยนชื่อสคริปต์ `db:setup:remote` |
| 6 | ~~ไม่มีหน้า/endpoint ให้ admin สร้างผู้ใช้หรือเปลี่ยน role~~ **เสร็จแล้ว (24 ต.ค. 2026)** | `accounts.ts`, `UsersPage.tsx` | สร้างผู้ใช้ทุก role, เปลี่ยน role/องค์กร, ระงับบัญชี, ตั้งรหัสผ่านใหม่, ออกจากระบบทุกอุปกรณ์, ตารางสิทธิ์ต่อ role, audit log · เหลือ: เลือก `partner_type=university` ตอนสร้างองค์กร |
| 7 | ลืมรหัสผ่าน / ยืนยันอีเมล ไม่มี; HR ตั้งรหัสผ่านให้พนักงานเองแล้วต้องบอกต่อ (ขั้นต่ำ 8 ตัว ขณะที่ signup 12 ตัว) | `auth.ts`, `business.ts` | reset token ใช้ครั้งเดียว อายุสั้น (เก็บ hash ใน D1/KV), email verification, ส่งอีเมลเชิญให้ตั้งรหัสผ่านเอง |
| 8 | ไม่มี rate limiting ที่ login/register/AI/webhook | ทุก router | Cloudflare WAF Rate Limiting rules หรือ Workers Rate Limiting binding; Turnstile ที่ signup/login |
| 9 | ไม่มี Git repository, CI, backup | ทั้งโปรเจกต์ | `git init` + remote, GitHub Actions รัน `check:release`, D1 Time Travel/export ก่อน migrate |

## P1 — ต้องทำเพื่อให้ workflow ใช้งานได้ครบใน UAT

**บัญชีและ session**
- JWT เก็บใน `localStorage` อายุ 24 ชม. ไม่มี refresh token → ถูกขโมยได้ถ้ามี XSS; พิจารณา cookie `HttpOnly; Secure; SameSite` หรือ token อายุสั้น + refresh
- OAuth: Microsoft ยังปิด; ยังไม่มี UI ผูก/ยกเลิกผูกบัญชี (email ซ้ำจะได้ `ACCOUNT_LINK_REQUIRED`)

**การเรียนและเนื้อหา**
- Cloudflare Stream: ยังไม่ได้ทดสอบ signed URL จริง; `courses.ts` ~บรรทัด 305 มี fallback key `fallback-mock-key-…` ถ้าไม่มี secret ควรตอบ error แทน
- Upload วิดีโอผ่าน Worker จำกัด 500 MB ในโค้ด แต่ **Workers รับ request body ได้ 100 MB (Free/Pro)** → วิดีโอใหญ่ต้องอัปโหลดตรงไป Stream (Direct Creator Upload) หรือ R2 multipart
- Refund / ยกเลิกสิทธิ์ / หน้าประวัติการชำระเงิน / ใบเสร็จ ยังไม่มี
- ใบประกาศ: ยังไม่มี PDF ที่ดาวน์โหลดได้, revoke/reissue; อีเมลอ้างว่า "registered on the blockchain ledger" ซึ่งไม่จริง ต้องแก้ข้อความ
- Code sandbox ใน Dashboard ใช้ `new Function()` รันโค้ดใน origin หลัก → ย้ายไป sandboxed iframe/Web Worker และให้ EXP จาก server

**องค์กรและอาชีพ**
- Partner: ยังไม่มีการย้าย/ลบพนักงานและคืน seat, export รายงาน
- Internship/Outsource: ทดสอบอัตโนมัติมีเพียง 2 เคสต่อโมดูล ต้องเพิ่ม negative test ข้ามองค์กร, การ resubmit milestone, การแจ้งเตือนผู้รับ
- AI scope/audit ใน outsource คืน "fallback mock" เมื่อ AI ล้มเหลว — ต้องแสดงว่าเป็นผลสำรอง ไม่ใช่ผลจริง

**อีเมล**
- ลิงก์ในอีเมลฝัง `http://localhost:5173/dashboard` (`utils/email.ts`) → ใช้ตัวแปร `APP_URL`
- ผู้ส่ง `noreply@netprime-lms.com` ต้อง verify domain ที่ Resend (SPF/DKIM) หรือเปลี่ยนไปใช้ Cloudflare Email Service
- อีเมลล้มเหลวถูก log เงียบ ๆ ควรมี retry (Cloudflare Queues)
- HTML ในอีเมลแทรก `name`/`courseTitle` โดยไม่ escape

**Admin และการดูแลระบบ**
- รายการผู้ใช้/คอร์สส่วนใหญ่ไม่มี pagination/search (พบ `LIMIT` เพียง 7 จุด) จะช้าเมื่อข้อมูลโต
- ไม่มี audit log, ไม่มีหน้าจัดการคอร์สทั้งหมด/อนุมัติคอร์ส
- Observability: เปิด Workers Logs, เพิ่ม error tracking (เช่น Sentry) โดยไม่ log secret/token
- error message บางจุดส่ง `err.message` กลับไป client (เช่น upload) ควรซ่อน

**ภาษาไทย**
- 24 ต.ค. 2026: แปล UI ทุกหน้า, ข้อความ error ของ API, อีเมล, การแจ้งเตือน, ชื่อเลเวล, ข้อความของ AI และข้อมูลตัวอย่างเป็นภาษาไทยแล้ว ราคาแสดงเป็นบาท (฿) และวันที่ใช้ locale `th-TH`
- ข้อจำกัด: แปลโดยตรงในโค้ด **ไม่มีปุ่มสลับ EN/ไทย** ถ้าต้องการสองภาษาในอนาคตต้องแยกข้อความเป็นไฟล์แปล (เช่น `react-i18next`) ชื่อคอร์สและศัพท์เทคนิคคงเป็นอังกฤษโดยตั้งใจ
- ควรให้เจ้าของเนื้อหาอ่านทวนข้อความการตลาดบนหน้าแรกและ FAQ ก่อนเปิดจริง

**กฎหมาย/นโยบาย (ประเทศไทย)**
- PDPA: นโยบายความเป็นส่วนตัว, ขอความยินยอม, ให้ผู้ใช้ขอดู/ลบข้อมูล, retention policy
- เงื่อนไขการใช้งาน, นโยบายคืนเงิน, ใบกำกับภาษี (ถ้าจดภาษีมูลค่าเพิ่ม)

## P2 — ปรับปรุงหลังเปิดใช้งาน

- แตกหน้าใหญ่ (`Dashboard.tsx` 4,177 บรรทัด, `InstructorConsole.tsx`, `HRConsole.tsx`) เป็น component ย่อย + lazy load ต่อ role; bundle ปัจจุบัน 1.37 MB และรูป hero 811 kB (แปลงเป็น WebP)
- เพิ่ม URL routing (เช่น React Router) ให้ refresh/แชร์ลิงก์ไปหน้าคอร์สได้
- E2E test (Playwright) ทุกบทบาท, accessibility, มือถือ
- รวม toolchain: Wrangler 4 ที่ root vs 3 ที่ backend, ลบ `frontend-admin/package-lock.json` (ใช้ pnpm อย่างเดียว), อัปเดต `compatibility_date` (ตอนนี้ 2024-05-24)
- ราคาเก็บเป็น `REAL` → เปลี่ยนเป็นจำนวนเต็มหน่วยสตางค์
- ตรวจคะแนน quiz: ปัจจุบันเก็บคำตอบล่าสุดต่อข้อ ตอบซ้ำได้ไม่จำกัด → กำหนดจำนวนครั้ง/เวลารอ
- ประกาศ, ปฏิทิน, การบ้าน/ส่งงาน, discussion ระดับคอร์ส, รีวิวคอร์ส, รายงาน analytics เชิงลึก (ฟีเจอร์ LMS ทั่วไปที่ยังไม่มี)

## Checklist ก่อนเปิดใช้งาน (Go-live)

- [ ] ปิด P0 ทั้ง 9 ข้อ พร้อม negative tests
- [ ] `pnpm run check:release` ผ่านใน CI
- [ ] Staging แยก (D1/R2/KV/secrets/domain) และ migrate จากศูนย์ได้โดยไม่มี seed เดโม
- [ ] Omise test mode: สำเร็จ / ล้มเหลว / 3DS / webhook ซ้ำ / สองคำขอพร้อมกัน
- [ ] OAuth Google/GitHub จริงบน domain staging
- [ ] อีเมลถึงกล่องจริง (ไม่เข้า spam), ลิงก์ใช้ domain จริง
- [ ] Stream/R2 เล่นวิดีโอและดาวน์โหลด handout ได้จริง
- [ ] UAT U01–U16 ตาม [TESTING.md](TESTING.md) มีผู้ลงนามรับ
- [ ] นโยบาย PDPA / เงื่อนไข / คืนเงิน เผยแพร่แล้ว
- [ ] สร้างบัญชี admin จริงด้วยรหัสผ่านใหม่, ไม่มีบัญชีเดโมใน production
- [ ] Backup + ทดสอบ restore, monitoring/alert, แผน rollback

## ประมาณการงาน (สำหรับนักพัฒนา 1–2 คน)

| ช่วง | งาน | ระยะเวลาโดยประมาณ |
| --- | --- | --- |
| 1 | Git/CI, schema init/seed แยก, P0 #2–#4, #8 | 1–1.5 สัปดาห์ |
| 2 | Omise tokenization + 3DS/PromptPay + หน้าผลชำระเงิน (P0 #1) | 1 สัปดาห์ |
| 3 | Admin user management, invite, reset password, email verification (P0 #6–#7) | 1–1.5 สัปดาห์ |
| 4 | Staging + provider จริง (Stream, Resend, OAuth) + แก้อีเมล | 1 สัปดาห์ |
| 5 | PDPA, UAT, ทวนข้อความภาษาไทย, แก้ bug | 1–1.5 สัปดาห์ |

รวมประมาณ 6–8 สัปดาห์ถึง go-live (ไม่รวม P2) ตัวเลขนี้เป็นการประเมินจากขนาดโค้ด ควรทบทวนหลังเริ่มงานช่วงแรก
