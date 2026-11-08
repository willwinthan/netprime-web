# Agent-ready platform: ให้ AI agent ภายนอกทำงานกับระบบอย่างปลอดภัย

ระบบนี้**ไม่ได้สร้าง agent เอง** แต่เปิดช่องให้ agent ภายนอกต่อเข้ามาได้ เช่น Claude, Hermes ที่รันบน DGX Spark ในออฟฟิศ หรือ agent ใดก็ได้ที่เรียก HTTP API ได้ ทุก agent ใช้ **agent key** ของตัวเอง ระบบจึงรู้เสมอว่าใครทำอะไร งานที่ส่งถึงคนหรือเกี่ยวกับเงินต้องรอคนกดอนุมัติก่อน

สถานะ: **ระยะที่ 1 เสร็จแล้ว** (migration `0037_agent_platform.sql`)

| ระยะ | เนื้อหา | สถานะ |
|---|---|---|
| 1 | agent key, คิวรออนุมัติ, API v1 ส่วนงานประสานงาน, ฟีดเหตุการณ์แบบดึงเอง | ✅ |
| 2 | MCP server แบบอ่านอย่างเดียว (Agents SDK `createMcpHandler` + Workers OAuth Provider) โดยใช้ `GET /v1/tools` เป็นต้นแบบ | ⏳ |
| 3 | เปิด tool ระดับร่าง/ลงมือผ่าน MCP โดยยังผ่านคิวเดิม | ⏳ |
| 4 | ให้ agent ทำเองได้มากขึ้นทีละเรื่อง (เช่น อนุมัติอัตโนมัติตามเงื่อนไข) | ⏳ |

## 1. ตัวตนของ agent (agent key)

agent key คือแถวในตาราง `api_keys` ที่ `kind = 'agent'` ผู้ดูแลระบบสร้างได้ที่ **ตั้งค่าระบบ → API keys → สร้าง agent key** (ต้องมีสิทธิ์ `integrations.manage`) ค่าที่ตั้งได้มีดังนี้:

| ค่า | ความหมาย |
|---|---|
| scope | สิทธิ์ที่ key นี้ใช้ได้ ให้เท่าที่จำเป็น (ดูตารางด้านล่าง) |
| จำกัดต่อนาที | ค่าเริ่มต้นสำหรับ agent คือ 60 |
| โควตาต่อวัน | นับตามวันเวลาไทย เกินแล้วได้ `429 daily_quota_exceeded` |
| ช่วงเวลาและวัน | เช่น จันทร์–ศุกร์ 08:00–18:00 เวลาไทย นอกช่วงได้ `403 outside_allowed_hours` ถ้าเวลาสิ้นสุดน้อยกว่าเวลาเริ่ม แปลว่าข้ามเที่ยงคืน |
| IP ที่อนุญาต | IP หรือ IPv4 CIDR สูงสุด 20 รายการ (เช่น IP ขาออกของออฟฟิศ) IP อื่นได้ `403 ip_not_allowed` |
| หยุดชั่วคราว | ปุ่ม "หยุด" มีผลทันทีโดยไม่ต้องใช้รหัสยืนยันทางอีเมล (`403 key_paused`) ผู้ที่มีสิทธิ์ `agents.approve` กดหยุดได้ แต่การเปิดใช้อีกครั้งต้องมีสิทธิ์ `integrations.manage` ส่วนการเพิกถอนเป็นแบบถาวรและต้องใช้รหัสยืนยันทางอีเมลเหมือน key อื่น |

กฎที่ใช้กับ agent key เสมอ:
- **แก้ข้อมูลโดยตรงไม่ได้** `POST /v1/users` และ `POST /v1/enrollments` ตอบ `403 approval_required` ให้ส่งงานผ่าน `POST /v1/actions` แทน
- **บันทึกทุกคำขอ** ลงตาราง `agent_activity` รวมคำขอที่ถูกปฏิเสธ (method, path, status, IP, action id) ระบบเก็บไว้ 90 วัน งานที่ทำแทน agent ลง `admin_audit_log` พร้อม `api_key_id` หน้า "ประวัติการแก้ไข" แสดงชื่อ agent ส่วนผู้อนุมัติอยู่ใน `user_id`

### scope

| ระดับ | scope |
|---|---|
| อ่าน | `sessions:read` `registrations:read` `leads:read` `inquiries:read` `reports:read` `events:read` `orders:read` `courses:read` `users:read` `enrollments:read` |
| ร่าง | `leads:write` `inquiries:write` |
| ลงมือ | `orders:confirm` `registrations:write` `sessions:publish` `articles:publish` `messages:send` `enrollments:write` |

## 2. tool สามระดับและคิวรออนุมัติ

`GET /v1/tools` คืนรายการ tool ทั้งหมดพร้อม `input_schema` (JSON Schema) และบอกว่า key นี้ใช้ tool ไหนได้ (`available`) รูปแบบนี้ตั้งใจให้นำไปทำ MCP server ในระยะที่ 2 ได้ทันที

