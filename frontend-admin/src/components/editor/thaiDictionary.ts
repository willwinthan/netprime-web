import { en } from "@blocknote/core/locales";

// BlockNote ships no Thai locale; translate what authors see most and keep English for the rest.
type Dictionary = typeof en;

const menu: Record<string, [string, string?]> = {
  heading: ["หัวข้อ 1", "หัวข้อใหญ่ของส่วน"],
  heading_2: ["หัวข้อ 2", "หัวข้อย่อย"],
  heading_3: ["หัวข้อ 3", "หัวข้อย่อยระดับรอง"],
  toggle_heading: ["หัวข้อ 1 แบบพับได้"],
  toggle_heading_2: ["หัวข้อ 2 แบบพับได้"],
  toggle_heading_3: ["หัวข้อ 3 แบบพับได้"],
  quote: ["คำพูด / กล่องเน้น", "ข้อความอ้างอิงหรือหมายเหตุ"],
  toggle_list: ["รายการพับได้", "ซ่อนรายละเอียดไว้ให้กดเปิด"],
  numbered_list: ["รายการลำดับเลข", "1. 2. 3."],
  bullet_list: ["รายการจุด", "รายการแบบไม่มีลำดับ"],
  check_list: ["รายการเช็กลิสต์", "รายการพร้อมช่องติ๊ก"],
  paragraph: ["ข้อความ", "ย่อหน้าปกติ"],
  code_block: ["โค้ด", "บล็อกโค้ดพร้อมไฮไลต์"],
  table: ["ตาราง", "ตารางข้อมูล"],
  image: ["รูปภาพ", "อัปโหลดหรือวางลิงก์รูป"],
  emoji: ["อีโมจิ", "ค้นหาและแทรกอีโมจิ"],
  divider: ["เส้นคั่น", "เส้นแบ่งส่วน"]
};

const groups: Record<string, string> = {
  "Headings": "หัวข้อ", "Subheadings": "หัวข้อย่อย", "Basic blocks": "บล็อกพื้นฐาน",
  "Advanced": "ขั้นสูง", "Media": "สื่อ", "Others": "อื่น ๆ"
};

export function thaiDictionary(): Dictionary {
  const d: Dictionary = JSON.parse(JSON.stringify(en));
  const slash = d.slash_menu as Record<string, { title: string; subtext?: string; group?: string }>;
  for (const [key, item] of Object.entries(slash)) {
    if (menu[key]) {
      item.title = menu[key][0];
      if (menu[key][1]) item.subtext = menu[key][1];
    }
    if (item.group && groups[item.group]) item.group = groups[item.group];
  }
  Object.assign(d.placeholders, {
    default: "พิมพ์ข้อความ หรือกด / เพื่อเลือกบล็อก",
    heading: "หัวข้อ",
    bulletListItem: "รายการ",
    numberedListItem: "รายการ",
    checkListItem: "รายการ",
    toggleListItem: "หัวข้อที่พับได้"
  });
  Object.assign(d.file_blocks.add_button_text, { image: "เพิ่มรูปภาพ" });
  return d;
}
