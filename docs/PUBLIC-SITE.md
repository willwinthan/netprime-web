# เว็บไซต์สาธารณะ (หน้าแรก หลักสูตร ตารางอบรม บทความ)

อัปเดต 24 ตุลาคม 2026 · ทำตามแบบใน [NetPrime Website & CMS Redesign](https://claude.ai/artifact/3EEpStpLiRVPbznLVRN6Ub)

## URL

| URL | หน้า | ข้อมูลจาก |
| --- | --- | --- |
| `/` | หน้าแรก | ตั้งค่าเว็บไซต์, โปรโมชั่น, รอบอบรม, คอร์ส, บทความล่าสุด |
| `/courses` | คอร์สออนไลน์ (ค้นหา + กรองแบรนด์ + รายละเอียดคอร์ส) | `GET /api/courses` |
| `/schedule` | ตารางอบรมและลงทะเบียน | `GET /api/public/sessions` |
| `/blog` | รวมบทความ (`?category=`, `?q=`, `?page=`) | `GET /api/public/articles` |
| `/blog/:slug` | อ่านบทความ | `GET /api/public/articles/:slug` |
| `/about` | เกี่ยวกับเรา + ติดต่อ | ข้อความในโค้ด (รอ CMS หน้าเว็บ) |
| `/dashboard` | คอนโซลหลังเข้าสู่ระบบ (เดิมอยู่ที่ `/`) | — |
| `/verify-certificates?code=` | ตรวจสอบใบประกาศ (เหมือนเดิม) | — |

- ผู้ที่เข้าสู่ระบบแล้วยังเปิดเว็บสาธารณะได้ทุกหน้า และจะเห็นปุ่ม "แดชบอร์ดของฉัน" ที่ header
- หลังเข้าสู่ระบบระบบจะพาไปที่ `/dashboard` ส่วนการออกจากระบบจะพากลับ `/`
- ถ้ายังไม่ได้เข้าสู่ระบบแล้วเปิด `/dashboard` จะเห็นหน้าแรกพร้อมหน้าต่างเข้าสู่ระบบ
- Router เขียนเองใน `frontend-admin/src/site/router.tsx` ไม่ได้ใช้ library เพิ่ม Vite dev server และ Workers static assets (`not_found_handling: single-page-application`) ส่ง `index.html` ให้ทุก path อยู่แล้ว จึงไม่ต้องตั้งค่าเพิ่มตอน deploy

## ไฟล์

```
frontend-admin/src/site/
├── PublicSite.tsx   # route → หน้า, CoursesPage, SchedulePage, AboutPage, 404
├── HomePage.tsx     # หน้าแรก (FAQ/จุดเด่นเป็นข้อความในโค้ดจนกว่าจะมี CMS หน้าเว็บ)
├── BlogPage.tsx     # /blog
├── BlogPostPage.tsx # /blog/:slug
├── Markdown.tsx     # ตัวแปลง Markdown → React (ไม่ใช้ innerHTML)
├── shared.tsx       # layout, หน้าต่าง login/สมัคร, การ์ดคอร์ส/บทความ
├── router.tsx       # navigate, Link, useLocation, usePageMeta
└── site.css         # สไตล์เฉพาะเว็บสาธารณะ (ครอบด้วย .ps)
```

ฟอร์มลงทะเบียนอบรม (`ScheduleSection`) และฟอร์มติดต่อ (`ContactSection`) ใช้ของเดิมใน `components/site/PublicSections.tsx` ซึ่งมีเทสต์รองรับแล้ว

## เนื้อหาบทความ (Markdown)

ช่อง "เนื้อหา" ในเมนูจัดการเว็บไซต์รองรับ:

| เขียน | ผลลัพธ์ |
| --- | --- |
| เว้นบรรทัดว่าง | ขึ้นย่อหน้าใหม่ |
| `## หัวข้อ` / `### หัวข้อย่อย` | หัวข้อ (หัวข้อ `##` ขึ้นในสารบัญด้านข้างเมื่อมีตั้งแต่ 2 หัวข้อ) |
| `- รายการ` / `1. รายการ` | รายการ |
| `**ตัวหนา**`, `*ตัวเอียง*`, `` `โค้ด` `` | รูปแบบตัวอักษร |
| `[ข้อความ](https://...)` | ลิงก์ (รับเฉพาะ http/https/mailto และลิงก์ภายในเว็บ) |
| `![คำอธิบาย](ลิงก์รูป)` | รูปภาพ |
| `> ข้อความ` | กล่องอ้างอิง |
| บรรทัด ```` ``` ```` เปิด/ปิด | กล่องโค้ด |

บทความเก่าที่เป็นข้อความธรรมดายังแสดงผลได้ตามเดิม

## ความเชื่อมโยงอัตโนมัติ

- **หน้าอ่านบทความ:** ถ้าหมวดหมู่ตรงกับแบรนด์ของรอบอบรม (เช่น Cisco) จะแสดงการ์ดรอบอบรมถัดไปที่เปิดรับ และคอร์สออนไลน์ของแบรนด์เดียวกันในแถบข้าง
- **บทความที่เกี่ยวข้อง:** ใช้หมวดเดียวกันก่อน ถ้าไม่พอจะเติมด้วยบทความล่าสุด
- **ราคาคอร์ส:** ปุ่มของคอร์สที่มีราคาเป็น "สอบถามคอร์สนี้" เพราะยังไม่เปิดชำระเงินออนไลน์

## ตัวอย่างลิงก์ตอนแชร์ (LINE, Facebook) และ sitemap

LINE/Facebook ไม่รัน JavaScript จึงต้องได้ tag จากเซิร์ฟเวอร์ Worker ใน `frontend-admin/worker/` ทำสิ่งนี้เฉพาะ path ที่ระบุใน `run_worker_first` ของ `wrangler.jsonc` ไฟล์ JS, CSS และรูปยังเสิร์ฟตรงจาก assets

| URL | ผลลัพธ์ |
| --- | --- |
| `/blog/:slug` | `<title>`, description, `og:*`, `twitter:*`, `article:published_time`, canonical ของบทความ รูปคือรูปปกของบทความ ถ้าไม่มีใช้ `/og-default.jpg` (1200×630) |
| `/blog/:slug` ที่ไม่มีอยู่ | HTTP 404 + `noindex` (หน้าเว็บยังแสดงข้อความ "ไม่พบบทความ") |
| `/`, `/courses`, `/schedule`, `/blog`, `/about` | title/description ของหน้า และ og:url/og:image แบบ URL เต็ม |
| `/sitemap.xml` | หน้าหลัก 5 หน้า + บทความที่เผยแพร่ทั้งหมด (`lastmod` = วันเผยแพร่) cache 1 ชั่วโมง |
| `/robots.txt` | อนุญาตทุกหน้า ยกเว้น `/dashboard` และชี้ไป sitemap |

- ต้องตั้ง `API_BASE_URL` ใน `frontend-admin/wrangler.jsonc` (ดู [CLOUDFLARE-DEPLOY.md](CLOUDFLARE-DEPLOY.md) หัวข้อ 7)
- ข้อมูลบทความดึงจาก API (cache 5 นาที) ถ้า API ล่ม หน้าเว็บยังเปิดได้ เพียงใช้ tag ค่าเริ่มต้น
- ฟังก์ชันสร้าง tag อยู่ใน `worker/meta.ts` และมีเทสต์ใน `tests/share-meta.test.mjs` (escape, URL ไม่ปลอดภัย, sitemap)
- ทดสอบบนเครื่อง: `cd frontend-admin && npx vite build && npx wrangler dev --var API_BASE_URL:http://127.0.0.1:8788/api` แล้วใช้ `curl` เปิด `/blog/<slug>` เพื่อดู tag

## ข้อจำกัดและงานถัดไป

1. **CMS หน้าเว็บ:** ข้อความ Hero, จุดเด่น, FAQ และหน้าเกี่ยวกับเราอยู่ในโค้ด จะย้ายไปแก้จากหลังบ้านในเฟสถัดไป
2. **แบรนด์ของคอร์ส:** เดาจากชื่อคอร์ส เพราะตาราง `courses` ไม่มีคอลัมน์ vendor
3. **ผู้เขียนบทความ:** แสดงชื่อบัญชีที่สร้างบทความ ถ้าไม่มีจะแสดง "ทีมงาน NetPrime"
4. **หน้าแรกเดิม:** `pages/Landing.tsx` ไม่ถูกใช้แล้ว แต่ยังไม่ได้ลบ เพราะโปรเจกต์ไม่มี Git ลบได้หลังตรวจรับเว็บใหม่

## Website builder pages, theme, i18n and PWA (v0.5)

- Custom pages from "ออกแบบเว็บไซต์" render at `/p/:slug` (`src/site/CustomPage.tsx`, blocks in `src/components/builder/PageBlocks.tsx`). API: `GET /api/public/website/pages/:slug` (published only), `/api/public/website/pages` (sitemap list), `/api/public/website/nav`, `/api/public/website/theme`, `/api/public/website/certificate-template?course_id=|code=`; console API under `/api/website/*` (`website.design`), see `backend/src/handlers/website.ts`.
- The frontend Worker adds share tags for `/p/:slug`, lists published pages in `sitemap.xml`, and serves `/manifest.webmanifest` with the school name from the theme. **`wrangler.jsonc` must add `"/p/*"` and `"/manifest.webmanifest"` to `assets.run_worker_first`** for those to run; without it the SPA still renders the pages and the static `public/manifest.webmanifest` is served.
- Theme: CSS variables `--np-primary`, `--np-primary-dark`, `--np-primary-tint`, `--np-accent`, `--np-secondary`, `--np-radius`, `--np-font` on `<html>` (set by `src/components/builder/theme.tsx`; cached in localStorage and re-applied by an inline script in `index.html`). `site.css` falls back to the built-in colors when unset; the console's `--color-brand-primary` is overridden too.
- i18n: `src/i18n/dictionary.ts` (th/en, every key in both — `node --test tests/i18n-keys.test.mjs`), `useI18n()` / `t()` / `<LanguageSwitcher />` from `src/i18n`. The choice is stored in localStorage `netprime.lang`; `<html lang>` follows it on the public site.
- PWA: `public/manifest.webmanifest`, `public/sw.js` (network-first HTML with `/offline.html`, cache-first static assets, never `/api` or other origins; imports `/push-handler.js` when deployed), icons in `public/icons/` (generated from `logo/NetPrimeLogo.png`: 192, 512, maskable 512, apple-touch 180, favicon 32). `public/_headers` keeps `sw.js` uncached. Registration and the "มีเวอร์ชันใหม่ — รีโหลด" banner live in `src/pwa/` (second entry module in `index.html`, production builds only).
