# @netprime/lab-engine

ตัวจำลองอุปกรณ์เครือข่ายของ Virtual Lab ใช้ร่วมกันสองที่:

- **หน้าเว็บ** (`frontend-admin`) รัน lab สด ๆ ตอนผู้เรียนพิมพ์ (`createSession`)
- **Worker** (`backend`) ตรวจผลโดยเล่นปุ่มที่ผู้เรียนกดทั้งหมดซ้ำจากสถานะตั้งต้นของ lab (`grade`) ไม่เชื่อสถานะหรือผลที่ส่งมาจากเบราว์เซอร์

ทุกโค้ดนอก package นี้เรียกผ่าน `src/index.ts` เท่านั้น

## ที่มาของ `src/vendor/engine.js`

ตั้งต้นจากโค้ดที่แกะจากเว็บที่ build แล้วของน้องในทีม (Alpha v0.1.1, LAB-001 v0.1.0, รายละเอียดอยู่หัวไฟล์) ตอนนี้ NetPrime ดูแลไฟล์นี้เองและไม่รอ source เดิมแล้ว ชื่อตัวแปรสั้น ๆ มาจาก build เดิม ส่วนที่ NetPrime เพิ่มใช้ชื่อที่อ่านได้และมีคอมเมนต์ `NetPrime:` กำกับ

กฎเวลาแก้:
- ต้องเป็นโค้ดล้วน ห้ามใช้ DOM, timer, storage, เครือข่าย หรือ `Math.random` เพราะ Worker ตรวจผลด้วยการเล่นปุ่มซ้ำ ต้องได้ผลเหมือนในเบราว์เซอร์ทุกครั้ง
- ทุกครั้งที่พฤติกรรมเปลี่ยน ให้เปลี่ยน `ENGINE_VERSION` ใน `src/index.ts` ผลที่บันทึกไว้แล้วจะเก็บ `engine_version` ที่ใช้ตรวจไว้ด้วย
- คำสั่ง keyword ใหม่ทุกคำต้องมีข้อความ help ใน profile (`help`) ไม่อย่างนั้น `createEnv` จะ throw

## สิ่งที่ engine รุ่นนี้รองรับ

- อุปกรณ์ (`kind` ในนิยาม lab, ไม่ใส่ = router):
  - `router`: ตั้ง IP, เปิดปิดพอร์ต และ static route (`ip route`, `no ip route`, default route `0.0.0.0 0.0.0.0`)
  - `switch`: layer 2, VLAN เดียว ส่งต่อระหว่างทุกพอร์ตที่ up พอร์ตไม่มี IP สั่ง shutdown/no shutdown ได้
  - `pc` และ `server`: การ์ดเครือข่ายเดียว ใช้ command prompt `C:\>` มีคำสั่ง `ipconfig`, `ipconfig <IP> <mask> [<gateway>]` และ `ping`
- ping: เดินแพ็กเก็ตทีละ hop ตาม route ที่ prefix ยาวที่สุด หาเครื่องถัดไปใน segment เดียวกัน (ผ่าน switch ได้) มีแค่ router ที่ส่งต่อ และขากลับต้องมี route ด้วย จำกัด 16 hop และตรวจจับ routing loop ได้ ไม่มี ARP หรือเวลา
- คำสั่ง router/switch: enable/disable, configure terminal, hostname, interface, ip address, ip route, no, shutdown, do, exit/end, ping, show interfaces, show ip interface brief, show ip route, show running-config
- ชนิดเป้าหมาย: `interfaceIpv4Equals`, `interfacesOperUp`, `bidirectionalReachability`, `defaultGatewayEquals`
- ยังไม่มี: VLAN หลายวง, trunk, STP, DHCP, routing แบบ dynamic, ACL, NAT

## รูปแบบ transcript

`[[deviceId, ปุ่มที่กด], ...]` เรียงตามลำดับที่เกิดจริงข้ามทุกอุปกรณ์ (ทุกเครื่องใช้สถานะ lab ร่วมกัน) chunk ที่ติดกันของอุปกรณ์เดียวกันจะรวมเป็นอันเดียว จำกัดไม่เกิน 128K ตัวอักษร การเปลี่ยนขนาด terminal ไม่ถูกบันทึก เพราะไม่ได้เปลี่ยนสถานะ lab

ทดสอบ: `pnpm run test:lab-engine`
