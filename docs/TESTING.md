# คู่มือทดสอบและ UAT

## 1. ตรวจอัตโนมัติ

ใช้ Node 22 และ pnpm 10 จาก root ของโครงการ คำสั่งเดียวที่ต้องผ่านก่อน merge/deploy:

```sh
pnpm install --frozen-lockfile
pnpm run check:release
```

`check:release` = `check` (typecheck → unit tests → ทุกชุดในตารางด้านล่าง → build frontend) แล้วตามด้วย `test:readiness` รันทีละชุดได้ด้วย `pnpm run test:<ชื่อชุด>` (smoke ใช้ `pnpm test`)

| ชุด | คำสั่ง | ครอบคลุม |
| --- | --- | --- |
| password, share-meta, notion | `test:password`, `test:share-meta`, `test:notion` | unit test ล้วน (`node --test`) ไม่เปิด Worker: hash รหัสผ่าน, tag แชร์ลิงก์ของ frontend worker, แปลงหน้า Notion |
| smoke | `pnpm test` | health, catalog, fixture login ทุกบทบาท, RBAC, enroll, note isolation, certificate API, logout revocation |
| auth | `test:auth` | สมัคร/login, ห้ามเลือก role เอง, token หมดอายุ, OAuth ปลอมไม่ได้, CORS, no-cache |
| outsource, business, learning | `test:outsource`, `test:business`, `test:learning` | โปรเจกต์ outsource, seat องค์กรพร้อมกัน, เงื่อนไขใบประกาศและสิทธิ์ไฟล์/วิดีโอ |
| site | `test:site` | เว็บไซต์สาธารณะ: รอบอบรม, ลงทะเบียนพร้อมกันไม่เกินที่นั่ง, บทความ, ฟอร์มติดต่อ, ตั้งค่า, export CSV |
| access | `test:access` | บัญชีหลายบทบาท, ตาราง permission, ระงับบัญชี, admin คนสุดท้าย, ขั้นตอนตรวจบทความ, Notion import |
| **accounts** | `test:accounts` | ลืมรหัสผ่าน/ลิงก์ใช้ครั้งเดียว, คำเชิญ, ยืนยันอีเมล, เปลี่ยนรหัสแล้ว sign-out เครื่องอื่น, rate limit login/ลืมรหัส |
| **teaching** | `test:teaching` | upload ต้องมี reservation จาก server, voucher ของผู้สร้าง, กลุ่มผู้เรียนส่วนตัว, คอร์ส draft → review → published |
| **payments** | `test:payments` | ปิดบัตร/webhook เก่า, order + โอนเงิน + สลิป, voucher, ยืนยัน/ปฏิเสธ/คืนเงิน, ใบเสร็จ, ถอน/ออกใบประกาศใหม่ |
| **coordination** | `test:coordination` | ผู้ลงทะเบียนอบรมผูกบัญชี/ได้คอร์ส, cron เตือนล่วงหน้า, เนื้อหาหน้าแรก/หน้า legal, export/ลบข้อมูลส่วนบุคคล (PDPA), revision บทความ |
| **partners** | `test:partners` | HR ตั้งรหัส ≥ 12 ตัวหรือส่งคำเชิญ, ลบพนักงานคืน seat, admin จัดการองค์กร, export CSV กันสูตร |
| readiness | `test:readiness` | เกณฑ์ปล่อยระบบ (AUTH/DATA/PAY/LEARN/ACCESS/HTTP) ต้องผ่านทุกข้อ |

นอกจากนี้ `pnpm run db:init-sql:verify` ตรวจว่า `backend/init.sql` (ใช้สร้างฐานข้อมูล production ใหม่) สร้างจาก `schema.sql` ได้, โครงสร้างตรงกัน, ไม่มีข้อมูลเดโม และรันซ้ำได้ (ใช้ `node:sqlite` ไม่เปิด Worker)

ตรวจ 6 ตุลาคม 2026: `check:release` ผ่าน, smoke 15/15, auth 12/12, outsource 2/2, business 2/2, learning 2/2, readiness 11/11 และ password 3/3 ผล [รายงาน baseline](PROJECT-READINESS.md) เป็นสถานะก่อนแก้ไข ยังต้องทำ UAT และตรวจ provider จริง

`scripts/test-local.mjs` อ่าน `backend/wrangler.local.jsonc` แล้วสร้าง config ใน temporary directory ใช้ main ของโครงการจริง พร้อม mock secrets และ resource ID สำหรับ local เท่านั้น จากนั้นโหลด `schema.sql`, เปิด Worker บน loopback port ว่าง, รัน Node test runner และลบข้อมูลชั่วคราว ไม่ต้อง login Cloudflare และไม่ต้อง reset ฐานข้อมูลที่ทีมใช้อยู่

