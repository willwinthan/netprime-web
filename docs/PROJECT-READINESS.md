# รายงานความพร้อม Netprime LMS

ตรวจวันที่ 5 ตุลาคม 2026 จากไฟล์ใน workspace และ Worker ที่รันบนเครื่อง ขอบเขตคือการวิเคราะห์และเตรียมทดสอบ ไม่มีการ deploy หรือแก้ข้อมูลบนระบบจริง

## ข้อสรุป

ระบบมีฟีเจอร์ระดับ prototype ครอบคลุมหลายบทบาท และพร้อมให้ทีมพัฒนาทดสอบบนเครื่องที่แยกข้อมูลแล้ว แต่ **ยังไม่ผ่านเกณฑ์ UAT ที่ใช้ข้อมูลจริงหรือ production** ควรทำ phase “แก้ความถูกต้องและปิดช่องทางเดโม” ก่อนเพิ่มฟีเจอร์

ไม่พบเอกสาร roadmap หรือหมายเลข phase เดิม จึงใช้ชื่อ phase ตามผลลัพธ์แทนการสมมติเลขเฟส

## โครงสร้างและฟีเจอร์

| ส่วน | สิ่งที่มีในโค้ด | ข้อจำกัดที่สำคัญ |
| --- | --- | --- |
| Frontend | React 18, TypeScript, Vite, dashboard แยกผู้เรียน/ผู้สอน/partner/admin และตรวจใบประกาศ | หน้า Dashboard ~4,268 บรรทัด, HR ~2,678, Instructor ~2,872; ยังไม่มี UI/E2E tests |
| API | Hono, 11 router modules, 103 route declarations | มี RBAC แต่สิทธิ์ระดับเจ้าของข้อมูลและองค์กรยังไม่ครบ |
| ฐานข้อมูล | D1/SQLite 26 ตาราง; seed ผู้ใช้ 8, partner 4, course 21, lesson 27, quiz 24 | schema รวม DROP/CREATE/seed; ไม่มีระบบ incremental migration |
| Learning | catalog, enroll, video, quiz, progress, notes, Q&A, certificate | ความคืบหน้าและการออกใบประกาศยังเชื่อข้อมูลจาก client |
| Business | seats, roster, analytics, course assignments | ต้องทดสอบ race condition ของที่นั่งและการแยกองค์กรเพิ่มเติม |
| Instructor | courses, lessons, quizzes, groups, vouchers, uploads, analytics | ตรวจเจ้าของคอร์สไม่สม่ำเสมอ เช่นการเพิ่ม lesson |
| Career | internships, daily logs, approvals, outsource projects/milestones | outsource มี SQL ไม่ตรง schema และสิทธิ์ข้ามองค์กร |
| Integrations | OAuth, Omise, email, Stream/R2, AI | มี mock/fallback หลายจุด; ยังไม่ยืนยันบริการจริง |

## ผลที่รันจริง

| การตรวจ | ผล |
| --- | --- |
| TypeScript backend และ frontend | ผ่าน |
| Frontend production build | ผ่าน; JS หลัก 1,368.83 kB / gzip 287.62 kB พร้อม chunk-size warning |
| schema บน SQLite ในหน่วยความจำ | integrity `ok`, foreign-key violations 0 |
| โหลด schema ลง D1 local ใหม่ | ผ่าน |
| `pnpm test` | ผ่าน 15/15, ไม่ skip |
| `pnpm test:readiness` | ไม่ผ่าน 11/11, ไม่ skip — รายละเอียดด้านล่าง |

การผ่าน smoke ไม่ได้หมายความว่าพร้อม release ชุด readiness ตรวจพฤติกรรมที่ควรเป็น และจงใจไม่ทำ expected-failure หรือ skip เพื่อไม่ซ่อนปัญหา

## ปัญหาที่ทำซ้ำได้บน local Worker

