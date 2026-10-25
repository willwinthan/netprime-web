import { Context, MiddlewareHandler } from "hono";
import type { Env, UserPayload } from "../middleware/rbac";

/**
 * Feature permissions granted per role. A role decides which console and data scope a user has
 * (own courses, own organization); permissions decide which management features that role may use.
 * Admins hold every permission and cannot be edited, so nobody can lock the system out.
 *
 * An account may hold several roles (table user_roles); it gets the union of their permissions.
 * ROLES is ordered by priority: the first role an account holds is its primary role.
 */
export const ROLES = ["admin", "coordinator", "instructor", "partner", "student"] as const;
export type Role = typeof ROLES[number];

export const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  admin: { label: "ผู้ดูแลระบบ", description: "เข้าถึงทุกส่วนและแก้ไขสิทธิ์ของบทบาทอื่น" },
  coordinator: { label: "เจ้าหน้าที่ประสานงาน", description: "ดูแลเนื้อหาเว็บไซต์ รอบอบรม และผู้สมัคร" },
  instructor: { label: "ผู้สอน", description: "สร้างและสอนคอร์สของตัวเอง" },
  partner: { label: "พาร์ตเนอร์องค์กร", description: "ดูแลที่นั่งและผู้เรียนขององค์กรตัวเอง (บริษัทหรือมหาวิทยาลัย)" },
  student: { label: "ผู้เรียน", description: "เรียนคอร์ส ทำแบบทดสอบ และรับใบประกาศ" }
};

export const PERMISSIONS = [
  { key: "users.view", group: "ผู้ใช้และสิทธิ์", label: "ดูรายชื่อผู้ใช้" },
  { key: "users.manage", group: "ผู้ใช้และสิทธิ์", label: "เพิ่มและแก้ไขผู้ใช้ เปลี่ยนบทบาท ระงับบัญชี ตั้งรหัสผ่านใหม่" },
  { key: "roles.manage", group: "ผู้ใช้และสิทธิ์", label: "แก้ไขสิทธิ์ของแต่ละบทบาท", adminOnly: true },
  { key: "site.dashboard", group: "เว็บไซต์", label: "ดูภาพรวมงานเว็บไซต์" },
  { key: "site.sessions", group: "เว็บไซต์", label: "จัดการรอบอบรมและผู้สมัคร" },
  { key: "site.inquiries", group: "เว็บไซต์", label: "ดูและตอบข้อความติดต่อ" },
  { key: "site.promotions", group: "เว็บไซต์", label: "จัดการโปรโมชั่น" },
  { key: "site.settings", group: "เว็บไซต์", label: "ตั้งค่าเว็บไซต์และการแจ้งเตือน" },
  { key: "site.media", group: "เว็บไซต์", label: "อัปโหลดรูปภาพ" },
  { key: "site.audit", group: "เว็บไซต์", label: "ดูประวัติการแก้ไข" },
  { key: "articles.write", group: "บทความ", label: "เขียนและแก้ไขบทความของตัวเอง (ส่งตรวจก่อนเผยแพร่)" },
  { key: "articles.publish", group: "บทความ", label: "เผยแพร่บทความ อนุมัติหรือส่งกลับบทความที่ส่งตรวจ" },
  { key: "articles.manage", group: "บทความ", label: "แก้ไขและลบบทความของทุกคน" },
  { key: "articles.import_notion", group: "บทความ", label: "นำเข้าบทความจาก Notion" },
  { key: "payments.manage", group: "การเงินและคอร์ส", label: "ยืนยันการชำระเงิน ออกใบเสร็จ และยกเลิก/คืนเงินคำสั่งซื้อคอร์ส" },
  { key: "courses.approve", group: "การเงินและคอร์ส", label: "ตรวจ อนุมัติ และเผยแพร่คอร์สของผู้สอน" },
  { key: "certificates.manage", group: "การเงินและคอร์ส", label: "เพิกถอนและออกใบประกาศใหม่" },
  { key: "privacy.manage", group: "ผู้ใช้และสิทธิ์", label: "ดำเนินการคำขอข้อมูลส่วนบุคคล (PDPA)" },
  { key: "users.import", group: "ผู้ใช้และสิทธิ์", label: "นำเข้าผู้ใช้จากไฟล์ CSV และจัดการแท็ก/ฟิลด์โปรไฟล์" },
  { key: "reports.view", group: "รายงาน", label: "ดูแดชบอร์ด รายงาน และบันทึกกิจกรรมของผู้เรียน" },
  { key: "communication.manage", group: "การสื่อสาร", label: "ส่งประกาศ/อีเมลถึงกลุ่มผู้ใช้ และแก้แม่แบบอีเมล" },
  { key: "community.moderate", group: "การสื่อสาร", label: "ดูแลกระดานสนทนา (ปักหมุด ซ่อน ลบโพสต์)" },
  { key: "commerce.manage", group: "การเงินและคอร์ส", label: "จัดการชุดคอร์ส สมาชิกรายช่วง ผ่อนชำระ และใบเสนอราคา" },
  { key: "marketing.manage", group: "การตลาด", label: "จัดการ affiliate ฟอร์มเก็บ lead popup และ tracking" },
  { key: "website.design", group: "เว็บไซต์", label: "สร้างหน้าเว็บ แก้ธีม และแม่แบบใบประกาศ" },
  // Admin-only: SSO providers, API keys and webhooks can impersonate or export every account.
  { key: "integrations.manage", group: "ระบบ", label: "ตั้งค่าโรงเรียน webhook API key SSO และการเชื่อมต่อภายนอก", adminOnly: true }
] as const;

