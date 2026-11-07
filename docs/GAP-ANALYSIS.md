# งานที่เหลือก่อนเปิดใช้งานจริง

ตรวจ 7 พฤศจิกายน 2026 จากโค้ดใน `main` และค่าที่ตั้งจริงบน Cloudflare/GitHub (อ่านอย่างเดียว) ฉบับก่อนหน้า (24 ต.ค. 2026) ดูได้ใน git history ของไฟล์นี้

## สรุปสั้น

- **โค้ด:** ปิด P0 ครบทั้ง 9 ข้อ และ P1 ส่วนใหญ่แล้ว `pnpm run check:release` ผ่าน 29 ชุดเทสต์ (283 เทสต์) และ CI deploy ขึ้น staging ให้เองทุกครั้งที่ merge เข้า `main`
- **Staging:** ใช้งานได้ แต่ยังไม่ได้ต่อบริการจริงเลย มี secret แค่ `JWT_SECRET` อีเมลจึงถูก log ไว้เฉยๆ ส่วนอัปโหลดวิดีโอเข้า Stream, OAuth และ Turnstile ยังใช้ไม่ได้
- **Production:** **ยังไม่ได้สร้าง** บัญชี Cloudflare ยังไม่มี Worker `netprime-backend` และไม่มีฐานข้อมูล D1 ของ production (มีแค่ `netprime-db-staging`) แม้ `wrangler.jsonc` จะมี ID ใส่ไว้แล้วก็ตาม
- **งานที่เหลือส่วนใหญ่ไม่ใช่โค้ด** แต่เป็นงานตั้งค่าบริการจริง เตรียมเนื้อหา ตรวจข้อความทางกฎหมาย และ UAT

การชำระเงินออนไลน์ (Omise) **ปิดไว้ตามที่ตัดสินใจ** ใช้การโอนเงินแล้วให้เจ้าหน้าที่ยืนยันแทน (endpoint บัตรตอบ 410)

## 1. งานตั้งค่าที่ทีมต้องทำ (ใช้บัญชีของทีม)

