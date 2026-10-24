# Netprime LMS

ระบบ LMS แบบ workspace: React + Vite ที่ `frontend-admin/` และ Hono บน Cloudflare Workers ที่ `backend/` ใช้ D1, R2, KV และ Workers AI

**สถานะ ณ 6 ตุลาคม 2026:** `check:release` ผ่านบนข้อมูลทดสอบแยกแล้ว แต่ยังไม่ผ่าน UAT หรือทดสอบ OAuth/การชำระเงิน/อีเมล/วิดีโอกับผู้ให้บริการจริง อ่าน [แผนพัฒนา](docs/DEVELOPMENT-PLAN.md), [รายงาน baseline เดิม](docs/PROJECT-READINESS.md) และ [คู่มือทดสอบ](docs/TESTING.md) ก่อน UAT

**เอกสารส่งต่อ (24 ตุลาคม 2026):** [สถาปัตยกรรมระบบ](docs/ARCHITECTURE.md) · [สิ่งที่ยังไม่สมบูรณ์และต้องทำก่อนเปิดใช้งาน](docs/GAP-ANALYSIS.md) · [คู่มือติดตั้งบน Cloudflare](docs/CLOUDFLARE-DEPLOY.md) · [คู่มือเจ้าหน้าที่จัดการเว็บไซต์](docs/ADMIN-GUIDE.md) · [เว็บไซต์สาธารณะและ URL](docs/PUBLIC-SITE.md)

## เริ่มทดสอบบนเครื่อง

ตรวจด้วย Node 22.23.1 และ pnpm 10.33.0 ใช้ pnpm workspace และ `pnpm-lock.yaml` เป็นหลัก

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run test:readiness
```

- `check`: TypeScript ทั้งสองส่วน, smoke/auth/outsource/business tests, frontend build
- `test:readiness`: acceptance gates 11 รายการ ปัจจุบันผ่าน 11/11 บน local fixture
- `check:release`: รวมสองชุด ใช้เป็นหนึ่งในเงื่อนไขก่อนปล่อยระบบ ต้องผ่าน UAT และทดสอบบริการจริงเพิ่มเติมด้วย

ชุด API tests เปิด Worker เฉพาะ `127.0.0.1` สร้าง D1/KV/R2 ชั่วคราว และลบทิ้งหลังทดสอบ ใช้ seed จาก `backend/schema.sql` โดยไม่ใช้ database ID จริง ไม่เรียกบริการชำระเงิน อีเมล หรือ AI จริง

## เปิดหน้าเว็บทดสอบ

```sh
pnpm run db:setup:local
pnpm run dev:backend:local
```

เปิดอีก terminal:

```sh
pnpm run dev:frontend:local
```

เปิด URL ที่ Vite แสดง บัญชีเดโมอยู่ใน [คู่มือทดสอบ](docs/TESTING.md) คำสั่ง frontend แบบ local บังคับใช้ API บนเครื่อง แม้ `.env` เดิมจะชี้ไป Workers ที่ deploy แล้ว

`db:setup:local` ล้างและสร้างใหม่เฉพาะฐานข้อมูล local สำหรับทดสอบ คำสั่งเดิม `db:setup:remote` (รัน schema ที่มี `DROP TABLE` กับ remote) ถูกลบแล้ว ฐานข้อมูล Cloudflare ใหม่ใช้ `pnpm run db:init:remote` (สร้างจาก `scripts/build-init-sql.mjs` ไม่มี DROP และข้อมูลเดโม) ฐานข้อมูลเดิมให้ใช้ migration ใน `backend/migrations/` หลัง `pnpm run db:backup` ดู [คู่มือ deploy](docs/CLOUDFLARE-DEPLOY.md)

โฟลเดอร์นี้เริ่ม Git repository แล้ว (branch `main`, ยังไม่มี commit แรกและ remote) CI อยู่ที่ `.github/workflows/ci.yml` รัน `pnpm run check:release` ทุก push/PR ประวัติก่อนหน้านี้ไม่มีใน Git จึงยืนยันสถานะเทียบกับระบบที่ deploy อยู่ไม่ได้