ถ้าพบ `listen EPERM 127.0.0.1` แปลว่าสภาพแวดล้อมไม่อนุญาตเปิดพอร์ตบนเครื่อง ต้องรันใน terminal ที่อนุญาต local server ไม่ต้องเปลี่ยนเป็น remote

ชุด smoke ครอบคลุม health, catalog, fixture login ทุกบทบาท, wrong password, RBAC, analytics, course detail, duplicate enroll, ปฏิเสธ client progress, note isolation, certificate API, module lists, local AI และ logout revocation

ข้อจำกัด: module lists เป็นเพียงการอ่านรายการ ไม่ใช่การตรวจ workflow ทั้งโมดูล; certificate smoke บันทึกการเรียนและคำตอบผ่าน API จริง; integration mocks ไม่ได้พิสูจน์ว่าบริการภายนอกใช้งานได้

## 2. เปิดระบบสำหรับทดสอบผ่านหน้าเว็บ

```sh
pnpm run db:setup:local
pnpm run dev:backend:local
```

เปิด terminal อีกหน้าต่าง:

```sh
pnpm run dev:frontend:local
```

ใช้ URL ที่ Vite แสดง ส่วน API อยู่ที่ `http://localhost:8787/api` คำสั่ง frontend นี้ override API URL เดิมที่ชี้ไป deployed Worker สำหรับ macOS/Linux shell

