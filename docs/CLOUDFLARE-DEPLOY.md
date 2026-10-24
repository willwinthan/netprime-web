# คู่มือติดตั้งและใช้งาน Netprime LMS บน Cloudflare

สำหรับทีมพัฒนา/ผู้ดูแลระบบ · 24 ตุลาคม 2026 · อ่าน [ARCHITECTURE.md](ARCHITECTURE.md) ก่อน

> **ข้อควรระวัง:** ปัจจุบันระบบยังมีงาน P0 ค้างตาม [GAP-ANALYSIS.md](GAP-ANALYSIS.md) ให้ deploy ไป **staging** เพื่อทดสอบก่อน อย่าเปิดรับผู้ใช้จริงจนกว่าจะปิด P0 ครบ ลำดับขึ้นระบบจริงอยู่ใน [หัวข้อ 14 Go-live runbook](#14-go-live-runbook)

## 1. สิ่งที่ต้องมี

| รายการ | หมายเหตุ |
| --- | --- |
| บัญชี Cloudflare + **Workers Paid plan** | Free plan จำกัด CPU 10 ms ต่อ request แต่การตรวจรหัสผ่าน PBKDF2 100,000 รอบใช้ CPU มากกว่านั้น login อาจล้มเหลว Paid plan ยังจำเป็นสำหรับ Stream, D1 Time Travel 30 วัน และขีดจำกัด D1 ที่สูงกว่า |
| Domain ที่ใช้ DNS ของ Cloudflare | เช่น `app.example.com` (เว็บ) และ `api.example.com` (API) |
| Node 22, pnpm 10 | ตรงกับที่ใช้ทดสอบและ CI (pnpm 10.33, lockfile v9) ใช้ pnpm เท่านั้น ห้ามมี `package-lock.json` |
| Wrangler 4 | root, backend และ frontend-admin ใช้ `wrangler@^4.98.0` ชุดเดียวกัน เรียกผ่าน `npx wrangler` หรือ script ใน `package.json` |
| บัญชีผู้ให้บริการ | บัญชีธนาคารรับโอน, Resend (อีเมล), Google/GitHub OAuth (ถ้าเปิด), Cloudflare Stream (ถ้าใช้วิดีโอ Stream) |

```bash
pnpm install --frozen-lockfile
```

```bash
npx wrangler login
```

## 2. บริการ Cloudflare ที่ใช้

| บริการ | Binding | ใช้ทำอะไร |
| --- | --- | --- |
| Workers | — | `netprime-backend` (API) และ `netprime-frontend` (เว็บ React) |
| D1 | `DB` | ฐานข้อมูลหลัก |
| R2 | `ASSETS` | ไฟล์ handout และวิดีโอที่อัปโหลด |
| KV | `SESSIONS` | token ที่ logout แล้ว และ OAuth state |
| Workers AI | `AI` | AI tutor และ AI ช่วยร่าง scope/ตรวจ milestone |
| Stream | (secret) | เล่นวิดีโอแบบ signed URL |
| Cron Trigger | — | งานประจำวัน 08:00 น. เวลาไทย ดู [หัวข้อ 10](#10-monitoring-log-และการแจ้งเตือน) |

## 3. Environment: production และ staging

ใช้ไฟล์ config เดียว `backend/wrangler.jsonc` (และ `frontend-admin/wrangler.jsonc`):

| Environment | Worker | คำสั่ง | Resource |
| --- | --- | --- | --- |
| production | `netprime-backend`, `netprime-frontend` | ไม่ใส่ `--env` (ค่าระดับบนสุดของไฟล์) | `netprime-db`, `netprime-assets`, KV `SESSIONS` ที่ใส่ ID ไว้แล้ว |
| staging | `netprime-backend-staging`, `netprime-frontend-staging` | `--env staging` | `netprime-db-staging`, `netprime-assets-staging`, KV staging |

- ค่าระดับบนสุดคือ production ที่ deploy อยู่แล้ว จึงไม่ได้สร้าง `env.production` (ถ้าสร้าง Wrangler จะตั้งชื่อ Worker ใหม่เป็น `netprime-backend-production` แยกจากตัวเดิม)
- ตอนรันคำสั่ง production Wrangler จะเตือน `Multiple environments are defined…` เป็นเรื่องปกติ ไม่มีผลกับการทำงาน
- `vars` และ binding (D1/R2/KV/AI) **ไม่สืบทอด** ไปยัง env ต้องระบุซ้ำใน `env.staging` ส่วน `observability`, `triggers`, `compatibility_date` สืบทอดจากด้านบน
- `database_id` และ KV `id` **ไม่ใช่ความลับ** (เป็นตัวระบุ resource ต้องมี API token ของบัญชีจึงเข้าถึงได้) commit ลง Git ได้ ค่า production เป็นของบัญชีเดิม ถ้าย้ายบัญชีให้สร้างใหม่และแทนค่า

สร้าง resource ของ staging ครั้งเดียว แล้วนำ ID ที่ได้ไปแทนข้อความ `ใส่ ID จริง` ใน `env.staging` ของ `backend/wrangler.jsonc` (ห้ามเดา ID):

```bash
cd backend && npx wrangler d1 create netprime-db-staging
```

```bash
cd backend && npx wrangler r2 bucket create netprime-assets-staging
```

```bash
cd backend && npx wrangler kv namespace create SESSIONS --env staging
```

จากนั้นใส่ `FRONTEND_ORIGINS` และ `APP_URL` ของ staging ใน `env.staging.vars` ของ backend และ `API_BASE_URL` ใน `env.staging.vars` ของ `frontend-admin/wrangler.jsonc` ถ้าย้ายบัญชี production ทำแบบเดียวกันโดยตัด `-staging` และ `--env staging` ออก แล้วแทนค่าระดับบนสุด

คำสั่ง backend ทุกตัว (`deploy`, `secret put`, `d1 …`, `tail`) ต้องเลือก env ให้ตรง: production ไม่ใส่ `--env` ส่วน staging ใส่ `--env staging` และใช้ชื่อฐานข้อมูล `netprime-db-staging`

## 4. ตั้งค่าฐานข้อมูล D1

`backend/schema.sql` ใช้กับ local/test เท่านั้น เพราะเริ่มด้วย `DROP TABLE` และใส่บัญชีเดโมรหัสผ่าน plaintext คำสั่งเดิม `db:setup:remote` ถูกลบแล้ว

### 4.1 ฐานข้อมูลใหม่ (ว่างเปล่า)

`scripts/build-init-sql.mjs` สร้าง `backend/init.sql` จาก `schema.sql` ทุกครั้งที่รัน: ตัด DROP และข้อมูลเดโมออก, รวม `ALTER TABLE … ADD COLUMN` เข้าไปใน `CREATE TABLE`, เก็บเฉพาะข้อมูลอ้างอิงที่ระบบต้องใช้ (`role_permissions`, `achievements`) และบันทึกทุกไฟล์ใน `backend/migrations` ลงตาราง `d1_migrations` ว่ารันแล้ว เหตุผลรายตารางเขียนไว้ต้นไฟล์สคริปต์ `init.sql` เป็นไฟล์ generate (อยู่ใน `.gitignore`) สร้างใหม่ทุกครั้งที่ใช้

```bash
pnpm run db:init-sql:verify
```

ตรวจว่าโครงสร้างตรงกับ `schema.sql`, ตารางข้อมูลว่าง และรันซ้ำได้ (ใช้ SQLite ในเครื่อง ไม่แตะ Cloudflare; CI รันคำสั่งนี้ทุกครั้ง) แล้วสร้างตารางบน D1:

```bash
pnpm run db:init:remote -- --env staging
```

```bash
pnpm run db:init:remote
```

สคริปต์จะ (1) สร้าง `init.sql` ใหม่ (2) ปฏิเสธถ้าฐานข้อมูลมีตารางอยู่แล้ว (3) ให้พิมพ์ชื่อฐานข้อมูลยืนยัน ถ้ารันแบบไม่มี terminal ให้ตั้ง `CONFIRM_INIT_REMOTE=netprime-db` แทนการพิมพ์ ตรวจผลด้วย `cd backend && npx wrangler d1 migrations list netprime-db --remote` ต้องขึ้นว่าไม่มี migration ค้าง

`site_settings` (ข้อมูลติดต่อ), `payment_settings` (บัญชีรับโอน) และ voucher ไม่ถูกใส่ค่าเดโม หลังสร้าง admin ให้กรอกเองในหน้า "ตั้งค่าเว็บไซต์" และหน้าตั้งค่าการชำระเงินก่อนเปิดฟอร์ม/เปิดขาย

### 4.2 ฐานข้อมูลที่ใช้งานอยู่แล้ว

สำรองก่อนเสมอ ([หัวข้อ 11](#11-backup-และ-restore)) แล้ว apply เฉพาะ migration ที่ยังไม่ได้รัน:

```bash
pnpm run db:backup
```

```bash
cd backend && npx wrangler d1 migrations list netprime-db --remote
```

```bash
cd backend && npx wrangler d1 migrations apply netprime-db --remote
```

staging ใช้ `netprime-db-staging` และเติม `--env staging` ทุกคำสั่ง Wrangler บันทึกว่า migration ไหนรันแล้วในตาราง `d1_migrations` ครั้งต่อไปจะรันเฉพาะไฟล์ใหม่ ทุกการเปลี่ยน schema ให้สร้างไฟล์ใหม่ต่อเลข (เช่น `0016_xxx.sql`) และแก้ `schema.sql` ให้ตรง ห้ามแก้ไฟล์ migration เดิม

บันทึก migration ที่ต้องระวังกับฐานข้อมูลเดิม (migration ใหม่กว่านี้ดูหมายเหตุใน [หัวข้อ 5](#5-ตั้ง-secrets-และ-vars-ของ-backend) และคอมเมนต์ต้นไฟล์):

- `0005_site_content.sql` เพิ่มตารางเว็บไซต์ (รอบอบรม, ผู้สมัคร, บทความ, ข้อความติดต่อ, โปรโมชั่น, ตั้งค่า, audit log) แบบไม่แตะตารางเดิม หลัง apply ให้เข้า "จัดการเว็บไซต์" → "ตั้งค่าเว็บไซต์" กรอกข้อมูลติดต่อและอีเมลรับแจ้งเตือนก่อนเปิดฟอร์ม
- `0006_staff_role.sql` เพิ่มคอลัมน์ `users.staff_role` ระบบไม่สร้างตาราง `users` ใหม่ เพราะตารางอื่นอ้างอิงแบบ `ON DELETE CASCADE` ถ้าลบตารางเดิมข้อมูลที่ผูกอยู่อาจถูกลบตาม
- `0007_thai_level_titles.sql` แปลงชื่อเลเวลของผู้ใช้เดิมที่เก็บเป็นอังกฤษให้เป็นภาษาไทย (ผู้ใช้ใหม่ได้ชื่อไทยอัตโนมัติ)
- `0008_access_and_articles.sql` เพิ่มสถานะบัญชี (ระงับ/ใช้งาน) และเวลา login ล่าสุดใน `users`, สร้างตาราง `role_permissions` พร้อมสิทธิ์เริ่มต้น และสร้างตาราง `articles` ใหม่ให้รองรับขั้นตอน ฉบับร่าง → รอตรวจ → เผยแพร่ (คัดลอกบทความเดิมครบ ตารางอื่นไม่ได้อ้างอิง `articles` จึงสร้างใหม่ได้ปลอดภัย)
- `0009_user_roles.sql` สร้างตาราง `user_roles` ให้ 1 บัญชีมีได้หลายบทบาท คัดลอกบทบาทเดิมของทุกบัญชีมาให้ และเพิ่ม trigger ใส่บทบาทให้ผู้ใช้ใหม่อัตโนมัติ · endpoint เก่า `POST /api/admin/coordinators` และ `PATCH /api/admin/users/:id/staff-role` ถูกลบแล้ว ใช้ `/api/admin/accounts` แทน
- `0014_site_ops.sql` เพิ่ม `session_registrations.user_id` (เชื่อมกับบัญชีที่อีเมลตรงกันให้ทันทีตอน apply) และ `reminder_sent_at`, `articles.updated_by`, ตาราง `article_revisions` และ `privacy_requests` ไม่แก้ข้อมูลเดิม · งานรายวัน (cron) ส่งอีเมลเตือนก่อนวันอบรม 2 วันและล้าง token ที่หมดอายุ ต้องมี `triggers.crons` และ `RESEND_API_KEY` จริงจึงส่งอีเมลได้ สั่งรันทันทีได้ด้วย `POST /api/admin/site/jobs/run` (บัญชี admin) · ลิงก์คำเชิญชี้ไปที่ `APP_URL/reset-password` จึงต้องตั้ง `APP_URL` ให้ถูก
- ฐานข้อมูล production เดิมต้อง apply `0008`–`0015` (หรือที่ค้างตาม `migrations list`) ให้ครบ **ก่อน** deploy backend เวอร์ชันปัจจุบัน เพราะโค้ดอ่านตาราง/คอลัมน์ใหม่

### 4.3 สร้าง admin คนแรก (ไม่ต้องใช้คำเชิญ)

`scripts/hash-password.mjs` ใช้อัลกอริทึมเดียวกับ `backend/src/utils/crypto.ts` (PBKDF2-SHA256 100,000 รอบ) รับรหัสผ่าน (≥ 12 ตัวอักษร) แบบไม่แสดงบนจอ ไม่รับทาง argument จึงไม่ค้างใน shell history และพิมพ์ SQL ที่มีเฉพาะ hash:

```bash
node scripts/hash-password.mjs --email admin@yourcompany.com --name "ผู้ดูแลระบบ" > first-admin.sql
```

```bash
cd backend && npx wrangler d1 execute netprime-db --remote --file ../first-admin.sql
```

```bash
rm first-admin.sql
```

staging ใช้ `netprime-db-staging --env staging` · บัญชีถูกตั้งเป็นยืนยันอีเมลแล้ว และได้บทบาท `admin` ใน `user_roles` จากนั้น login แล้วเพิ่มผู้ดูแลคนอื่นผ่านหน้าจัดการบัญชีตามปกติ ถ้าต้องการแค่ hash (เช่นรีเซ็ตรหัส admin ที่ลืมเมื่อส่งอีเมลไม่ได้) รัน `node scripts/hash-password.mjs` ไม่ใส่ตัวเลือก แล้ว `UPDATE users SET password_hash = '<hash>' WHERE email = '…'`

## 5. ตั้ง Secrets และ vars ของ backend

ห้ามใส่ค่าเหล่านี้ใน `wrangler.jsonc` หรือ commit ลง Git ใช้ `wrangler secret put` (จะถามค่าแบบซ่อน) ตั้งแยกกันต่อ environment:

| Secret | จำเป็น | ได้มาจาก |
| --- | --- | --- |
| `JWT_SECRET` | ใช่ (≥ 32 ตัวอักษร ไม่งั้น API ตอบ 503) | สุ่มเอง เช่น `openssl rand -base64 48` ใช้ค่าต่างกันระหว่าง staging/production |
| `OMISE_SECRET_KEY` | ไม่ใช้แล้ว | ปิดการชำระด้วยบัตร ใช้การโอนเงินที่เจ้าหน้าที่ยืนยัน (migration 0013) |
| `RESEND_API_KEY` | ถ้าส่งอีเมล | Resend → API Keys (ถ้าไม่ตั้ง อีเมลจะถูก log ไว้เฉย ๆ) |
| `STREAM_SIGNING_KEY`, `STREAM_KEY_ID` | ถ้าใช้ Stream | สร้าง signing key ผ่าน Stream API (`POST /accounts/{account_id}/stream/keys`) ใช้ค่า `pem` หรือ `jwk` และ `id` |
| `STREAM_ACCOUNT_ID`, `STREAM_API_TOKEN` | ถ้าอัปโหลดวิดีโอ Stream จากหน้าเว็บ | Account ID และ API token สิทธิ์ Stream:Edit |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | ถ้าเปิด Google login | Google Cloud Console → OAuth client |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | ถ้าเปิด GitHub login | GitHub → Settings → Developer settings → OAuth Apps |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | ถ้าเปิด Microsoft login | Microsoft Entra → App registrations |
| `NOTION_TOKEN` | ไม่บังคับ (เฉพาะ "นำเข้าจาก Notion") | notion.so/profile/integrations → New integration (Internal, Read content อย่างเดียว) → Internal Integration Secret · การฝังหน้า Notion ไม่ต้องใช้ |
| `TURNSTILE_SECRET_KEY` | แนะนำ (กันบอทในฟอร์มลงทะเบียน/ติดต่อ) | Dashboard → Turnstile → Add widget (ใส่ hostname ของเว็บ); ใส่ site key ฝั่งเว็บเป็น `VITE_TURNSTILE_SITE_KEY` ด้วย ถ้าตั้งแค่ฝั่งเดียวฟอร์มจะส่งไม่ผ่าน |

```bash
cd backend && npx wrangler secret put JWT_SECRET
```

staging เติม `--env staging` ทำซ้ำกับ secret อื่นตามที่ใช้ ตรวจรายการที่ตั้งแล้วด้วย `npx wrangler secret list` (เห็นแค่ชื่อ)

ตัวแปรที่ไม่ใช่ความลับใส่ใน `vars` ของ `backend/wrangler.jsonc` (production ที่ระดับบนสุด, staging ใน `env.staging.vars`) แล้ว deploy ใหม่:

| Var | ค่า |
| --- | --- |
| `FRONTEND_ORIGINS` | origin ของเว็บที่อนุญาต คั่นหลาย origin ด้วย comma เช่น `https://app.example.com` (ไม่มี `/` ท้าย) |
| `APP_URL` | origin ที่ใช้สร้างลิงก์ในอีเมล (รีเซ็ตรหัส, คำเชิญ, ยืนยันอีเมล) เช่น `https://www.netprime.co.th` ถ้าเว้นว่างใช้ origin แรกของ `FRONTEND_ORIGINS` |
| `EMAIL_FROM` | ผู้ส่งอีเมล เช่น `NetPrime <noreply@netprime.co.th>` โดเมนต้อง verify ใน Resend (SPF/DKIM) ก่อน ถ้าเว้นว่างใช้ `noreply@netprime-lms.com` |

ห้ามตั้ง `ALLOW_LOCAL_SEED_PASSWORDS` บน staging/production

**บัญชีผู้ใช้ (migration `0011_account_tokens.sql`):** เพิ่มตาราง `account_tokens` (เก็บเฉพาะ hash ของลิงก์รีเซ็ตรหัสผ่าน/คำเชิญ/ยืนยันอีเมล) และคอลัมน์ `users.email_verified_at` (บัญชีเดิมถูกตั้งเป็นยืนยันแล้ว) รันด้วย `wrangler d1 migrations apply` ตามปกติ ก่อน deploy backend เวอร์ชันนี้
- ลิงก์ในอีเมลสร้างจาก `APP_URL` (เช่น `https://www.netprime.co.th` ไม่มี `/` ท้าย) ถ้าไม่ตั้งจะใช้ origin แรกใน `FRONTEND_ORIGINS` ต้องตั้งให้ถูกก่อนเปิดใช้ ไม่งั้นลิงก์จะชี้ผิดโดเมน
- ต้องตั้ง `RESEND_API_KEY` (และยืนยันโดเมนผู้ส่งใน Resend) ไม่งั้นลิงก์ลืมรหัสผ่าน/คำเชิญจะถูก log ไว้เฉย ๆ ผู้ใช้จะไม่ได้รับ
- `debug_url` ในคำตอบ API จะออกมาเฉพาะเมื่อ `ALLOW_LOCAL_SEED_PASSWORDS=true` (ใช้ในเทสต์บนเครื่องเท่านั้น)
- ตัวนับ rate limit ของ login/สมัคร/ลืมรหัสผ่าน อยู่ใน KV `SESSIONS` (คีย์ขึ้นต้น `rl:` หมดอายุเอง) เป็น soft limit ควรตั้ง WAF rate limiting ตามหัวข้อ 9 ด้วย

**ชำระเงินด้วยการโอน (migration `0013_manual_payments.sql`):** ปิดการชำระด้วยบัตร (Omise) ทั้งหมด `POST /api/student/checkout/session` และ `/api/payment/omise-webhook` ตอบ 410 และไม่เปิดสิทธิ์เรียนอีก migration นี้เพิ่มตาราง `course_orders` (คำสั่งซื้อ/สลิป/ใบเสร็จ), `order_counters` (เลขคำสั่งซื้อ NP-YY0001 และเลขใบเสร็จ RC-ปี-000001 แยกตามปี) และ `payment_settings` (บัญชีรับโอน ค่าเริ่มต้นว่าง) และเพิ่มคอลัมน์ `revoked_at`, `revoked_by`, `revoke_reason`, `reissued_from` ใน `certificates` ตาราง `payments` เดิมไม่ถูกแตะ (เก็บเป็นประวัติ) ใบประกาศเดิมยังใช้งานได้ หลัง apply ให้เจ้าหน้าที่ที่มีสิทธิ์ `payments.manage` กรอกบัญชีรับโอนในหน้า "คำสั่งซื้อคอร์ส" → "บัญชีรับโอน" ก่อนเปิดขาย สลิปเก็บใน R2 `ASSETS` ใต้ `slips/` แบบ private (อ่านผ่าน API เท่านั้น) ห้ามเปิด public access/custom domain ให้ทั้ง bucket ไม่ต้องตั้ง `OMISE_SECRET_KEY`

**องค์กรและพนักงาน (migration `0015_partner_ops.sql`):** เพิ่มคอลัมน์ `enrollments.partner_id` (องค์กรที่สนับสนุนการลงทะเบียนนั้น) และเติมค่าให้ข้อมูลเดิม: การลงทะเบียนของพนักงานในคอร์สที่องค์กรสนับสนุนและไม่มีการชำระเงินส่วนตัว ถือว่าองค์กรสนับสนุน รันก่อน deploy backend เวอร์ชันนี้ คำเชิญพนักงานจาก HR ใช้ `APP_URL` และ `RESEND_API_KEY` ชุดเดียวกับข้างบน

## 6. Deploy backend (API)

```bash
pnpm run deploy:backend:staging
```

production ใช้ `pnpm run deploy:backend` ตรวจว่า API ทำงาน (ควรได้ข้อความ "operational"):

```bash
curl https://staging-api.example.com/
```

## 7. Deploy frontend (เว็บ)

ค่า API URL ถูกฝังตอน build: production อ่าน `frontend-admin/.env.production`, staging อ่าน `frontend-admin/.env.staging` (สร้างเองจาก `.env.example`) ทั้งสองไฟล์มีเฉพาะค่า `VITE_*` ที่ฝังอยู่ในหน้าเว็บสาธารณะอยู่แล้ว จึง commit ได้ (ยกเว้นไว้ใน `.gitignore`) ห้ามใส่ secret

```
VITE_API_BASE_URL=https://staging-api.example.com/api
VITE_TURNSTILE_SITE_KEY=<site key>
```

แล้ว deploy (deploy backend ก่อนเสมอ):

```bash
pnpm run deploy:frontend:staging
```

production ใช้ `pnpm run deploy:frontend`

Worker ของเว็บ (`frontend-admin/worker/index.ts`) ใส่ tag สำหรับแชร์ลิงก์ (og:title, og:image) และสร้าง `/sitemap.xml` กับ `/robots.txt` ต้องตั้ง `API_BASE_URL` ใน `vars` ของ `frontend-admin/wrangler.jsonc` (staging ใน `env.staging.vars`) ให้เป็นค่าเดียวกับ `VITE_API_BASE_URL` ของแต่ละ environment ถ้าเว้นว่าง เว็บยังใช้งานได้ แต่ลิงก์บทความจะแสดงหัวข้อและรูปค่าเริ่มต้น และ sitemap จะไม่มีบทความ

หลัง deploy ให้ตรวจ:

- เปิด `https://<โดเมน>/blog/<slug>` ด้วย Facebook Sharing Debugger (developers.facebook.com/tools/debug) แล้วกด "Scrape Again" เพื่อดูหัวข้อและรูป
- LINE เก็บตัวอย่างลิงก์ไว้หลายวัน ถ้าเคยแชร์ลิงก์นั้นก่อนแก้รูป ให้ล้าง cache ด้วย LINE Page Poker (poker.line.naver.jp)
- ส่ง `https://<โดเมน>/sitemap.xml` ใน Google Search Console (sitemap cache 1 ชั่วโมง)

ผูก custom domain: Cloudflare Dashboard → Workers & Pages → `netprime-frontend` → Settings → Domains & Routes → Add Custom Domain หรือเพิ่ม `routes` ใน `frontend-admin/wrangler.jsonc` แบบเดียวกับ backend จากนั้นต้องมี origin นี้ใน `FRONTEND_ORIGINS` ของ backend ไม่งั้น browser จะถูก CORS บล็อก

## 8. เชื่อมบริการภายนอก

| บริการ | ตั้งค่าที่ผู้ให้บริการ |
| --- | --- |
| Google OAuth | Authorized redirect URI: `https://app.example.com/auth/callback/google` |
| GitHub OAuth | Callback URL: `https://app.example.com/auth/callback/github` |
| Resend | Domains → Add domain แล้วเพิ่ม DNS record ที่ Resend ให้มาใน Cloudflare DNS แบบ **DNS only** (ไม่เปิด proxy): SPF (MX + TXT ที่ subdomain `send`) และ DKIM (TXT `resend._domainkey`) รอจนสถานะ Verified · แนะนำเพิ่ม DMARC: TXT `_dmarc` = `v=DMARC1; p=none; rua=mailto:<อีเมลผู้ดูแล>` · ผู้ส่งในโค้ดคือ `noreply@netprime-lms.com` (`backend/src/utils/email.ts`) ต้องเป็น domain ที่ verify แล้ว ไม่งั้น Resend ปฏิเสธการส่ง; ลิงก์ในอีเมลใช้ `APP_URL` |
| Turnstile | widget ต้องมี hostname ของเว็บทั้ง staging และ production (หรือแยก widget ต่อ env) |
| Stream | อัปโหลดวิดีโอใน Dashboard → Stream เปิด "Require Signed URLs" แล้วนำ Video UID ไปใส่ในบทเรียน (`video_provider = cloudflare`) |

redirect URI ต้องตรงกับ origin ใน `FRONTEND_ORIGINS` และ path `/auth/callback/<provider>` ทุกตัวอักษร (backend ตรวจเข้มงวด)

## 9. ความปลอดภัยที่ตั้งได้ใน Cloudflare Dashboard

- **WAF → Rate limiting rules:** จำกัด `/api/auth/login`, `/api/auth/register`, `/api/ai/*`, `/api/public/inquiries`, `/api/public/sessions/*/register` เช่น 10 ครั้ง/นาที/IP (ในโค้ดมี soft limit ผ่าน KV สำหรับฟอร์มสาธารณะ, login, สมัคร, ลืมรหัสผ่าน และลิงก์รีเซ็ต/ยืนยันอีเมล — ควรเพิ่ม `/api/auth/forgot-password` ใน WAF ด้วย)
- **Turnstile:** ฟอร์มลงทะเบียนอบรมและติดต่อรองรับแล้ว (ตั้ง `TURNSTILE_SECRET_KEY` + `VITE_TURNSTILE_SITE_KEY`); ฟอร์ม signup/login ยังต้องแก้โค้ดเพิ่ม
- **Security → Bots:** เปิด Bot Fight Mode
- SSL/TLS สำหรับ Workers custom domain เป็น HTTPS อัตโนมัติ

## 10. Monitoring, log และการแจ้งเตือน

`backend/wrangler.jsonc` เปิด `observability` (Workers Logs) แล้ว: ทุก request, `console.log/error` และ exception ถูกเก็บไว้ค้นย้อนหลังได้ (Paid plan เก็บ 7 วัน)

| งาน | วิธี |
| --- | --- |
| ดู error ย้อนหลัง | Dashboard → Workers & Pages → `netprime-backend` → **Observability / Logs** → filter `$metadata.level = error` หรือ outcome = `exception` เลือกช่วงเวลา แล้วเปิดดู stack trace |
| ดู log สด | `cd backend && npx wrangler tail --format pretty --status error` (staging เติม `--env staging`) |
| ภาพรวม | Workers → `netprime-backend` → **Metrics**: requests, errors, CPU time, duration |
| แจ้งเตือนเมื่อ Worker error | Dashboard → Manage Account → **Notifications** → Add → เลือก alert ของ Workers (เช่น Workers Observability alert / error rate ตามที่บัญชีมีให้เลือก) → Worker `netprime-backend` → ปลายทางเป็นอีเมลหรือ webhook (Slack/LINE ผ่าน webhook) ตั้ง threshold เช่น error rate > 1% ใน 5 นาที แล้วกด Test |
| แจ้งเตือนอื่นที่ควรเปิด | Notifications: Usage-based billing (กันค่าใช้จ่ายพุ่ง), Cloudflare incident ของ Workers/D1, SSL certificate (ถ้าใช้ custom cert) |
| Uptime ภายนอก | ตั้ง monitor (เช่น UptimeRobot/Better Stack) เรียก `https://api.example.com/` และหน้าแรกของเว็บทุก 5 นาที |

**Cron Trigger:** `triggers.crons = ["0 1 * * *"]` = ทุกวัน 01:00 UTC (08:00 น. เวลาไทย) เรียก `runScheduledJobs` ใน `backend/src/jobs.ts` (เตือนรอบอบรมและงาน housekeeping แต่ละงานแยกกันและรันซ้ำได้) staging สืบทอด cron เดียวกัน

- ดูประวัติการรัน: Workers → `netprime-backend` → Settings → **Triggers** → Cron Triggers (past events) หรือใน Logs filter event ประเภท `scheduled`
- สั่งรันทันทีจากหน้า admin: `POST /api/admin/site/jobs/run` (ใช้ตรวจหลัง deploy)
- ทดสอบในเครื่อง: `wrangler dev --test-scheduled` แล้วเรียก `http://localhost:8787/__scheduled?cron=0+1+*+*+*`
- เปลี่ยนเวลา: แก้ `triggers.crons` แล้ว deploy ใหม่ (เวลาเป็น UTC เสมอ)

## 11. Backup และ restore

### 11.1 D1 Time Travel (ย้อนเวลาได้ 30 วัน บน Paid plan)

D1 บันทึกทุกการเขียนไว้อัตโนมัติ ไม่ต้องตั้งค่า ใช้เมื่อข้อมูลเสียหาย/ลบผิด ดู bookmark ปัจจุบัน (จดไว้ก่อน migrate หรือแก้ข้อมูลชุดใหญ่):

```bash
cd backend && npx wrangler d1 time-travel info netprime-db
```

ดู bookmark ของเวลาที่ต้องการ:

```bash
cd backend && npx wrangler d1 time-travel info netprime-db --timestamp 2026-10-24T08:00:00+07:00
```

ย้อนฐานข้อมูลทั้งก้อนกลับไปเวลานั้น (**เขียนทับทุกอย่างหลังจากนั้น** ข้อมูลที่ผู้ใช้สร้างหลังเวลานั้นจะหาย ผลลัพธ์จะแสดง bookmark ก่อน restore ไว้ใช้ undo):

```bash
cd backend && npx wrangler d1 time-travel restore netprime-db --timestamp 2026-10-24T08:00:00+07:00
```

หรือใช้ `--bookmark <bookmark>` แทน `--timestamp` · staging ใช้ `netprime-db-staging --env staging`

### 11.2 Export เป็นไฟล์ (เก็บนานกว่า 30 วัน / ก่อน migrate)

```bash
pnpm run db:backup
```

`scripts/backup-d1.sh` export ทั้ง schema และข้อมูลไปที่ `backups/netprime-db-<เวลา UTC>.sql` (staging: `pnpm run db:backup -- --env staging`) ถ้าตั้ง `BACKUP_BUCKET` จะอัปโหลดสำเนาไป R2 ที่ `d1/<ชื่อฐานข้อมูล>/` ด้วย ใช้ bucket แยกจาก `netprime-assets`:

```bash
npx wrangler r2 bucket create netprime-backups
```

```bash
BACKUP_BUCKET=netprime-backups pnpm run db:backup
```

ไฟล์ backup มีข้อมูลส่วนบุคคลและ password hash: `backups/` อยู่ใน `.gitignore` ห้าม commit/แชร์ bucket backup ห้ามเปิด public access ตั้ง lifecycle rule ใน R2 ลบไฟล์เก่ากว่า 90 วัน (หรือตามนโยบาย PDPA ขององค์กร) ระหว่าง export ฐานข้อมูลอาจตอบช้าลงชั่วครู่ ควรทำนอกเวลาใช้งาน

### 11.3 Restore drill (ซ้อมทุกไตรมาส และก่อน go-live)

ซ้อมกับฐานข้อมูลชั่วคราวหรือ staging เท่านั้น ห้ามซ้อมกับ production:

1. `pnpm run db:backup` เก็บไฟล์ production ล่าสุด
2. สร้างฐานข้อมูลเปล่าสำหรับซ้อม: `npx wrangler d1 create netprime-db-restore-drill`
3. นำเข้า: `npx wrangler d1 execute netprime-db-restore-drill --remote --file backups/<ไฟล์>.sql` (รันนอกโฟลเดอร์ `backend` หรือเพิ่ม binding ชั่วคราว ถ้า Wrangler หาชื่อฐานข้อมูลใน config ไม่เจอ)
4. ตรวจ: `--command "SELECT COUNT(*) FROM users"` และตารางสำคัญ (`enrollments`, `payments`, `course_orders`) เทียบกับ production; `SELECT name FROM d1_migrations` ต้องครบ
5. (ถ้าต้องการทดสอบแอปเต็มรูปแบบ) ชี้ `env.staging` ไปที่ฐานข้อมูลนี้ deploy staging แล้ว login ด้วยบัญชีทดสอบ
6. ซ้อม Time Travel บน staging: จด bookmark → แก้ข้อมูล 1 แถว → `time-travel restore --bookmark` → ตรวจว่าแถวกลับมา
7. ลบฐานข้อมูลซ้อม: `npx wrangler d1 delete netprime-db-restore-drill` แล้วบันทึกเวลาที่ใช้ (RTO) และอายุข้อมูลที่กู้ได้ (RPO)

### 11.4 R2 และ KV

- R2 (`netprime-assets`): ไม่มี Time Travel ไฟล์ที่ลบแล้วกู้ไม่ได้ ถ้าต้องสำรองให้ sync ไป bucket อื่นเป็นระยะ (เช่น `rclone sync` ผ่าน R2 S3 API)
- KV (`SESSIONS`): เก็บเฉพาะ token ที่ logout, OAuth state และตัวนับ rate limit อายุสั้น ไม่ต้องสำรอง

## 12. CI/CD

`.github/workflows/ci.yml` รันทุก push ไป `main` และทุก pull request: pnpm 10 + Node 22 (cache pnpm store) → `pnpm install --frozen-lockfile` → `pnpm run db:init-sql:verify` → `pnpm run check:release` ไม่มีขั้น deploy อัตโนมัติ

- โฟลเดอร์นี้ `git init` แล้ว (branch `main`) ยังไม่มี commit และ remote: สร้าง repository บน GitHub แล้ว `git remote add origin …` และ push
- ตั้ง branch protection ให้ `main` ต้องผ่าน job `check:release` ก่อน merge
- Deploy อัตโนมัติ (คอมเมนต์ไว้ท้ายไฟล์ workflow): สร้าง API token สิทธิ์ Workers Scripts:Edit, D1:Edit, Workers KV:Edit, R2:Edit เก็บเป็น `CLOUDFLARE_API_TOKEN` และ `CLOUDFLARE_ACCOUNT_ID` ใน repo secrets ใช้ GitHub Environment ที่บังคับ reviewer สำหรับ production ไม่ deploy ถ้า `check:release` ไม่ผ่าน
- ทางเลือก: Workers Builds (Dashboard → Worker → Settings → Builds) เชื่อม repo แยกต่อ Worker

## 13. การดูแลระบบประจำวัน

| งาน | วิธี |
| --- | --- |
| ดู log / แจ้งเตือน | [หัวข้อ 10](#10-monitoring-log-และการแจ้งเตือน) |
| Rollback โค้ด | `cd backend && npx wrangler deployments list` แล้ว `npx wrangler rollback <version-id>` หรือ Dashboard → Deployments เลือกเวอร์ชันก่อนหน้า (frontend ทำใน `frontend-admin` แบบเดียวกัน) rollback ไม่ย้อน schema/ข้อมูล |
| Backup / Restore D1 | [หัวข้อ 11](#11-backup-และ-restore) |
| เปลี่ยน schema | สร้าง migration ใหม่ + แก้ `schema.sql` → CI ผ่าน → apply บน staging → ทดสอบ → `pnpm run db:backup` production → apply production → deploy |
| หมุน secret | `wrangler secret put` ค่าใหม่ (เปลี่ยน `JWT_SECRET` จะทำให้ทุกคน logout) |
| อัปเดต dependency | แก้เวอร์ชันใน `package.json` → `pnpm install` → `pnpm run check:release` → commit `pnpm-lock.yaml` |
| `compatibility_date` | ตอนนี้ `2024-05-24` ทุก config ตั้งใจคงไว้ เพราะการเลื่อนวันที่เปลี่ยนพฤติกรรม runtime ให้ทำเป็นงานแยก: เลื่อน `wrangler.jsonc`, `wrangler.local.jsonc` และ frontend พร้อมกัน รัน `check:release` และทดสอบ staging ก่อน |

## 14. Go-live runbook

ทำตามลำดับบน staging ให้ผ่านทั้งหมดก่อน แล้วทำซ้ำกับ production (ตัด `--env staging` / `-staging` ออก) จดเวลาเริ่ม/จบของแต่ละขั้น

**ก่อนวันขึ้นระบบ**

1. CI เขียว: `pnpm install --frozen-lockfile && pnpm run check:release` ผ่านบน commit ที่จะ deploy และ tag ไว้ (เช่น `git tag v1.0.0`)
2. Resource ของ env ครบ ([หัวข้อ 3](#3-environment-production-และ-staging)) และ `wrangler.jsonc` ไม่มีข้อความ `ใส่ ID จริง` เหลือใน env ที่จะใช้
3. Resend: domain ผู้ส่ง verify แล้ว (SPF/DKIM ขึ้น Verified) และส่งอีเมลทดสอบผ่าน ([หัวข้อ 8](#8-เชื่อมบริการภายนอก))
4. Turnstile widget มี hostname ครบ, OAuth redirect URI ตรง origin
5. ซ้อม restore แล้ว ([หัวข้อ 11.3](#113-restore-drill-ซ้อมทุกไตรมาส-และก่อน-go-live))

**วันขึ้นระบบ**

6. ฐานข้อมูล
   - ใหม่: `pnpm run db:init-sql:verify` แล้ว `pnpm run db:init:remote` ([หัวข้อ 4.1](#41-ฐานข้อมูลใหม่-ว่างเปล่า))
   - เดิม: `pnpm run db:backup` + จด bookmark จาก `npx wrangler d1 time-travel info netprime-db` → `npx wrangler d1 migrations apply netprime-db --remote` (apply `0008`–`0015` หรือที่ค้าง) → `migrations list` ต้องไม่มีรายการค้าง
7. Secrets: `JWT_SECRET` (บังคับ), `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`, `OMISE_SECRET_KEY`/Stream/OAuth ตามที่เปิดใช้, `NOTION_TOKEN` (ไม่บังคับ) ตรวจด้วย `npx wrangler secret list`
8. Vars: `FRONTEND_ORIGINS` และ `APP_URL` ใน `backend/wrangler.jsonc`, `API_BASE_URL` ใน `frontend-admin/wrangler.jsonc`, `VITE_API_BASE_URL` / `VITE_TURNSTILE_SITE_KEY` ใน `frontend-admin/.env.production`
9. Deploy backend: `pnpm run deploy:backend` → `curl https://api.example.com/` ได้ "operational"
10. Deploy frontend: `pnpm run deploy:frontend`
11. สร้าง admin คนแรก ([หัวข้อ 4.3](#43-สร้าง-admin-คนแรก-ไม่ต้องใช้คำเชิญ)) แล้ว login → กรอก "ตั้งค่าเว็บไซต์" (ข้อมูลติดต่อ, อีเมลรับแจ้งเตือน) และตั้งค่าการชำระเงิน (บัญชีรับโอนจริง)
12. เปิด Notification แจ้งเตือน error ([หัวข้อ 10](#10-monitoring-log-และการแจ้งเตือน))

**Smoke check หลัง deploy** (ใช้บัญชีจริงที่สร้างใหม่ ไม่มีบัญชีเดโมใน production)

- [ ] หน้าแรก, `/courses`, `/blog`, `/sitemap.xml`, `/robots.txt` เปิดได้ ไม่มี CORS error ใน console
- [ ] admin login/logout ได้; token ที่ logout แล้วใช้ต่อไม่ได้
- [ ] สมัครผู้เรียนใหม่ → ได้อีเมลยืนยัน และลิงก์ชี้ `APP_URL` ถูกต้อง; ลืมรหัสผ่าน → ได้อีเมลรีเซ็ต
- [ ] ส่งฟอร์มติดต่อและลงทะเบียนอบรม (ผ่าน Turnstile) → admin เห็นรายการ และอีเมลแจ้งเตือนถึง
- [ ] สร้างคอร์ส/บทเรียน, อัปโหลดไฟล์ (R2) แล้วเปิดดูได้; วิดีโอ Stream เล่นได้ (ถ้าใช้)
- [ ] ชำระเงิน test mode หรือโอน + อัปโหลดสลิป → อนุมัติ → เปิดสิทธิ์เรียน
- [ ] `POST /api/admin/site/jobs/run` สำเร็จ และ Workers Logs ไม่มี exception ใหม่

**Rollback** (ตัดสินใจภายใน 30 นาทีถ้า smoke check ไม่ผ่าน)

1. โค้ด: `npx wrangler rollback` ทั้ง backend และ frontend (หรือเลือกเวอร์ชันใน Dashboard → Deployments)
2. ข้อมูล: migration ที่เพิ่มตาราง/คอลัมน์มักไม่ต้องย้อน (โค้ดเก่าไม่อ่าน) ถ้าข้อมูลเสียหาย `npx wrangler d1 time-travel restore netprime-db --bookmark <bookmark จากขั้น 6>` (ข้อมูลที่เขียนหลังจากนั้นหาย) หรือนำเข้าไฟล์ backup ใส่ฐานข้อมูลใหม่แล้วสลับ `database_id`
3. ฐานข้อมูลใหม่ที่ init ผิด: ยังไม่มีข้อมูลจริง ลบแล้วสร้างใหม่ได้ (`d1 delete` → `d1 create` → แก้ ID → `db:init:remote`)
4. แจ้งผู้ใช้ผ่าน announcement ใน "ตั้งค่าเว็บไซต์" และบันทึกเหตุการณ์

## 15. ค่าใช้จ่ายโดยประมาณ

Workers Paid (ประมาณ $5/เดือน) รวมโควตา Workers, KV และ D1 ระดับเริ่มต้น; R2 คิดตามพื้นที่เก็บ (ไม่มีค่า egress); Stream คิดตามนาทีที่เก็บและนาทีที่เล่น; Workers AI มีโควตาฟรีรายวันแล้วคิดตาม neurons ตรวจราคาปัจจุบันที่ cloudflare.com/plans ก่อนประเมินงบ ค่าธรรมเนียม Omise และ Resend คิดแยก

## 16. ทดสอบบนเครื่อง (ไม่ต้องใช้บัญชี Cloudflare)

```bash
pnpm run check:release
```

```bash
pnpm run db:setup:local && pnpm run dev:backend:local
```

แล้วเปิดอีก terminal:

```bash
pnpm run dev:frontend:local
```

บัญชีเดโมอยู่ใน [TESTING.md](TESTING.md)
