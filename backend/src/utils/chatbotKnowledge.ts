/**
 * Knowledge base for the public website chatbot: questions visitors ask about NetPrime
 * (formats, payment, location, certificates, policies). Based on the FAQ of the previous site
 * (netprimetraining.com/faq) and updated for how this system works (bank transfer + slip,
 * no card payments, certificates issued in the LMS).
 *
 * Kept in code, not in site_settings, so every environment gets the same answers on deploy.
 * Contact details are not written here: `{phone}`, `{email}`, `{address}`, `{line}`, `{hours}`
 * and `{company}` are filled from the site settings when the answer is sent.
 */

export interface KnowledgeEntry {
  id: string;
  /** The question as a visitor would ask it. */
  q: string;
  /** Other ways of asking; used for matching only. */
  aliases: string[];
  /** Distinctive words: any one of them in the question is a strong signal for this entry. */
  keywords: string[];
  a: string;
  /** Internal page with more detail. */
  url: string;
  /** Show the "contact me" button with the answer. */
  handoff?: boolean;
}

export const CHATBOT_KNOWLEDGE: KnowledgeEntry[] = [
  {
    id: "formats", q: "รูปแบบการเรียนมีอะไรบ้าง ต่างกันอย่างไร",
    aliases: ["มีเรียนแบบไหนบ้าง", "เรียนออนไลน์หรือในห้องเรียน", "มีกี่แบบ", "รูปแบบคอร์สอบรม", "เรียนแบบไหนดี"],
    keywords: ["รูปแบบ", "กี่แบบ", "แบบไหนบ้าง"],
    a: "NetPrime มีการเรียน 5 รูปแบบ:\n- **Classroom** สอนสดในห้องเรียนที่สถาบัน ถามอาจารย์และทำ LAB ได้ใกล้ชิด\n- **Virtual Class** สอนสดผ่าน Zoom หรือ Webex เรียนจากบ้านได้ เปิดไมค์ถามอาจารย์ได้\n- **คอร์สออนไลน์ (Video on Demand)** เรียนผ่านวิดีโอด้วยตัวเอง ดูซ้ำได้ไม่จำกัดตามระยะเวลาของคอร์ส\n- **Self-Learning** บทเรียนแบบโต้ตอบให้ลองทำเองบนเว็บ\n- **In-House / Private Class** จัดอบรมให้องค์กร ปรับเนื้อหาได้ อบรมที่บริษัทของท่านหรือที่สถาบัน\nดูรอบอบรมสดได้ที่ [ตารางอบรม](/schedule) และคอร์สออนไลน์ที่ [คอร์สทั้งหมด](/courses)",
    url: "/schedule"
  },
  {
    id: "classroom", q: "เรียนแบบ Classroom เป็นอย่างไร",
    aliases: ["อบรมในห้องเรียน", "เรียนในห้องเรียนเป็นยังไง", "onsite", "on-site", "เรียนสด"],
    keywords: ["classroom", "ห้องเรียน", "onsite"],
    a: "Classroom คือการอบรมสอนสดในห้องเรียนที่สถาบัน ถามอาจารย์เรื่องเนื้อหาและ LAB ได้ใกล้ชิด มีเอกสารและ LAB (ถ้ามี) และกลับมาทวนในรอบถัดไปได้ฟรีตามเงื่อนไขของบริษัทฯ ดูรอบที่เปิดได้ที่ [ตารางอบรม](/schedule)",
    url: "/schedule"
  },
  {
    id: "virtual", q: "Virtual Class เรียนอย่างไร",
    aliases: ["เรียนผ่าน zoom", "เรียนผ่าน webex", "เรียนออนไลน์สด", "live online", "อบรมออนไลน์แบบสด"],
    keywords: ["virtual", "zoom", "webex"],
    a: "Virtual Class คือการอบรมสอนสดผ่านโปรแกรมประชุมออนไลน์ เช่น Zoom หรือ Webex เรียนจากบ้านหรือที่ไหนก็ได้ เปิดไมค์ถามอาจารย์เรื่องเนื้อหาและ LAB ได้ มีหนังสือเรียนและ LAB (ถ้ามี) และทวนได้ฟรีหากเปิด Virtual Class รอบถัดไป ตามเงื่อนไขของบริษัทฯ ดูรอบได้ที่ [ตารางอบรม](/schedule)",
    url: "/schedule"
  },
  {
    id: "on-demand", q: "คอร์สออนไลน์แบบวิดีโอเรียนอย่างไร",
    aliases: ["video on demand", "เรียนผ่านวิดีโอ", "เรียนเองได้ไหม", "ดูวิดีโอย้อนหลัง", "เรียนตอนไหนก็ได้ไหม"],
    keywords: ["on demand", "on-demand", "วิดีโอ", "video"],
    a: "คอร์สออนไลน์ (Video on Demand) เรียนผ่านวิดีโอของอาจารย์ได้ทุกที่ทุกเวลา ดูซ้ำได้ไม่จำกัดตลอดระยะเวลาเข้าเรียนของคอร์ส บางคอร์สมีแบบทดสอบ ข้อสอบปลายภาค และใบประกาศนียบัตร ดูคอร์สทั้งหมดได้ที่ [คอร์สออนไลน์](/courses)",
    url: "/courses"
  },
  {
    id: "self-learning", q: "Self-Learning คืออะไร",
    aliases: ["บทเรียนโต้ตอบ", "บทเรียนแบบ interactive", "ฝึกทำเองบนเว็บ", "lab บนเว็บ"],
    keywords: ["self-learning", "self learning", "interactive"],
    a: "Self-Learning คือบทเรียนแบบโต้ตอบบนเว็บ ให้ลองคลิก ทดลอง และทำแบบฝึกด้วยตัวเอง เช่น จำลองการทำงานของเครือข่าย เหมาะสำหรับทบทวนพื้นฐาน ดูบทเรียนได้ที่ [Self-Learning](/self-learning)",
    url: "/self-learning"
  },
  {
    id: "in-house", q: "จัดอบรมให้บริษัทหรือองค์กร (In-House) ได้ไหม",
    aliases: ["อบรมพนักงาน", "private class", "อบรมเฉพาะองค์กร", "จัดอบรมที่บริษัท", "custom เนื้อหา", "อินเฮาส์", "จัดอบรมให้พนักงานในบริษัท"],
    keywords: ["in-house", "inhouse", "อินเฮาส์", "private", "อบรมพนักงาน", "พนักงาน", "เฉพาะองค์กร"],
    a: "ได้ NetPrime จัด In-House / Private Class ทั้งแบบ Classroom และ Virtual ปรับเนื้อหาตามความต้องการ อบรมที่บริษัทของท่านหรือที่สถาบันก็ได้ ส่งรายละเอียดมาที่ {email} หรือกด \"ให้เจ้าหน้าที่ติดต่อกลับ\" แจ้งหัวข้อที่สนใจ จำนวนผู้อบรม และช่วงเวลาที่ต้องการ",
    url: "/#contact", handoff: true
  },
  {
    id: "hours", q: "อบรมกี่โมงถึงกี่โมง",
    aliases: ["เวลาอบรม", "เริ่มเรียนกี่โมง", "เลิกกี่โมง", "อบรมวันไหน", "มีรอบวันธรรมดาไหม", "เรียนเสาร์อาทิตย์ไหม", "เรียนวันไหนบ้าง"],
    keywords: ["กี่โมง", "เวลาอบรม", "วันไหน", "วันธรรมดา", "เสาร์", "อาทิตย์"],
    a: "โดยปกติอบรมประมาณ 9:00–17:30 น. ขึ้นอยู่กับเนื้อหาและจำนวนผู้อบรม จัดอบรมวันเสาร์และอาทิตย์ ยังไม่มีรอบวันธรรมดา วันและเวลาของแต่ละรอบดูได้ที่ [ตารางอบรม](/schedule)",
    url: "/schedule"
  },
  {
    id: "payment", q: "ชำระเงินได้ช่องทางไหนบ้าง",
    aliases: ["จ่ายเงินยังไง", "โอนเงินได้ไหม", "พร้อมเพย์", "จ่ายบัตรเครดิตได้ไหม", "ชำระค่าอบรมอย่างไร", "ซื้อคอร์สยังไง", "จ่ายด้วยบัตร"],
    keywords: ["ชำระ", "จ่ายเงิน", "โอนเงิน", "พร้อมเพย์", "บัตรเครดิต", "paypal", "ช่องทาง"],
    a: "- **คอร์สออนไลน์:** ชำระด้วยการโอนเงินหรือพร้อมเพย์ แล้วแนบสลิปในระบบ เจ้าหน้าที่ตรวจสอบแล้วจะเปิดสิทธิ์เรียนให้ ใส่โค้ดส่วนลดได้ในขั้นตอนชำระเงิน\n- **รอบอบรมสด (Classroom / Virtual):** ลงทะเบียนจาก [ตารางอบรม](/schedule) เจ้าหน้าที่จะติดต่อกลับเพื่อยืนยันที่นั่งและแจ้งวิธีชำระเงิน\n- **ในนามบริษัท:** ขอใบเสนอราคาและเปิด PO ได้\nตอนนี้ยังไม่รับชำระด้วยบัตรเครดิต",
    url: "/courses"
  },
  {
    id: "access-after-payment", q: "โอนเงินแล้วเข้าเรียนได้เมื่อไร",
    aliases: ["แนบสลิปแล้วทำไมยังเข้าเรียนไม่ได้", "ซื้อคอร์สแล้วเรียนที่ไหน", "เปิดสิทธิ์เรียนเมื่อไร", "ซื้อแล้วเข้าเรียนยังไง", "โอนเงินแล้วยังเข้าเรียนไม่ได้"],
    keywords: ["สลิป", "เปิดสิทธิ์", "ซื้อแล้ว", "เข้าเรียนไม่ได้"],
    a: "หลังแนบสลิป เจ้าหน้าที่จะตรวจสอบการชำระเงินแล้วเปิดสิทธิ์เรียนให้ จากนั้นเข้าสู่ระบบแล้วไปที่ \"ห้องเรียนของฉัน\" เพื่อเริ่มเรียน หากรอนานผิดปกติ กด \"ให้เจ้าหน้าที่ติดต่อกลับ\" หรือติดต่อ {email}",
    url: "/courses", handoff: true
  },
  {
    id: "access-duration", q: "ซื้อคอร์สออนไลน์แล้วเรียนได้นานแค่ไหน",
    aliases: ["ดูซ้ำได้กี่ครั้ง", "หมดอายุไหม", "เรียนได้ตลอดชีพไหม", "ระยะเวลาเข้าเรียน"],
    keywords: ["ตลอดชีพ", "หมดอายุ", "นานแค่ไหน", "กี่ครั้ง"],
    a: "ระยะเวลาเข้าเรียนระบุไว้ในหน้าของแต่ละคอร์ส บางคอร์สเรียนได้ตลอดชีพ บางคอร์สกำหนดเป็นจำนวนวัน ในระหว่างนั้นดูวิดีโอซ้ำได้ไม่จำกัดครั้ง ดูรายละเอียดได้ที่ [คอร์สออนไลน์](/courses)",
    url: "/courses"
  },
  {
    id: "register-account", q: "สมัครสมาชิกอย่างไร",
    aliases: ["สร้างบัญชี", "ลงทะเบียนเข้าใช้งาน", "สมัครเรียนยังไง", "เริ่มต้นใช้งาน", "สมัครยังไง"],
    keywords: ["สมัครสมาชิก", "สร้างบัญชี", "สมัครเรียน"],
    a: "กดปุ่ม \"เข้าสู่ระบบ\" ด้านบนของเว็บ แล้วเลือกสมัครสมาชิก กรอกชื่อ อีเมล และรหัสผ่าน สมัครฟรี จากนั้นเลือกคอร์สออนไลน์ที่ [คอร์สทั้งหมด](/courses) หรือลงทะเบียนรอบอบรมสดที่ [ตารางอบรม](/schedule)",
    url: "/courses"
  },
  {
    id: "forgot-password", q: "ลืมรหัสผ่านทำอย่างไร",
    aliases: ["เข้าสู่ระบบไม่ได้", "รีเซ็ตรหัสผ่าน", "จำรหัสไม่ได้", "login ไม่ได้"],
    keywords: ["ลืมรหัส", "รีเซ็ต", "reset", "รหัสผ่าน"],
    a: "ที่หน้าเข้าสู่ระบบ กด \"ลืมรหัสผ่าน\" แล้วกรอกอีเมลที่ใช้สมัคร ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมล หากไม่ได้รับอีเมล ตรวจในโฟลเดอร์ Spam หรือติดต่อ {email}",
    url: "/"
  },
  {
    id: "location", q: "NetPrime อยู่ที่ไหน เดินทางอย่างไร",
    aliases: ["ที่อยู่สถาบัน", "สถานที่อบรม", "ไปยังไง", "ไปเรียนที่สถาบันยังไง", "ไปสถาบันยังไง", "แผนที่", "ใกล้ bts อะไร", "อยู่แถวไหน"],
    keywords: ["ที่ไหน", "เดินทาง", "ไปยังไง", "ไปเรียนที่", "สถานที่", "แผนที่", "bts", "tipco", "ทิปโก้", "อารีย์", "ที่อยู่"],
    a: "สถานที่อบรม: {address}\nอยู่ด้านหลังตึก Tipco (เข้าทางเดียวกับตึก Tipco)\n- **รถยนต์:** เข้าทางตึก Tipco ขับตรงไปสุดซอยแล้วเลี้ยวซ้าย มีลานจอดรถฟรี\n- **BTS:** ลงสถานีอารีย์ ทางออก 3 แล้วต่อวินมอเตอร์ไซค์มาตึก Tipco หรือเรียกรถไฟฟ้า MuvMi ไปลงหน้าตึก Tipco\nแผนที่: https://goo.gl/maps/jXKF4PKREGHcpJrU8",
    url: "/#contact"
  },
  {
    id: "parking", q: "มีที่จอดรถไหม",
    aliases: ["จอดรถได้ไหม", "ขับรถไปได้ไหม", "ค่าจอดรถ"],
    keywords: ["จอดรถ", "ที่จอด", "ขับรถ"],
    a: "มีลานจอดรถฟรี เข้าทางเดียวกับตึก Tipco ขับตรงไปสุดซอยแล้วเลี้ยวซ้าย",
    url: "/#contact"
  },
  {
    id: "contact", q: "ติดต่อเจ้าหน้าที่ได้ทางไหน",
    aliases: ["เบอร์โทร", "อีเมลติดต่อ", "line", "ไลน์", "ช่องทางติดต่อ", "ขอเบอร์", "โทรหาได้ไหม"],
    keywords: ["เบอร์", "โทร", "อีเมล", "line", "ไลน์", "ติดต่อ"],
    a: "ติดต่อ {company}\n- โทร: {phone}\n- อีเมล: {email}\n- LINE: {line}\n- เวลาทำการ: {hours}\nหรือกด \"ให้เจ้าหน้าที่ติดต่อกลับ\" แล้วฝากชื่อและอีเมลไว้ได้เลย",
    url: "/#contact", handoff: true
  },
  {
    id: "materials", q: "มีเอกสารประกอบการเรียนแจกไหม",
    aliases: ["มีหนังสือเรียนไหม", "ได้สไลด์ไหม", "ขอไฟล์เอกสาร", "มีชีทไหม"],
    keywords: ["เอกสาร", "หนังสือ", "สไลด์", "ชีท", "softfile"],
    a: "เอกสารแจกเป็น Softfile ดูผ่านเว็บ เนื่องจากเอกสารเป็นลิขสิทธิ์ของอาจารย์แต่ละท่านที่จัดทำขึ้นเอง การแจกไฟล์จึงขึ้นอยู่กับการพิจารณาของอาจารย์แต่ละท่าน",
    url: "/courses"
  },
  {
    id: "refund", q: "ขอเงินคืนได้ไหม",
    aliases: ["ยกเลิกแล้วได้เงินคืนไหม", "คืนเงิน", "refund", "เลื่อนคลาส"],
    keywords: ["คืนเงิน", "เงินคืน", "refund", "ยกเลิก"],
    a: "- หากแจ้ง Confirm Class แล้ว ไม่สามารถขอเงินคืนได้ทุกกรณี\n- หากบริษัทฯ เลื่อนหรือยกเลิก Class ผู้อบรมขอเงินคืนได้ตามจำนวนที่ชำระ หรือเลือกอบรมรอบถัดไปแทนได้",
    url: "/schedule", handoff: true
  },
  {
    id: "retake", q: "ทวนฟรีได้ไหม",
    aliases: ["เรียนซ้ำได้ไหม", "กลับมาเรียนอีกรอบได้ไหม", "ทบทวนรอบหน้า", "repeat class"],
    keywords: ["ทวน", "เรียนซ้ำ", "อีกรอบ"],
    a: "ผู้ที่เคยอบรม Classroom กลับมาทวนได้ฟรีในรอบที่เปิดสอนถัดไป และ Virtual Class ทวนได้ฟรีหากเปิด Virtual Class รอบถัดไป ทั้งนี้เป็นไปตามเงื่อนไขของบริษัทฯ แจ้งความประสงค์กับเจ้าหน้าที่ก่อนเข้าทวนทุกครั้ง",
    url: "/schedule", handoff: true
  },
  {
    id: "certificate", q: "มีใบประกาศนียบัตรหลังอบรมไหม",
    aliases: ["ได้ cert ไหม", "ได้ใบเซอร์ไหม", "ใบรับรองการอบรม", "ได้ใบประกาศเมื่อไร", "certificate"],
    keywords: ["ใบประกาศ", "cert", "เซอร์", "certificate", "ใบรับรอง"],
    a: "มี\n- **คอร์สออนไลน์:** เมื่อเรียนครบทุกบท และสอบผ่านข้อสอบปลายภาคในคอร์สที่กำหนดให้สอบ กดรับใบประกาศนียบัตรในหน้าเรียนได้เอง\n- **อบรมสด:** ผู้อบรมได้บัญชีและคอร์สออนไลน์ประกอบการอบรม และได้ใบประกาศเมื่อเรียนจบเช่นกัน\nตรวจชื่อในโปรไฟล์ให้ถูกต้องก่อนกดรับทุกครั้ง ทุกใบมีรหัสให้ผู้อื่น [ตรวจสอบ](/#verify) ได้",
    url: "/#verify"
  },
  {
    id: "verify-certificate", q: "ตรวจสอบใบประกาศนียบัตรได้อย่างไร",
    aliases: ["เช็คใบ cert", "ใบประกาศจริงไหม", "verify certificate", "ตรวจสอบรหัสใบประกาศ"],
    keywords: ["ตรวจสอบใบ", "verify", "รหัสใบประกาศ"],
    a: "ใบประกาศนียบัตรทุกใบมีรหัส (เช่น NP-XXXX) นำรหัสไปกรอกที่ [ตรวจสอบใบประกาศ](/#verify) เพื่อดูว่าออกให้ใคร คอร์สอะไร และยังใช้ได้อยู่หรือไม่",
    url: "/#verify"
  },
  {
    id: "exam", q: "มีราคาอบรมรวมสอบ Certificate ไหม",
    aliases: ["สอบ cert ที่นี่ได้ไหม", "เป็นศูนย์สอบไหม", "ค่าสอบ ccna", "สอบ pearson vue", "voucher สอบ"],
    keywords: ["ศูนย์สอบ", "ค่าสอบ", "รวมสอบ", "pearson", "voucher"],
    a: "NetPrime เป็นศูนย์อบรมอย่างเดียว ยังไม่ได้เป็นศูนย์สอบ Certificate หากสนใจสอบ ติดต่อศูนย์สอบที่เดินทางสะดวกได้เลย คอร์สของเราช่วยเตรียมความพร้อมก่อนสอบได้",
    url: "/schedule"
  },
  {
    id: "discount", q: "มีส่วนลดไหม",
    aliases: ["มีโปรโมชั่นไหม", "โค้ดส่วนลด", "ศิษย์เก่าลดไหม", "คูปอง", "ลดราคา"],
    keywords: ["ส่วนลด", "โปรโมชั่น", "โปร", "โค้ด", "คูปอง", "ลดราคา", "ศิษย์เก่า"],
    a: "- **ศิษย์เก่า:** มีโค้ดส่วนลดแจกทุกปี ทำตามกติกาง่าย ๆ ก็รับโค้ดได้ สอบถามทาง LINE\n- **ลูกค้าใหม่:** ติดตามเพจหรือ LINE เพื่อร่วมกิจกรรมและรับโปรโมชั่น\nโค้ดส่วนลดใส่ได้ในขั้นตอนชำระเงินของคอร์สออนไลน์ โปรโมชั่นที่กำลังจัดอยู่จะแสดงบนหน้าแรกของเว็บ",
    url: "/"
  },
  {
    id: "company-purchase", q: "ลงทะเบียนในนามบริษัทต้องทำอย่างไร",
    aliases: ["ขอใบเสนอราคา", "เปิด po", "บริษัทจ่ายให้", "quotation", "ส่งพนักงานมาอบรม", "นามบริษัท"],
    keywords: ["นามบริษัท", "ใบเสนอราคา", "quotation", "po"],
    a: "ส่งอีเมลมาที่ {email} พร้อมรายละเอียด:\n1. คอร์สที่สนใจ\n2. จำนวนผู้อบรม\n3. ชื่อและที่อยู่บริษัทสำหรับออกใบเสนอราคา\n4. เบอร์โทรที่ติดต่อได้\nเมื่อยืนยันแล้วเปิด PO กลับมาที่อีเมลเดิมได้เลย จากนั้นให้ผู้อบรมทุกท่านสมัครสมาชิกในเว็บ เพื่อเข้าดูเนื้อหาประกอบและรับใบประกาศนียบัตรในระบบ",
    url: "/#contact", handoff: true
  },
  {
    id: "tax-invoice", q: "ขอใบกำกับภาษีได้ไหม",
    aliases: ["ออกใบกำกับภาษีได้ไหม", "ขอใบเสร็จในนามบริษัท", "ใบเสร็จ", "ขอใบเสร็จ", "tax invoice", "ออกบิลในนามบริษัท"],
    keywords: ["ใบกำกับ", "ภาษี", "ใบเสร็จ", "invoice"],
    a: "ได้ ตอนลงทะเบียนให้ติ๊ก \"ต้องการใบกำกับภาษี\" แล้วกรอกเลขประจำตัวผู้เสียภาษีและที่อยู่สำหรับออกใบกำกับ หากต้องการแก้ไขข้อมูลภายหลัง ติดต่อ {email}",
    url: "/schedule"
  },
  {
    id: "waitlist", q: "ที่นั่งเต็มแล้วทำอย่างไร",
    aliases: ["รอบเต็ม", "ลงชื่อรอ", "waitlist", "ปิดรับสมัครแล้ว"],
    keywords: ["เต็ม", "รอคิว", "waitlist"],
    a: "ลงชื่อรอคิวได้จากปุ่มเดิมในหน้า [ตารางอบรม](/schedule) เจ้าหน้าที่จะติดต่อเมื่อมีที่ว่าง หรือเลือกรอบถัดไปของคอร์สเดียวกันได้",
    url: "/schedule"
  },
  {
    id: "where-to-start", q: "ไม่มีพื้นฐาน Network ควรเริ่มเรียนคอร์สไหน",
    aliases: ["เริ่มต้นเรียนอะไรดี", "มือใหม่เรียนอะไรก่อน", "แนะนำคอร์สพื้นฐาน", "ต้องมีพื้นฐานไหม", "ปูพื้นฐาน network"],
    keywords: ["พื้นฐาน", "มือใหม่", "เริ่มต้น", "เริ่มเรียน"],
    a: "ถ้ายังไม่มีพื้นฐาน แนะนำเริ่มจาก **Basic Network (Modern Network Foundations for IT Professionals)** ปูพื้นตั้งแต่ IP, Subnet, DNS, DHCP ไปจนถึง Cloud และ Security จากนั้นต่อ **Cisco CCNA** แล้วค่อยขยับไป CCNP หรือคอร์สเฉพาะทาง เช่น Firewall และ Cisco ISE ดูรอบอบรมได้ที่ [ตารางอบรม](/schedule) และคอร์สออนไลน์ที่ [คอร์สทั้งหมด](/courses)",
    url: "/schedule"
  },
  {
    id: "mobile", q: "เรียนบนมือถือได้ไหม",
    aliases: ["ใช้มือถือเรียนได้ไหม", "มีแอปไหม", "เรียนบน ipad", "เรียนบนแท็บเล็ต", "app"],
    keywords: ["มือถือ", "แอป", "ipad", "แท็บเล็ต", "app"],
    a: "เรียนบนมือถือและแท็บเล็ตได้ผ่านเว็บเบราว์เซอร์ และเพิ่มเว็บไว้ที่หน้าจอหลัก (Add to Home Screen) เพื่อเปิดใช้เหมือนแอปได้ ยังไม่มีแอปบน App Store หรือ Play Store",
    url: "/courses"
  },
  {
    id: "instructors", q: "ผู้สอนเป็นใคร มีประสบการณ์แค่ไหน",
    aliases: ["อาจารย์ผู้สอน", "ใครสอน", "ใครเป็นคนสอน", "เกี่ยวกับ netprime", "netprime คือใคร", "ทีมผู้สอน"],
    keywords: ["อาจารย์", "ผู้สอน", "ใครสอน", "ccie", "เกี่ยวกับ"],
    a: "NetPrime Training อบรมด้าน IT ทั้ง Network Infrastructure, Security, Wireless, Collaboration, System, Cloud และ Programming ทีมผู้สอนมีประสบการณ์สอนและทำงานติดตั้งระบบเครือข่าย Cisco มากกว่า 10 ปี ดูแลลูกค้าทั้งเอกชน รัฐวิสาหกิจ และหน่วยงานราชการ และมี Certificate ระดับ Expert ของ Cisco (CCIE) อ่านเพิ่มได้ที่ [เกี่ยวกับเรา](/about)",
    url: "/about"
  }
];