ฐานข้อมูลสำหรับ manual testing เก็บอยู่ใน local Wrangler state และคงอยู่เมื่อปิดโปรแกรม การรัน `db:setup:local` อีกครั้งจะ **ล้างข้อมูลทดสอบชุดนั้น** คำสั่ง `db:setup:remote` เดิมถูกลบแล้วเพราะ schema มี DROP TABLE; ฐานข้อมูล remote ใหม่ใช้ `db:init:remote` ดู [CLOUDFLARE-DEPLOY.md หัวข้อ 4](CLOUDFLARE-DEPLOY.md#4-ตั้งค่าฐานข้อมูล-d1)

Local config ไม่มี Workers AI binding และมีเฉพาะ mock integration keys จึงเหมาะกับการทดสอบ flow เดโม ไม่ใช่การตรวจ provider จริง ปุ่มจ่ายเงินจำลองถูกปิด; การซื้อคอร์สต้องรอการเชื่อม tokenization/provider staging

## 3. บัญชี fixture สำหรับ local เท่านั้น

| บทบาท | Email | Password | บริบท |
| --- | --- | --- | --- |
| Admin | admin@netprime.com | admin123 | ระบบทั้งหมด |
| Instructor | instructor@netprime.com | inst123 | เจ้าของคอร์ส seed |
| Company partner | hr@netprime.com | partner123 | Acme |
| B2B student | student1@netprime.com | stud123 | Acme, Workers progress 50% |
| B2B student | student2@netprime.com | stud123 | Acme |
| B2C student | student3@netprime.com | stud123 | Workers จบแล้ว, CCNA ยังไม่จบ |
| University partner | coordinator@mit.edu | univ123 | MIT |
| University student | student_mit@mit.edu | stud123 | MIT |
| Website coordinator | coord@netprime.com | coord123 | เข้าได้เฉพาะเมนูจัดการเว็บไซต์ |

บัญชีและรหัสเหล่านี้มาจาก seed เดโม ห้ามใช้เป็นบัญชี production หน้า login/signup ปัจจุบันใช้รหัสผ่านจริง; OAuth จะเปิดปุ่มเมื่อมี provider config

## 4. UAT checklist หลังแก้ phase B

สถานะเริ่มต้นของทุกข้อด้านล่างคือ **ยังไม่ได้ตรวจผ่านหน้าเว็บ** ให้ใช้ข้อมูลสังเคราะห์และบันทึก Actual/Pass/Fail พร้อมหลักฐาน

| ID | ผู้ทดสอบ / ขั้นตอน | ผลที่ต้องได้ |
| --- | --- | --- |
| U01 | ผู้ใช้ทั่วไป: เปิด catalog, login ถูก/ผิด, refresh, logout | profile และหน้าหลักถูกบทบาท; token ที่ logout แล้วใช้ต่อไม่ได้ |
| U02 | ผู้เรียนใหม่: สมัครบัญชี, พยายามกำหนด role/องค์กรเอง | ได้ student เท่านั้น; เข้าองค์กรได้ผ่านกระบวนการที่อนุมัติ |
| U03 | B2C: เลือกคอร์ส paid, ชำระผ่าน provider test mode | เข้าถึงได้เมื่อ charge ยืนยันสำเร็จเท่านั้น |
| U04 | Payment: failed/cancelled, amount ผิด, event ซ้ำ, สอง event พร้อมกัน | ไม่เปิดสิทธิ์ผิด, ไม่ enroll ซ้ำ, ไม่หัก voucher ซ้ำ |
| U05 | B2B: คอร์สที่องค์กรซื้อ/ไม่ได้ซื้อ/หมดอายุ | เปิดได้เฉพาะ entitlement ที่ยังใช้ได้ |
| U06 | ผู้เรียน: video pause/resume/seek, progress, notes, quiz | บันทึกตรงผู้ใช้; ข้ามการเรียนด้วย request ตรงไม่ได้; quiz ไม่มีเฉลยรั่วก่อนประเมิน |
| U07 | ผู้เรียน: ขอใบประกาศก่อน/หลังผ่านเกณฑ์, ขอซ้ำ | ออกได้หลัง server ตรวจครบ; ไม่มีใบซ้ำ |
| U08 | เปิดลิงก์ใบประกาศในหน้าต่างที่ยังไม่ login | เปิดหน้าตรวจใบประกาศ ไม่เข้า OAuth; URL ใช้ host ของ staging |
| U09 | Instructor: เพิ่ม/แก้/ลบ course, lesson, quiz, upload | ข้อมูลบันทึกและแสดงตรงกัน; upload PUT ผ่าน; อีก instructor แก้ไม่ได้ |
| U10 | Partner: เพิ่ม seat จนเต็ม และเพิ่มพร้อมกันสองคำขอ | ไม่เกิน capacity; duplicate email ไม่เพิ่มตัวนับ; เห็น roster องค์กรตัวเอง |
| U11 | Internship: สมัคร → company approve → daily log → university approve | ข้อมูลและสถานะถูกต้อง; อีกองค์กร/อีกนักศึกษาเข้าถึงไม่ได้ |
| U12 | Outsource: สร้าง project → bid → accept → milestone → approve | ทุกขั้นอ้าง schema จริงและตรวจเจ้าของ; notification ถูกผู้รับ |
| U13 | Admin: analytics, users, partner creation | ยอดตรงฐานข้อมูล; non-admin ถูกปฏิเสธ |
| U14 | OAuth จริง: Google/Microsoft/GitHub ตามที่เปิดใช้งาน | ตรวจ state, audience, verified identity และ redirect; mock payload ใช้แทนตัวตนไม่ได้ |
| U15 | Email/Stream/R2/AI บน staging | บริการจริงทำงาน; failure แสดงชัดเจน ไม่รายงาน mock success เป็นผลจริง |
| U16 | Desktop/mobile, keyboard, เครือข่ายช้า/ขาด, session หมดอายุ | หน้าไม่ค้าง, error/retry ชัดเจน, ไม่มีข้อมูลเก่าจากบัญชีก่อนหน้า |

เพิ่ม fixture instructor อีกคน และ partner อีกองค์กรพร้อม candidate/milestone จริงสำหรับ negative UAT อย่าถือว่าการซ่อนปุ่มใน UI เท่ากับ backend ปฏิเสธสิทธิ์แล้ว

## 5. เกณฑ์ตรวจรับและบันทึกข้อผิดพลาด

ก่อนเริ่ม UAT ที่ใช้ข้อมูลจริง ต้องปิด P0/P1 ที่เกี่ยวข้องและผ่าน `check:release` จากนั้นตรวจ checklist ทุก flow ที่จะเปิดใช้งาน บริการภายนอกใช้ test/staging accounts ก่อนเปิดจริง

แต่ละข้อผิดพลาดให้บันทึก: ID, วันที่, environment, บทบาท, fixture, ขั้นตอนทำซ้ำ, expected, actual, HTTP status, หลักฐาน, ผู้รับผิดชอบ และผล retest หลีกเลี่ยงการเก็บ token/secret ใน screenshot หรือ log ที่แชร์

## 6. CI

`.github/workflows/ci.yml` (GitHub Actions) รันทุก push ไป `main`, ทุก pull request และสั่งเองได้ (workflow_dispatch) บน `ubuntu-latest`:

1. pnpm 10.33 + Node 22 พร้อม cache pnpm store (key จาก `pnpm-lock.yaml`)
2. `pnpm install --frozen-lockfile` (lockfile ไม่ตรง `package.json` = fail ต้องรัน `pnpm install` แล้ว commit lockfile)
3. `pnpm run db:init-sql:verify`
4. `pnpm run check:release`: ทุกชุดใช้ `scripts/test-local.mjs` เปิด Worker จริงบน loopback ด้วย D1/KV/R2 ชั่วคราวและ mock secrets runner ของ GitHub เปิด local port ได้ ไม่ต้องใช้บัญชีหรือ secret ของ Cloudflare (สคริปต์ลบตัวแปร `CLOUDFLARE_*` ออกก่อนรันด้วย)

workflow ไม่มีขั้น deploy (มีตัวอย่าง job deploy แบบสั่งเองเป็นคอมเมนต์ท้ายไฟล์) ตั้ง branch protection ให้ job `check:release` ต้องผ่านก่อน merge ถ้า CI fail ให้ดู log ของชุดที่ fail แล้วรัน `pnpm run test:<ชุด>` บนเครื่องเพื่อทำซ้ำ