| ระดับ | ทำงานอย่างไร | tool |
|---|---|---|
| **อ่าน** | เรียก GET endpoint โดยตรง | `get_daily_ops_summary` `get_report_summary` `list_training_sessions` `list_registrations` `list_leads` `list_inquiries` `list_orders` `list_courses` `list_users` `list_enrollments` `get_events` |
| **ร่าง** | ทำทันที เปลี่ยนเฉพาะข้อมูลภายในที่ลูกค้าไม่เห็น | `update_lead` `update_inquiry` (เปลี่ยนสถานะและต่อท้ายบันทึกด้วยชื่อ agent) |
| **ลงมือ** | เข้าคิวรอคนอนุมัติ | `confirm_order` (payments.manage) `update_registration` (site.sessions, ส่งอีเมลแจ้งผู้สมัคร) `publish_session` (site.sessions) `publish_article` (articles.publish) `grant_enrollment` (users.manage) `send_email` (communication.manage) `send_line` (communication.manage) |

วงเล็บหลัง tool ระดับลงมือคือสิทธิ์ที่ผู้อนุมัติต้องมี**เพิ่มจาก** `agents.approve`

### การส่งงาน

```http
POST /api/v1/actions
Authorization: Bearer npk_…
Idempotency-Key: confirm-NP-260012

{ "tool": "confirm_order",
  "input": { "order_id": "NP-260012", "amount_received": 5915 },
  "reason": "ยอดโอนตรงกับ statement ธนาคาร",
  "dry_run": false,
  "expires_in_hours": 72 }
```

| ผลลัพธ์ | ความหมาย |
|---|---|
| `200 dry_run: true` | ตรวจและแสดงตัวอย่างเท่านั้น ไม่บันทึกอะไร (`preview.summary`, `preview.warnings`) |
| `201` | งานระดับร่างทำเสร็จแล้ว |
| `202 requires_approval: true` | งานระดับลงมือเข้าคิวแล้ว สถานะ `pending` |
| `200 replayed: true` | ส่ง idempotency key ซ้ำด้วยข้อมูลเดิม ได้งานเดิมคืน ไม่สร้างใหม่ |
| `409 idempotency_conflict` | ใช้ idempotency key เดิมกับข้อมูลอื่น |
| `404 / 409 / 422` | ไม่พบเป้าหมาย สถานะไม่ถูกต้อง (`invalid_state`, `no_change`) หรือทำไม่ได้ (`unknown_recipient`, `line_not_linked`) |
| `429 queue_full` | มีงานรออนุมัติครบ 100 รายการต่อ key |

สถานะของงาน: `pending` → `executing` → `executed` หรือ `failed` ส่วน `pending` ที่ไม่ได้ทำจะจบที่ `rejected` (คนไม่อนุมัติ) `cancelled` (agent ถอนเองด้วย `POST /v1/actions/{id}/cancel`) หรือ `expired` (เกินเวลา ค่าเริ่มต้น 72 ชั่วโมง) agent ดูผลได้ที่ `GET /v1/actions/{id}` หรือจากฟีดเหตุการณ์ `action.updated`

### การอนุมัติในคอนโซล

เมนู **ระบบและผู้ดูแล → คิวอนุมัติ AI agent** (สิทธิ์ `agents.approve` ซึ่งผู้ดูแลระบบต้องให้บทบาทอื่นเองในหน้าผู้ใช้และสิทธิ์)
1. เปิดงาน ระบบดึงสถานะล่าสุดของเป้าหมายมาแสดง (เช่น คำสั่งซื้อยังรอตรวจอยู่หรือไม่ มีสลิปหรือยัง)
2. กด "อนุมัติและทำรายการ" ระบบตรวจข้อมูลอีกครั้ง ถ้าข้อมูลเปลี่ยนไปแล้ว (เช่น มีคนยืนยันคำสั่งซื้อไปก่อน) งานจะเป็น `failed` และไม่ทำซ้ำ
3. งานที่มีหน้าจอเจ้าหน้าที่อยู่แล้ว (ยืนยันการชำระเงิน เปลี่ยนสถานะผู้สมัคร เปิดรอบ เผยแพร่บทความ) วิ่งผ่าน **route เดิมด้วย token ของผู้อนุมัติ** (`utils/dispatch.ts`) ผลจึงเหมือนกดปุ่มเองทุกอย่าง ทั้งใบเสร็จ อีเมล การเปิดสิทธิ์ และ audit
4. ไม่อนุมัติต้องระบุเหตุผล agent จะเห็นใน `decision_note`

## 3. API v1 ส่วนงานประสานงาน