| ระดับ | Test ID | ผลที่พบ | จุดแก้และเงื่อนไขผ่าน |
| --- | --- | --- | --- |
| P0 | AUTH-01 | login บัญชี admin โดยไม่ส่ง password ได้ HTTP 200 | `auth.ts`: บังคับ password และยกเลิก fallback |
| P0 | AUTH-02 | email ใหม่ที่มีคำว่า admin สร้างบัญชีและรับ token ได้จาก login | `auth.ts`: login ต้องไม่สร้างบัญชีหรือเดาบทบาทจาก email |
| P0 | AUTH-03 | public register เลือก role admin ได้ HTTP 201 | `auth.ts`: public signup เป็น student เท่านั้น; บทบาทอื่นผ่านผู้มีสิทธิ์ |
| P0 | AUTH-04 | simulated OAuth profile ใช้ email ของ admin แล้วรับ token ได้ | `auth.ts`: ปิด simulated profile บนสภาพแวดล้อมที่รับผู้ใช้จริง; ต้องพิสูจน์ตัวตนกับ provider |
| P0 | PAY-02 | webhook ที่ไม่ได้ตรวจสอบ ระบุ failed/paid=false/ยอดและสกุลเงินผิด ยังเปิดสิทธิ์เรียน | `student.ts`: ตรวจ charge กับ provider, successful status, amount, currency, ownership และ replay; fulfill ใน transaction |
| P1 | PAY-01 | enroll คอร์สราคา 1,500 โดยตรงได้ HTTP 201 โดยไม่จ่ายเงิน | `courses.ts`: แยก free/sponsored/paid และตรวจ entitlement ก่อน enroll |
| P1 | ACCESS-01 | partner จาก MIT เรียก candidate endpoint ของ project Acme ได้ HTTP 200 | `outsource.ts`: ตรวจ project.partner_id เทียบผู้เรียกก่อนอ่านหรือเปลี่ยนข้อมูล; ทดสอบด้วย candidate จริงเพิ่ม |
| P1 | LEARN-01 | ส่ง progress=100 แล้วออกใบประกาศได้ทันที | `student.ts`: คำนวณ completion ฝั่ง server จากหลักฐานการเรียนและเกณฑ์ quiz ที่ตกลงแล้ว |
| P1 | DATA-01 | OAuth profile ใหม่ได้ HTTP 500 | `auth.ts`: query ใช้ partners.name แต่ schema มี company_name; หลังปิด mock ให้ทดสอบ onboarding ผ่าน provider stub ที่เชื่อถือได้ |
| P1 | DATA-02 | สร้าง outsource project ได้ HTTP 500: no such column user_id | `outsource.ts`: partners ไม่มี user_id; ใช้ user.partner_id และความสัมพันธ์ users → partners; ตรวจเส้นทางแจ้งเตือนด้วย |
| P1 | HTTP-01 | preflight ไม่มี PUT ซึ่ง upload/direct ใช้งาน | `index.ts`: เพิ่ม method ที่ใช้งานจริงและกำหนด origin ที่อนุญาต |

P0 = ต้องแก้ก่อนเปิดรับผู้ใช้จริง; P1 = ต้องแก้ก่อนยอมรับ workflow ที่เกี่ยวข้องใน UAT

## ข้อค้นพบจากการอ่านโค้ดเพิ่มเติม

รายการนี้ยังไม่ได้ยืนยันด้วย browser หรือบริการภายนอกในการตรวจครั้งนี้:

- `backend/wrangler.jsonc` มี JWT secret แบบค่าคงที่ใน config: ย้ายเป็น secret ของแต่ละ environment และหมุน key หากเคยใช้ค่าดังกล่าวกับระบบที่เปิดรับผู้ใช้จริง
- `utils/crypto.ts` ใช้ salted SHA-256 และรองรับ plaintext seed: ต้องมีแผนใช้ password KDF และ migrate บัญชีเดิม โดย seed อยู่ใน local เท่านั้น
- OAuth สร้าง state แต่ไม่ได้ตรวจ callback state; Google token path ไม่ตรวจ audience กับ client ID และการผูก partner ใช้ fuzzy domain matching: ต้องตรวจ identity และใช้ domain mapping ที่ยืนยันแล้ว
- `instructor.ts` เส้นทางเพิ่ม lesson ตรวจว่าคอร์สมีอยู่ แต่ไม่ตรวจว่าเป็นเจ้าของคอร์ส; outsource accept/milestone routes ต้องตรวจ ownership ทุกเส้นทาง
- `App.tsx` มอง certificate code ที่ขึ้นต้น `CERT-` แต่ API ออก `NP-…`; ลิงก์ `/verify-certificates?code=NP-…` จึงถูกตีความเป็น OAuth เมื่อยังไม่ login
- `Dashboard.tsx` ฝัง `http://localhost:5173` ในลิงก์ share certificate; ควรใช้ origin ของหน้าเว็บจริง
- frontend logout ล้าง localStorage แต่ไม่เรียก `/auth/logout`; แม้ API logout ผ่าน smoke แล้ว token จากการกดออกจากหน้าเว็บอาจยังใช้ได้
- `.env` และ `.env.production` เดิมชี้ API ที่ deploy แล้ว: ใช้คำสั่ง `dev:frontend:local` ที่เพิ่มให้สำหรับทดสอบบนเครื่อง
- CORS ใช้ wildcard พร้อม credentials; error handler ส่งรายละเอียด exception; ควรทบทวนให้เหมาะกับ environment
- `schema.sql` เริ่มด้วย DROP TABLE และคำสั่ง remote setup ใช้ไฟล์นี้ตรง ๆ: ต้องแยก bootstrap/seed/migrations ก่อนอัปเกรดข้อมูลจริง
- มี runtime CREATE TABLE อยู่ใน handlers; ควรย้าย schema management ไป migration
- มี Wrangler 4 ที่ root และ 3 ที่ backend รวมทั้ง pnpm lock และ npm lock ใน frontend: เลือกเวอร์ชัน/toolchain ให้เป็นชุดเดียวก่อน CI; ยังไม่ได้ตรวจช่องโหว่ dependency หรือทดสอบติดตั้งใหม่จากศูนย์
- ไม่มี Git metadata ในโฟลเดอร์นี้ จึงยังไม่มี baseline diff, branch หรือ rollback history ให้ตรวจ

