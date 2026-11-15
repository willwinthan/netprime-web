# Virtual Lab

Virtual Lab คือ lab เครือข่ายจำลองที่ผู้เรียนทำบนเว็บได้เลย ผู้เรียนพิมพ์คำสั่งในเทอร์มินัลของอุปกรณ์จำลอง (router, switch, PC, server) และระบบตรวจผลจาก **สถานะของอุปกรณ์** ไม่ได้ตรวจว่าพิมพ์คำสั่งอะไร lab ที่ทำผ่านครบทุกข้อจะนับเป็นบทเรียนที่เรียนจบ จึงเป็นเงื่อนไขของการเรียนจบคอร์สและการออกใบประกาศเหมือนบทเรียนอื่น

ตัวจำลองอยู่ที่ `packages/lab-engine` (ดู README ในนั้นเรื่องที่มาของ engine และคำสั่งที่รองรับ) ส่วน API อยู่ที่ `backend/src/handlers/labs.ts`

## ใครทำอะไร

| ผู้ใช้ | ทำอะไรได้ | อยู่ที่ไหน |
|---|---|---|
| เจ้าหน้าที่ที่มีสิทธิ์ `labs.manage` (coordinator ได้เป็นค่าเริ่มต้น, admin ได้เสมอ) | สร้าง แก้ ลองทำ เผยแพร่ lab และดูผลของผู้เรียน | เมนู **Virtual Lab** ในหมวดงานอบรมและหลักสูตร |
| ผู้สอน | เพิ่มบทเรียนชนิด **Virtual Lab** ในคอร์ส แล้วเลือก lab ที่เผยแพร่แล้ว | ตัวสร้างคอร์ส > เพิ่มบทเรียน |
| ผู้เรียนที่ลงทะเบียนคอร์ส | ทำ lab ในบทเรียน ระบบบันทึกงานอัตโนมัติ กลับมาทำต่อได้ | หน้าเรียนของคอร์ส |

## ขั้นตอนของเจ้าหน้าที่

1. เมนู Virtual Lab > **สร้าง lab** จะเปิดแท็บ **ออกแบบบนบอร์ด** โดยมีตัวอย่าง LAB-001 วางไว้ให้ (หรือกด "เริ่มบอร์ดว่าง")
   - ลาก Router, Switch, PC หรือ Server จากแถบอุปกรณ์มาวางบนบอร์ด หรือคลิกเพื่อเพิ่ม ลากย้ายตำแหน่งได้
   - กด **สาย LAN** แล้วคลิกอุปกรณ์สองตัวเพื่อต่อสาย ระบบเลือกพอร์ตว่างให้ (router/switch พอร์ตเต็มจะเพิ่มพอร์ตให้, PC/Server มีพอร์ตเดียว) และเปลี่ยนพอร์ตได้ที่แผงด้านขวา
   - คลิกอุปกรณ์เพื่อตั้ง hostname และสถานะตั้งต้น:
     - Router: เพิ่ม/ลบพอร์ต, เปิดพอร์ตไว้แล้วหรือยัง, IP ตั้งต้น และ static route ตั้งต้น (ปกติเว้นว่างให้ผู้เรียนใส่เอง)
     - Switch: 8 พอร์ตเปิดอยู่แล้ว ไม่มี IP (layer 2, VLAN เดียว) ปิดพอร์ตตั้งต้นได้ถ้าอยากให้ผู้เรียนเปิดเอง
     - PC/Server: IP, mask และ default gateway ตั้งต้น (เว้นว่างให้ผู้เรียนตั้งด้วย `ipconfig`)
   - ใส่แผน IP (แถวของ PC/Server ใส่ default gateway ได้) แล้วกด **สร้างโจทย์จากแผน IP** ระบบจะสร้าง:
     - ตั้ง IP ทุกพอร์ตในแผน และ default gateway ของ PC/Server ที่ระบุ
     - สายต้อง up/up เมื่อทั้งสองฝั่งอยู่ในแผน หรือมีพอร์ตที่เริ่มแบบปิด
     - ping ถึงกันข้ามสายที่ทั้งสองฝั่งอยู่ในแผน และ ping ระหว่าง PC/Server ทุกคู่ในแผน (ถ้าอยู่คนละเครือข่าย router ต้องมี route ทั้งไปและกลับ)
     - แก้หรือเพิ่มโจทย์เองได้ทุกข้อ
   - ด้านล่างบอร์ดบอกตลอดว่านิยาม lab ยังต้องแก้ตรงไหน
   - แท็บ **JSON (ขั้นสูง)** แก้นิยามเดียวกันเป็นข้อความได้ สองแท็บใช้ข้อมูลชุดเดียวกัน
2. กด **ตรวจรูปแบบ** ถ้าผิด ระบบจะบอกตำแหน่งใน JSON เช่น `$.links[0].b` พร้อมเหตุผล
3. กด **ลองทำ** เพื่อทำ lab เองในหน้าต่างทดลอง (ไม่บันทึกผล)
4. กด **สร้าง (ฉบับร่าง)** แล้วกด **เผยแพร่** ผู้สอนจึงจะเห็น lab นี้ในรายการ