export type Permission = typeof PERMISSIONS[number]["key"];
export const PERMISSION_KEYS = PERMISSIONS.map(p => p.key) as Permission[];
const ADMIN_ONLY = new Set<string>(PERMISSIONS.filter(p => "adminOnly" in p && p.adminOnly).map(p => p.key));

/** Defaults written by the migration and schema seed; admins edit them in the console afterwards. */
export const DEFAULT_GRANTS: Record<Exclude<Role, "admin">, Permission[]> = {
  coordinator: ["site.dashboard", "site.sessions", "site.inquiries", "site.promotions", "site.settings", "site.media", "site.audit",
    "articles.write", "articles.publish", "articles.manage", "articles.import_notion", "payments.manage",
    "reports.view", "communication.manage", "community.moderate", "marketing.manage", "website.design"],
  instructor: ["articles.write", "articles.import_notion", "site.media", "community.moderate"],
  partner: [],
  student: []
};

export const isRole = (value: unknown): value is Role => typeof value === "string" && (ROLES as readonly string[]).includes(value);
export const isPermission = (value: unknown): value is Permission => typeof value === "string" && (PERMISSION_KEYS as string[]).includes(value);
export const grantable = (permission: Permission) => !ADMIN_ONLY.has(permission);

export async function permissionsForRole(db: D1Database, role: UserPayload["role"]): Promise<Permission[]> {
  return permissionsForRoles(db, [role]);
}

export async function permissionsForRoles(db: D1Database, roles: readonly Role[]): Promise<Permission[]> {
  if (roles.includes("admin")) return [...PERMISSION_KEYS];
  if (!roles.length) return [];
  const rows = await db.prepare(`SELECT DISTINCT permission FROM role_permissions WHERE role IN (${roles.map(() => "?").join(", ")})`)
    .bind(...roles).all<{ permission: string }>();
  const granted = new Set(rows.results.map(r => r.permission));
  return PERMISSION_KEYS.filter(p => granted.has(p));
}

// ---------- Multiple roles per account ----------

/** SQL expression listing an account's roles as "a,b"; `alias` is the users table alias. */
export const rolesColumn = (alias: string) => `(SELECT GROUP_CONCAT(role) FROM user_roles WHERE user_id = ${alias}.id)`;

/** Normalizes a role list to priority order; falls back to the stored primary role when the list is empty. */
export function sortRoles(list: Iterable<unknown>, fallback?: unknown): Role[] {
  const set = new Set([...list].filter(isRole));
  if (!set.size && isRole(fallback)) set.add(fallback);
  return ROLES.filter(r => set.has(r));
}

export const parseRoles = (csv: string | null | undefined, fallback?: unknown): Role[] =>
  sortRoles(csv ? csv.split(",") : [], fallback);

export const primaryRole = (roles: readonly Role[]): Role => roles[0] ?? "student";

/** Primary role → users.role/staff_role. Coordinators keep base role 'student' (see migration 0006). */
export function storedRole(role: Role): { role: string; staff_role: string | null } {
  return role === "coordinator" ? { role: "student", staff_role: "coordinator" } : { role, staff_role: null };
}

/** Permissions of the signed-in user, loaded once per request. */
export async function currentPermissions(c: Context<Env>): Promise<Set<Permission>> {
  const cached = c.get("permissions") as Set<Permission> | undefined;
  if (cached) return cached;
  const set = new Set(await permissionsForRoles(c.env.DB, c.get("user").roles));
  c.set("permissions", set);
  return set;
}

/** Use after rbac(): allows the request when the user holds any of the listed permissions. */
export function permit(...required: Permission[]): MiddlewareHandler<Env> {
  return async (c, next) => {
    const granted = await currentPermissions(c);
    if (!required.some(p => granted.has(p))) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
    await next();
  };
}