| # | งาน | สถานะ | หมายเหตุ |
| --- | --- | --- | --- |
| 1 | **อีเมล:** สมัคร Resend, เพิ่ม DNS record (SPF/DKIM) ของโดเมนผู้ส่งที่ Hostatom, ตั้ง `RESEND_API_KEY` และ `EMAIL_FROM` | ⏳ รอ DNS | ไม่ต้องย้าย DNS แค่เพิ่ม record แนะนำโดเมนย่อย เช่น `mail.plantecplus.com` |
| 2 | **สร้าง production:** D1, R2, KV, Worker ทั้งสองตัว, secrets และ vars | ❌ ยังไม่เริ่ม | ทำตาม [CLOUDFLARE-DEPLOY.md](CLOUDFLARE-DEPLOY.md) ใช้ `pnpm run db:init:remote` กับฐานข้อมูลใหม่ ห้ามใช้ `schema.sql` |
| 3 | **โดเมนจริง** ของเว็บและ API แล้วตั้ง `APP_URL`, `FRONTEND_ORIGINS`, `VITE_API_BASE_URL` และ `SELF_LEARNING_ORIGIN` | ❌ | ลิงก์ในอีเมลและหน้าแชร์ใช้ค่าเหล่านี้ |
| 4 | **Cloudflare Stream:** ตั้ง secrets ถ้าจะให้ผู้สอนอัปโหลดวิดีโอเข้าระบบ | ❌ | ถ้าใช้ YouTube/Vimeo อย่างเดียว ข้ามข้อนี้ได้ |
| 5 | **OAuth** (Google/GitHub/Microsoft) และ **Turnstile** | ❌ ไม่บังคับ | โค้ดรองรับครบแล้ว ขาดแค่ client ID/secret |
| 6 | **บัญชีรับโอน** ในหน้า "คำสั่งซื้อและการชำระเงิน" → บัญชีรับโอน | ⏳ ให้ตรวจว่าตั้งแล้ว | ผู้เรียนต้องเห็นเลขบัญชีจริงตอนสั่งซื้อ |
| 7 | **บัญชี admin จริง** บน production ด้วยรหัสผ่านใหม่ | ❌ | ห้ามมีบัญชีเดโมบน production (`init.sql` ไม่มีให้อยู่แล้ว) |
| 8 | **Branch protection** ของ `main` ให้ต้องผ่าน CI ก่อน merge | ❌ | ตอนนี้ยังไม่ได้ตั้ง เคย merge ก่อน CI จบมาแล้วครั้งหนึ่ง |
| 9 | **Monitoring:** ตั้งการแจ้งเตือน error บน Cloudflare dashboard | ⏳ ให้ยืนยัน | คู่มืออยู่ใน CLOUDFLARE-DEPLOY.md |
| 10 | **Backup:** ลองกู้ข้อมูลจาก `pnpm run db:backup` หรือ Time Travel จริงหนึ่งครั้ง | ⏳ ให้ยืนยัน | ทำก่อนลง migration ครั้งแรกบน production |
| 11 | **Vimeo:** วิดีโอคอร์สทุกตัวตั้งเป็น **Embed only** และอนุญาตให้ฝังได้เฉพาะโดเมนของเรา | ⏳ ใช้กับวิดีโอใหม่แล้ว | ดู[มาตรฐานวิดีโอ Vimeo](#มาตรฐานวิดีโอ-vimeo) ด้านล่าง |

### มาตรฐานวิดีโอ Vimeo

ตกลงกันวันที่ 7 พ.ย. 2026: วิดีโอคอร์สทุกตัวใช้ **Embed only** (Privacy) ไม่ใช้ Unlisted, Private หรือ Password

- **ทำไม:** Embed only เปิดดูบน vimeo.com ไม่ได้ เล่นได้เฉพาะตอนฝังอยู่บนโดเมนที่อนุญาต ถึงลิงก์หลุดไปก็ดูข้างนอกไม่ได้ ส่วน Unlisted ใครมีลิงก์ก็ดูได้ และ Private หรือ Password ผู้เรียนดูไม่ได้หรือต้องพิมพ์รหัสเอง
- **ลิงก์ที่ใช้ในบทเรียน:** วางลิงก์จากปุ่ม Copy link ได้เลย เช่น `https://vimeo.com/1244655657` วิดีโอ Embed only ไม่มีรหัส `h=` ต่อท้าย ตัวเล่นใช้แค่เลข ID
- **โดเมนที่อนุญาต:** ใส่ในช่องโดเมน**ตอนอัปโหลด**
  - `www.netprimetraining.com`: Vimeo อนุญาตทุกโดเมนย่อยของ `netprimetraining.com` ให้ด้วย
  - `netprime-frontend-staging.nfr-apjc-th-cloudthing.workers.dev` (staging)
  - โดเมน production ถ้าไม่ได้อยู่ใต้ `netprimetraining.com`
- **ข้อจำกัดที่เจอ:**
  - การเพิ่มโดเมนในหน้า Manage defaults พร้อมเลือก "apply to all existing videos" ขึ้นว่าบันทึกสำเร็จ แต่โดเมนใหม่หายไปหลัง refresh วิดีโอเก่าจึงยังไม่มีโดเมน staging
  - Vimeo ไม่รับ `localhost` จึงทดสอบวิดีโอบนเครื่องไม่ได้ ต้องทดสอบบน staging
  - วิดีโอที่เพิ่งอัปโหลดตอบ 403 ทุกโดเมนราว 30 วินาทีระหว่างที่ Vimeo ประมวลผล

## 2. งานโค้ดที่ยังเหลือ

ก่อนเปิดใช้งาน:

| งาน | ทำไมต้องทำ |
| --- | --- |
| **เพิ่มโดเมนของระบบใหม่ให้วิดีโอเก่าใน Vimeo** | วิดีโอที่อัปโหลดไว้ก่อนแล้วอนุญาตแค่ `www.netprimetraining.com` กับ `refeel.getlearnworlds.com` จึงเล่นบน staging ไม่ได้ และหน้า Manage defaults ของ Vimeo เพิ่มให้วิดีโอเก่าไม่ได้ ทางแก้มีสองทาง: เพิ่มโดเมนผ่าน Vimeo API (ต้องมี access token ที่มีสิทธิ์ `edit`) หรือให้ staging และ production ใช้โดเมนย่อยของ `netprimetraining.com` ซึ่งต้องย้าย DNS มา Cloudflare |
| **สคริปต์นำเข้าวิดีโอจาก Vimeo เป็นคอร์ส** | วิดีโอใน Vimeo มีจำนวนมาก สร้างทีละบทไม่ไหว (ออกแบบไว้แล้ว รอทีมพร้อม) ควรตรวจว่าแต่ละวิดีโอเป็น Embed only และมีโดเมนของเราครบ ทำในสคริปต์เดียวกับข้อบนได้ |
| **ผล AI สำรองใน Outsource** | ถ้าไม่มี AI binding `outsource.ts` ตอบร่างสำเร็จรูปเหมือนเป็นผลจริง ควรบอกผู้ใช้ว่าเป็นผลสำรอง |

ทำหลังเปิดได้ (ความเสี่ยงต่ำหรือใช้คนน้อย):

- JWT เก็บใน `localStorage` อายุ 24 ชม. ไม่มี refresh token ถ้ามีช่อง XSS token จะถูกขโมยได้ ทางแก้คือย้ายไป cookie `HttpOnly` หรือใช้ token อายุสั้นคู่กับ refresh token
- OAuth: ยังไม่มีหน้าให้ผู้ใช้ผูกหรือยกเลิกผูกบัญชีเอง ถ้าอีเมลซ้ำกับบัญชีที่มีอยู่ ระบบจะตอบให้เข้าด้วยรหัสผ่านก่อน (`ACCOUNT_LINK_REQUIRED`)
- ความคืบหน้าของวิดีโอ YouTube/Vimeo ยังไม่บันทึกอัตโนมัติ ผู้เรียนต้องกด "เรียนบทนี้แล้ว" เอง (Vimeo Player SDK)
- Turnstile ใช้ที่ฟอร์มสาธารณะแล้ว แต่หน้า login/สมัครใช้แค่ rate limit ควรเพิ่ม WAF rule บน production

## 3. เนื้อหาและการทดสอบ

| งาน | สถานะ |
| --- | --- |
| เตรียมคอร์สออนไลน์ (รวมนำเข้าวิดีโอจาก Vimeo) | ⏳ รอ |
| ฝ่ายกฎหมายตรวจหน้านโยบายความเป็นส่วนตัว เงื่อนไขการใช้งาน และนโยบายคืนเงิน (ตอนนี้เป็นร่าง) | ⏳ |
| ทวนข้อความการตลาดบนหน้าแรกและ FAQ | ⏳ |
| UAT U01–U16 ตาม [TESTING.md](TESTING.md) บน staging พร้อมผู้ลงนามรับ ใช้ `scripts/test-accounts-sql.mjs` สร้างบัญชีทดสอบ | ⏳ ยังไม่เริ่ม (U03–U04 ต้องปรับเป็นขั้นตอนโอนเงิน เพราะปิด Omise แล้ว) |

## Checklist ก่อนเปิดใช้งาน (Go-live)

- [x] ปิด P0 ทั้ง 9 ข้อ พร้อมเทสต์
- [x] `pnpm run check:release` ผ่านใน CI และ deploy staging อัตโนมัติ
- [x] Staging แยก D1/R2/KV และสร้างฐานข้อมูลใหม่ได้โดยไม่มีข้อมูลเดโม (`db:init-sql:verify` ใน CI)
- [ ] ต่อบริการจริงบน staging: อีเมล (ข้อ 1), Stream (ข้อ 4, ถ้าใช้), OAuth (ข้อ 5, ถ้าใช้)
- [ ] อีเมลถึงกล่องจริงไม่เข้า spam และลิงก์ใช้โดเมนจริง
- [ ] ขั้นตอนโอนเงิน: สั่งซื้อ → แนบสลิป → ยืนยัน / ปฏิเสธ / คืนเงิน ทดสอบบน staging ด้วยบัญชีรับโอนจริง
- [ ] วิดีโอเล่นได้บนโดเมนจริง (Stream หรือ Vimeo แบบ Embed only) และดาวน์โหลดเอกสารประกอบได้
- [ ] UAT U01–U16 มีผู้ลงนามรับ
- [ ] นโยบาย PDPA / เงื่อนไข / คืนเงิน ผ่านฝ่ายกฎหมายและเผยแพร่แล้ว
- [ ] สร้าง production (ข้อ 2–3) บัญชี admin จริง (ข้อ 7) ไม่มีบัญชีเดโม
- [ ] Branch protection, monitoring, ทดสอบกู้ข้อมูล และแผน rollback

## สิ่งที่ทำเสร็จแล้ว (อ้างอิง)

| เรื่อง | ตรวจจาก |
| --- | --- |
| P0 #1 ชำระเงิน: คำสั่งซื้อ + โอน + แนบสลิป + ยืนยัน/ปฏิเสธ/คืนเงิน + ใบเสร็จ, endpoint บัตรตอบ 410 | `orders.ts`, `student.ts` |
| P0 #2 อัปโหลด: presign เก็บใน KV 15 นาที ตรวจเจ้าของ ชนิด และขนาด, key อยู่ใต้ prefix ของผู้ใช้ | `instructor.ts` `/instructor/upload/*` |
| P0 #3 voucher: มีเจ้าของ (`created_by`), จำกัดจำนวนครั้ง (`max_uses`, `used_count`) | `instructor.ts`, `utils/vouchers.ts` |
| P0 #4 กลุ่มผู้เรียน: มี `instructor_id` และกรองทุก query | `schema.sql`, `instructor.ts` |
| P0 #5 ฐานข้อมูล production: `init.sql` สร้างจาก `schema.sql` ไม่มี DROP และข้อมูลเดโม | `scripts/build-init-sql.mjs`, CI |
| P0 #6 จัดการผู้ใช้และสิทธิ์ หลายบทบาทต่อบัญชี | `accounts.ts`, `UsersPage.tsx` |
| P0 #7 ลืมรหัสผ่าน / ยืนยันอีเมล / คำเชิญ (ลิงก์ใช้ครั้งเดียว) | `auth.ts` |
| P0 #8 rate limit ที่ login, สมัคร, ลืมรหัสผ่าน, AI และฟอร์มสาธารณะ | `utils/ratelimit.ts`, `auth.ts`, `site.ts` |
| P0 #9 GitHub + CI + deploy staging อัตโนมัติ + `pnpm run db:backup` | `.github/workflows/ci.yml`, `scripts/backup-d1.sh` |
| อีเมล: ลิงก์ใช้ `APP_URL`, escape ทุกค่า, ผู้ส่งตั้งได้ด้วย `EMAIL_FROM`, แก้ข้อความได้จากหลังบ้าน | `utils/email.ts` |
| ประวัติการส่งอีเมล, ส่งอีเมลทดสอบ และส่งซ้ำเมื่อล้มเหลว (PR #14) ยังไม่ได้ทดสอบกับ Resend จริง | `utils/email.ts`, migration `0035_email_log.sql` |
| Code sandbox อยู่ใน iframe แยก ไม่ใช้ `new Function()` บน origin หลัก | `components/learner/codeSandbox.ts` |
| Stream: ไม่มี key → 503, อัปโหลดไฟล์ใหญ่ตรงไป Stream (tus) | `courses.ts`, `components/course/lessonUploads.ts` |
| ใบประกาศ: พิมพ์/บันทึก PDF, เพิกถอนและออกใหม่ | `certificates.ts`, `PrintView.tsx` |
| HR: นำพนักงานออกและคืนที่นั่ง, export CSV | `business.ts` |
| PDPA: ดาวน์โหลดข้อมูลของฉัน, คำขอลบบัญชี, หน้าดำเนินการของ admin | `privacy.ts` |
| Self-learning: คลังบทเรียน HTML, ใช้ในคอร์สได้, บันทึกความคืบหน้า | `selfLearning.ts` |
| หน้าผู้สอน: หน้าคอร์สแบบแท็บ, URL ของแต่ละหน้า, หน้าต่างบทเรียนเดียว, อัปโหลดรูปปก | `components/instructor/` |

## P2 — ปรับปรุงหลังเปิดใช้งาน

- แตกหน้าใหญ่เป็นส่วนย่อย: `Dashboard.tsx` (3,796 บรรทัด) และ `HRConsole.tsx` (2,848) ส่วน `InstructorConsole.tsx` ลดเหลือ 1,715 แล้ว
- URL ของแต่ละหน้าใน console: ตอนนี้มีเฉพาะหน้าผู้สอน (`?course=&tab=`)
- E2E test (Playwright) ทุกบทบาท, accessibility และมือถือ
- อัปเดต `compatibility_date` (ตอนนี้ 2024-05-24 ทั้งสอง Worker)
- ราคาเก็บเป็น `REAL` ควรเปลี่ยนเป็นจำนวนเต็มหน่วยสตางค์
- ปุ่มสลับภาษา EN/ไทยในคอนโซล (หน้าเว็บสาธารณะมีแล้ว)