กฎที่ควรรู้

- แก้นิยาม lab แล้วเวอร์ชันจะขึ้นเองและเก็บทุกเวอร์ชันไว้ (`lab_versions`) งานที่ผู้เรียนทำค้างกับเวอร์ชันเก่าจะต้องเริ่มใหม่ ส่วนผลที่ผ่านไปแล้วยังอยู่และบันทึกไว้ว่าผ่านกับเวอร์ชันไหน
- ยกเลิกการเผยแพร่ไม่ได้ถ้ายังมีบทเรียนใช้ lab นั้น
- ลบ lab ไม่ได้ถ้ามีบทเรียนใช้อยู่ หรือมีผู้เรียนเคยทำแล้ว (ผลเป็นหลักฐานการเรียน) ให้ยกเลิกการเผยแพร่แทน

## การตรวจผลและใบประกาศ

- เบราว์เซอร์รัน lab ให้เห็นผลทันที และส่ง **ปุ่มที่ผู้เรียนกดทั้งหมด** (transcript) ไปที่ `PUT /api/student/lessons/:id/lab` ประมาณ 1.5 วินาทีหลังหยุดพิมพ์
- Worker เอา transcript ไป **เล่นซ้ำ** จากสถานะตั้งต้นของ lab ด้วย engine ตัวเดียวกัน แล้วตรวจทุกข้อเอง ค่า `passed` หรือผลใด ๆ ที่เบราว์เซอร์ส่งมาจะไม่ถูกใช้
- ผ่านครบทุกข้อครั้งแรก ระบบบันทึก `passed_at`, เวอร์ชันของ lab, เวอร์ชันของ engine และ transcript ที่ผ่านไว้ใน `lab_progress` แล้วบันทึกบทเรียนว่าเรียนจบ (ความคืบหน้าของคอร์สและเงื่อนไขใบประกาศใช้กฎเดิมทั้งหมด)
- ผู้เรียนกด "ทำเครื่องหมายว่าเรียนแล้ว" กับบทเรียน lab ไม่ได้ (API ตอบ 400)
- กด **เริ่มใหม่** จะล้างงานที่ทำค้าง นับครั้งที่ทำ (`attempts`) เพิ่ม แต่ไม่ลบผลที่ผ่านแล้ว
- เจ้าหน้าที่และผู้สอนที่เปิดดูบทเรียนในโหมดตัวอย่างจะได้ผลตรวจ แต่ไม่ถูกบันทึก
- transcript จำกัด 128K ตัวอักษรและ 20,000 ชิ้น นิยาม lab จำกัด 256 KB
- ข้อมูล `lab_progress` รวมอยู่ในการส่งออกข้อมูลส่วนบุคคล (PDPA) ของผู้เรียน

## รูปแบบนิยาม lab (JSON)

```jsonc
{
  "schemaVersion": 1,
  "id": "LAB-001",               // รหัสของ lab
  "version": "0.1.0",
  "title": "Basic IPv4 Connectivity",
  "profile": "generic-iosxe-like-v0",   // ตอนนี้มี profile เดียว
  "instructions": {
    "summary": "โจทย์ที่ผู้เรียนเห็นด้านบน",
    "scopeNote": "หมายเหตุสั้น ๆ (ไม่บังคับ)",
    "addressingPlan": [            // ตารางแผน IP ที่แสดงให้ผู้เรียน (ไม่บังคับ)
      { "device": "r1", "interface": "gi1", "address": "10.12.12.1", "mask": "255.255.255.0" },
      { "device": "pc1", "interface": "gi0", "address": "10.12.12.10", "mask": "255.255.255.0", "gateway": "10.12.12.1" }
    ]
  },
  "devices": [
    {
      "id": "r1", "kind": "router", "hostname": "R1",   // kind: router (ค่าเริ่มต้น), switch, pc, server
      "layout": { "x": 210, "y": 95 },  // ตำแหน่งในแผนผัง
      "interfaces": [
        { "id": "gi1", "type": "GigabitEthernet", "number": 1, "mac": "0200.0001.0001",
          "mtu": 1500, "bandwidthKbps": 1000000, "adminUp": false, "ipv4": null }
      ],
      "routes": [ { "network": "10.0.0.0", "mask": "255.0.0.0", "nextHop": "10.12.12.2" } ]  // router เท่านั้น ไม่บังคับ
    },
    { "id": "sw1", "kind": "switch", "hostname": "SW1", "layout": { "x": 400, "y": 95 },
      "interfaces": [ /* พอร์ต GigabitEthernet แบบเดียวกัน แต่ ipv4 ต้องเป็น null */ ] },
    { "id": "pc1", "kind": "pc", "hostname": "PC1", "layout": { "x": 600, "y": 95 },
      "interfaces": [ /* การ์ดเครือข่ายเดียว เช่น gi0 */ ],
      "gateway": null }                 // pc/server เท่านั้น: default gateway ตั้งต้น หรือ null
  ],
  "links": [
    { "id": "l1", "kind": "ethernet", "a": { "device": "r1", "interface": "gi1" }, "b": { "device": "r2", "interface": "gi1" } }
  ],
  "objectives": [
    { "id": "r1_addr", "check": "interfaceIpv4Equals", "title": "...", "description": "...", "hints": ["..."],
      "params": { "device": "r1", "interface": "gi1", "address": "10.12.12.1", "mask": "255.255.255.0" } },
    { "id": "link_up", "check": "interfacesOperUp", "title": "...", "description": "...", "hints": [],
      "params": { "endpoints": [{ "device": "r1", "interface": "gi1" }, { "device": "r2", "interface": "gi1" }] } },
    { "id": "ping", "check": "bidirectionalReachability", "title": "...", "description": "...", "hints": [],
      "params": { "a": { "device": "r1", "address": "10.12.12.1" }, "b": { "device": "r2", "address": "10.12.12.2" } } }
  ]
}
```