## Phase ถัดไปที่แนะนำ

### A — เตรียมการทดสอบ (ทำแล้วในรอบนี้)

เพิ่ม local-only config, คำสั่งตรวจ TypeScript/build, test harness ที่สร้างและลบ D1/KV/R2 ชั่วคราว, smoke 15 รายการ, readiness 11 รายการ, คู่มือ UAT และรายการปัญหา ยังไม่ได้เปลี่ยน business logic เพื่อปิดปัญหาข้างต้น

### B — ปิดช่องทางเดโมและแก้ความถูกต้อง

ทำตามลำดับ: AUTH-01–04 และ secrets → payment/entitlements → ownership ทุกบทบาท → schema mismatch และ upload CORS → completion/certificate และ frontend session

เกณฑ์จบ:

1. `pnpm run check:release` ผ่านทั้งหมดโดยไม่ skip หรือผ่อน assertion เพื่อซ่อนปัญหา
2. เพิ่ม negative tests สำหรับอีกองค์กร/อีก instructor/ผู้ไม่ได้ enroll/expired access/revoked session
3. กำหนดเกณฑ์เรียนจบและ quiz ให้ชัดเจน และตรวจจาก server
4. login ใช้ password จริงได้จาก UI; sandbox switch และ simulated OAuth ไม่เปิดบน environment ที่รับผู้ใช้จริง
5. ทบทวน query ที่อ้าง partners.user_id ทุกจุด และผลข้างเคียงที่เกิดก่อน handler คืน error

### C — Staging และ UAT ครบเส้นทาง

แยก D1/R2/KV/secrets ของ staging, migration พร้อม backup/restore, test account ของ payment และ OAuth, callback allowlist และ domain ที่แน่นอน ใช้ synthetic data จนกว่าปัญหา P0/P1 ที่เกี่ยวข้องจะปิด

เกณฑ์จบ: UAT ตาม TESTING.md ผ่านทุกบทบาท, payment success/failure/replay ผ่าน, upload/video/handout ใช้งานจริง, ใบประกาศเปิดแบบ logged-out ได้, ไม่มีข้อมูลข้ามองค์กร และมีบันทึกผล/ผู้ตรวจรับ

### D — ปรับ UX/ประสิทธิภาพและขยายฟีเจอร์

แบ่งหน้าขนาดใหญ่เป็นส่วนย่อย, lazy-load console, แยก shared auth state, เพิ่ม pagination และ loading/error states, ทดสอบมือถือ/คีย์บอร์ด แล้วค่อยเพิ่มฟีเจอร์ใหม่ตาม priority ธุรกิจ

เกณฑ์จบ: วัด bundle และเวลาเปิดหน้าจาก staging เทียบ baseline, ไม่ทำให้ชุดทดสอบเดิมถอยหลัง และมี monitoring/error reporting พร้อมแนวทาง rollback

## ขอบเขตที่ยังไม่ยืนยัน

ยังไม่ได้ทดสอบ browser E2E, accessibility, concurrency/load, production deployment, OAuth provider จริง, การจ่ายเงินจริง/ระบบทดสอบของผู้ให้บริการ, ส่งอีเมลจริง, Stream playback หรือ Workers AI จริง รายงานนี้ไม่ใช่การรับรองความปลอดภัยครบทุกเส้นทาง