/** Placeholders an answer may use; filled from the public site settings. */
export interface ContactValues { company: string | null; phone: string | null; email: string | null; address: string | null; line: string | null; hours: string | null }

/** Fills {placeholders}; a list line whose value is missing (LINE, hours) is dropped. */
export function fillAnswer(answer: string, v: ContactValues): string {
  const values: Record<string, string | null> = { company: v.company, phone: v.phone, email: v.email, address: v.address, line: v.line, hours: v.hours };
  return answer.split("\n")
    .filter(line => !/\{(\w+)\}/.test(line) || [...line.matchAll(/\{(\w+)\}/g)].every(m => values[m[1]]))
    .map(line => line.replace(/\{(\w+)\}/g, (m, key) => values[key] ?? m))
    .join("\n");
}

// ---------- Matching ----------

const PARTICLES = /เป็นยังไง|ยังไง|อย่างไร|ครับ|ค่ะ|คะ|จ้า|จ้ะ|นะ|หรือไม่|หรือเปล่า|ไหม|มั้ย|มั๊ย|หรอ|เหรอ|ป่าว|ปะ|บ้าง|หน่อย|อยากทราบ|สอบถาม|ขอถาม|รบกวน|ช่วย|อะ|อ่ะ/g;

/** Lower-case, drop polite particles, spaces and punctuation (Thai has no word spacing anyway). */
export function normalizeQuestion(text: string): string {
  return text.toLowerCase().replace(PARTICLES, "").replace(/[\s?!.,:;"'“”()\[\]{}\/\\_-]+/g, "");
}

function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) out.add(text.slice(i, i + 2));
  return out;
}

/** Dice coefficient of character bigrams: tolerant of Thai word order and spelling variants. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return (2 * shared) / (a.size + b.size);
}

export interface KnowledgeMatch { entry: KnowledgeEntry; score: number }

/** Entries are scored by the best phrasing similarity plus a bonus when a keyword appears. */
export function matchKnowledge(message: string, entries: KnowledgeEntry[] = CHATBOT_KNOWLEDGE): KnowledgeMatch[] {
  const lower = message.toLowerCase();
  const query = bigrams(normalizeQuestion(message));
  return entries.map(entry => {
    let best = 0;
    for (const phrasing of [entry.q, ...entry.aliases]) best = Math.max(best, similarity(query, bigrams(normalizeQuestion(phrasing))));
    const keywordHit = entry.keywords.some(k => lower.includes(k.toLowerCase()));
    return { entry, score: best + (keywordHit ? 0.3 : 0) };
  }).sort((x, y) => y.score - x.score);
}

/** At or above: answer with the entry itself. Between the two: on-topic, used as context. */
export const DIRECT_ANSWER_SCORE = 0.6;
export const RELATED_SCORE = 0.5;