ชนิดข้อที่ต้องทำ (`check`) ที่ engine รุ่นนี้รองรับมีสี่แบบ

- `interfaceIpv4Equals`: อินเทอร์เฟซมี IP และ mask ตามที่กำหนด (ใช้กับพอร์ต switch ไม่ได้)
- `interfacesOperUp`: อินเทอร์เฟซทุกตัวในรายการ up/up
- `bidirectionalReachability`: อุปกรณ์สองตัว ping ถึงกันได้ทั้งสองทาง แพ็กเก็ตผ่าน switch และ router ได้หลาย hop ตาม route ที่ตั้งไว้ และขากลับต้องมี route ด้วย
- `defaultGatewayEquals` (`params: { device, gateway }`): PC/Server มี default gateway ตามที่กำหนด

## คำสั่งที่ผู้เรียนใช้ได้

- Router: `enable`, `configure terminal`, `hostname`, `interface`, `ip address`, `shutdown` / `no shutdown`, `ip route <network> <mask> <next hop>` / `no ip route ...`, `do`, `exit` / `end`, `ping`, `show ip interface brief`, `show ip route`, `show running-config`, `show interfaces`
- Switch: คำสั่งแบบเดียวกับ router ยกเว้น `ip address`, `ip route` และ `show ip route` (switch ใน lab นี้เป็น layer 2 อย่างเดียว)
- PC/Server: prompt `C:\>` ใช้ `ipconfig` (ดูค่า), `ipconfig <IP> <mask> [<gateway>]` (ตั้งค่า) และ `ping <IP>`
- ยังไม่รองรับ: VLAN หลายวง, trunk, STP, DHCP, routing แบบ dynamic (OSPF/RIP/EIGRP), ACL, NAT

ข้อความที่แสดงให้ผู้เรียน (`title`, `description`, `hints`, `summary`) เขียนเป็นภาษาไทยได้

## API

| Method และ path | ใครเรียก | ทำอะไร |
|---|---|---|
| `GET /api/labs` | `labs.manage` | รายการ lab พร้อมจำนวนบทเรียนและผู้เรียน |
| `POST /api/labs/validate` | `labs.manage` | ตรวจนิยาม lab โดยไม่บันทึก |
| `POST /api/labs` | `labs.manage` | สร้าง lab ฉบับร่าง |
| `GET/PATCH/DELETE /api/labs/:id` | `labs.manage` | ดู แก้ (นิยามเปลี่ยน = เวอร์ชันใหม่) ลบ |
| `POST /api/labs/:id/publish`, `/unpublish` | `labs.manage` | เผยแพร่ / ยกเลิก |
| `GET /api/labs/:id/progress` | `labs.manage` | ผลของผู้เรียน |
| `GET /api/instructor/lab-options` | ผู้สอน, admin | lab ที่เผยแพร่แล้วสำหรับเลือกในบทเรียน |
| `PUT /api/student/lessons/:id/lab` | ผู้เรียน | ส่ง `{ lab_version, transcript }` ให้ตรวจและบันทึก (409 `lab_changed` ถ้า lab เพิ่งถูกแก้) |
| `POST /api/student/lessons/:id/lab/reset` | ผู้เรียน | เริ่มใหม่ |

บทเรียน lab เก็บในตาราง `lessons` เป็น type `embed` พร้อม `lab_id` (D1 แก้ CHECK ของ type ไม่ได้) และ API รายงานเป็น type `lab` เหมือนกับที่ทำกับ Self-learning

## Deploy

ต้องรัน migration `0041_virtual_labs.sql` ก่อน deploy backend ที่มีโค้ดนี้ (staging ทำใน CI ส่วน production รันเองตาม `docs/CLOUDFLARE-DEPLOY.md`)

## ทดสอบ

```sh
pnpm run test:lab-engine   # engine ล้วน ไม่ต้องใช้ Worker
pnpm run test:labs         # API: สิทธิ์ ตรวจผลด้วยการเล่นซ้ำ และใบประกาศรอจน lab ผ่าน
```