| Endpoint | scope | หมายเหตุ |
|---|---|---|
| `GET /v1/me` | key ใดก็ได้ | scope โควตา ช่วงเวลา จำนวนงานรออนุมัติ |
| `GET /v1/training-sessions` `…/{id}` | sessions:read | มี `seats_taken`, `seats_left`, `pending_registrations`, `waitlist` กรอง `status`, `from`, `to` |
| `GET /v1/registrations` | registrations:read | กรอง `session_id`, `status`, `since` (ISO, เทียบ updated_at) |
| `GET /v1/leads` | leads:read | กรอง `status`, `form_id`, `since` |
| `GET /v1/inquiries` | inquiries:read | กรอง `status`, `since` |
| `GET /v1/reports/summary?from=&to=` | reports:read | ผู้เรียนใหม่ การลงทะเบียนเรียน เรียนจบ คำสั่งซื้อ/รายได้ ผู้สมัครอบรม lead ข้อความติดต่อ (เวลาไทย ไม่เกิน 366 วัน) |
| `GET /v1/ops/daily-summary?date=` | reports:read | **get_daily_ops_summary** รอบอบรมใน 7 วัน สลิปรอยืนยัน ผู้สมัครรอตรวจ ข้อความ/lead ใหม่ อีเมลส่งไม่สำเร็จ งานรออนุมัติ และ `highlights` เป็นประโยคภาษาไทย |

ทุกรายการใช้ cursor pagination แบบเดียวกับ API เดิม (`limit`, `cursor` → `next_cursor`) เอกสาร OpenAPI อยู่ที่ `GET /v1/openapi.json`

## 4. ฟีดเหตุการณ์แบบดึงเอง

DGX Spark อยู่ในออฟฟิศและไม่ควรเปิดรับ webhook จากภายนอก agent จึงมาดึงเหตุการณ์เอง:

```http
GET /api/v1/events?since=1234&types=registration.created,inquiry.created,order.paid,action.updated
```

- ครั้งแรกไม่ต้องส่ง `since` ระบบคืนเหตุการณ์ 24 ชั่วโมงล่าสุด
- เก็บค่า `next_since` ไว้ แล้วส่งในครั้งถัดไป ถ้า `has_more: true` ให้เรียกต่อทันที
- เหตุการณ์ที่มี: ทุกเหตุการณ์ของ webhook (`user.created` `enrollment.created` `order.paid` `registration.created` `lead.created` `inquiry.created` …) และ `action.updated` ซึ่งเป็นผลของงานที่ key นี้ส่งเอง (key อื่นไม่เห็น)
- ข้อมูลมาจากตาราง `user_events` การเรียกทุก 1–5 นาทีเพียงพอ

## 5. ตัวอย่าง agent บน DGX Spark

```text
ทุก 5 นาที:
  events = GET /v1/events?since=<saved>   → บันทึก next_since
  ถ้ามี registration.created หรือ inquiry.created → อ่านรายละเอียด → update_inquiry (ร่าง) ใส่บันทึกสรุป
ทุกเช้า 08:30:
  summary = GET /v1/ops/daily-summary     → ส่งสรุปให้ทีมทางช่องทางของ agent เอง
  ถ้ามีสลิปรอยืนยันและยอดตรง statement → POST /v1/actions confirm_order (Idempotency-Key: confirm-<reference>)
  → เจ้าหน้าที่กดอนุมัติในคอนโซล
```

ข้อแนะนำ: ตั้ง IP allowlist เป็น IP ขาออกของออฟฟิศ ตั้งช่วงเวลาให้ตรงเวลาทำงาน ให้ scope ระดับลงมือเฉพาะเรื่องที่ต้องใช้ และใช้ idempotency key ทุกครั้งที่ส่งงาน เพื่อให้ retry ได้ปลอดภัย

## 6. ส่วนที่เกี่ยวข้องในโค้ด

| ไฟล์ | หน้าที่ |
|---|---|
| `backend/migrations/0037_agent_platform.sql` | คอลัมน์ agent ใน `api_keys`, `admin_audit_log.api_key_id`, ตาราง `agent_actions` และ `agent_activity` |
| `backend/src/middleware/apikey.ts` | ตรวจ key, pause, IP, ช่วงเวลา, scope, การเขียนตรง, โควตา และบันทึกคำขอ |
| `backend/src/utils/agentTools.ts` | ทะเบียน tool, การตรวจ input, dry run, การทำงานและการหมดอายุ |
| `backend/src/utils/dispatch.ts` | เรียก route ของ Worker เองภายในด้วย token ผู้อนุมัติ |
| `backend/src/handlers/agentApi.ts` | endpoint v1 ใหม่, คิว และฟีดเหตุการณ์ |
| `backend/src/handlers/agents.ts` | API ของคอนโซล `/api/admin/agents/*` |
| `frontend-admin/src/pages/AgentQueuePage.tsx` | หน้าคิวอนุมัติ |
| `frontend-admin/src/components/settings/ApiKeysPanel.tsx` | สร้างและแก้ agent key |
| `tests/agents.test.mjs` | `pnpm run test:agents` |

ข้อควรรู้: ก่อน deploy backend รุ่นนี้ต้อง apply migration 0037 กับ D1 ก่อน (`pnpm run db:backup` แล้ว `wrangler d1 migrations apply`) เพราะ middleware อ่านคอลัมน์ใหม่ของ `api_keys` ถ้ายังไม่ได้ apply API key ทุกตัวรวม integration เดิมจะใช้ไม่ได้
