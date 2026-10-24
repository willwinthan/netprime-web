import { Hono, Context } from "hono";
import { Env, rbac, UserPayload } from "../middleware/rbac";
import { hashPassword } from "../utils/crypto";
import { issueAccountToken } from "../utils/tokens";
import { appUrl, sendInvitationEmail } from "../utils/email";
import {
  ROLES, ROLE_INFO, PERMISSIONS, DEFAULT_GRANTS, Role, Permission,
  isRole, isPermission, grantable, permit, permissionsForRole, currentPermissions,
  parseRoles, primaryRole, rolesColumn, sortRoles, storedRole, permissionsForRoles
} from "../utils/permissions";

/**
 * Account management for admins and anyone granted users.view / users.manage,
 * plus the editable role → permission matrix (roles.manage, admin only).
 * Mounted at /api/admin.
 */
export const accountsRouter = new Hono<Env>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface AccountRow {
  id: string; email: string; name: string; primary_role: string; role_list: string | null; partner_id: string | null;
  company_name: string | null; partner_type: string | null; status: "active" | "suspended";
  created_at: string; last_login_at: string | null;
  email_verified_at: string | null; invite_expires_at: string | null;
}
type Account = Omit<AccountRow, "primary_role" | "role_list"> & { role: Role; roles: Role[] };

const ACCOUNT_SELECT = `SELECT u.id, u.email, u.name, COALESCE(u.staff_role, u.role) AS primary_role, ${rolesColumn("u")} AS role_list,
  u.partner_id, p.company_name, p.partner_type, u.status, u.created_at, u.last_login_at, u.email_verified_at,
  (SELECT MAX(t.expires_at) FROM account_tokens t WHERE t.user_id = u.id AND t.purpose = 'invite' AND t.used_at IS NULL) AS invite_expires_at
  FROM users u LEFT JOIN partners p ON p.id = u.partner_id`;

function toAccount({ primary_role, role_list, ...row }: AccountRow): Account {
  const roles = parseRoles(role_list, primary_role);
  return { ...row, role: primaryRole(roles), roles };
}

async function loadAccount(db: D1Database, id: string): Promise<Account | null> {
  const row = await db.prepare(`${ACCOUNT_SELECT} WHERE u.id = ?`).bind(id).first<AccountRow>();
  return row ? toAccount(row) : null;
}

/** Reads `roles` (array) or the older single `role`; undefined when neither was sent, null when invalid. */
function requestedRoles(body: Record<string, unknown>): Role[] | null | undefined {
  const raw = Array.isArray(body.roles) ? body.roles : body.role !== undefined ? [body.role] : undefined;
  if (raw === undefined) return undefined;
  if (!raw.length || !raw.every(isRole)) return null;
  return sortRoles(raw);
}

const sameRoles = (a: readonly Role[], b: readonly Role[]) => a.length === b.length && a.every(r => b.includes(r));

/** Partners must belong to an organization; organization accounts may only be partners and/or students. */
function organizationRule(roles: readonly Role[], partnerId: string | null): string | null {
  if (roles.includes("partner") && !partnerId) return "พาร์ตเนอร์องค์กรต้องเลือกองค์กร";
  const other = roles.find(r => r !== "partner" && r !== "student");
  if (partnerId && other) return `บทบาท${ROLE_INFO[other].label}ผูกกับองค์กรไม่ได้`;
  return null;
}

async function audit(c: Context<Env>, action: string, entity: string, entityId: string, detail?: unknown) {
  try {
    await c.env.DB.prepare("INSERT INTO admin_audit_log (id, user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("log_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), c.get("user").id, action, entity, entityId,
        detail === undefined ? null : JSON.stringify(detail).slice(0, 2000)).run();
  } catch (error) {
    console.error("Audit log write failed:", error);
  }
}

/**
 * Emails a single-use "set your password" link (7 days). Locally the link is also returned
 * as debug_url for the test harness; ALLOW_LOCAL_SEED_PASSWORDS is never set in staging/production.
 */
async function sendInvite(c: Context<Env>, account: { id: string; email: string; name: string }): Promise<{ debug_url?: string }> {
  const url = appUrl(c.env, "/reset-password?token=" + await issueAccountToken(c.env.DB, account.id, "invite") + "&invite=1");
  try {
    await sendInvitationEmail(account.email, account.name, c.get("user").name, url, c.env.RESEND_API_KEY);
  } catch (error) {
    console.error("Invitation email delivery failed", error);
  }
  return c.env.ALLOW_LOCAL_SEED_PASSWORDS === "true" ? { debug_url: url } : {};
}

async function activeAdmins(db: D1Database, excludingId?: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM users u WHERE u.status = 'active' AND u.id != ?
    AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'admin')`)
    .bind(excludingId ?? "").first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Non-admins may only give or manage roles whose combined permissions they already hold,
 * so users.manage cannot be used to gain (or take over accounts with) more access.
 */
async function withinActorPermissions(c: Context<Env>, roles: readonly Role[]): Promise<boolean> {
  if (c.get("user").roles.includes("admin")) return true;
  if (roles.includes("admin")) return false;
  const actorPermissions = await currentPermissions(c);
  return (await permissionsForRoles(c.env.DB, roles)).every(p => actorPermissions.has(p));
}

async function targetRoles(db: D1Database, id: string): Promise<Role[] | null> {
  const row = await db.prepare(`SELECT COALESCE(u.staff_role, u.role) AS primary_role, ${rolesColumn("u")} AS role_list FROM users u WHERE u.id = ?`)
    .bind(id).first<{ primary_role: string; role_list: string | null }>();
  return row ? parseRoles(row.role_list, row.primary_role) : null;
}

const BEYOND_ACTOR = "บัญชีของคุณจัดการผู้ใช้ที่มีสิทธิ์มากกว่าตัวเองไม่ได้";

/** Replaces the account's role set; users.role/staff_role already hold the primary role. */
function writeRoles(db: D1Database, id: string, roles: readonly Role[]) {
  return db.batch([
    db.prepare(`DELETE FROM user_roles WHERE user_id = ? AND role NOT IN (${roles.map(() => "?").join(", ")})`).bind(id, ...roles),
    ...roles.map(r => db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)").bind(id, r))
  ]);
}

async function recountSeats(db: D1Database, partnerId: string | null) {
  if (!partnerId) return;
  await db.prepare(`UPDATE partners SET allocated_seats =
    (SELECT COUNT(*) FROM users WHERE partner_id = ? AND role = 'student' AND staff_role IS NULL) WHERE id = ?`)
    .bind(partnerId, partnerId).run();
}

/**
 * Seats are only consumed by organization accounts whose primary role is student (a partner who also
 * studies does not take a seat). The capacity check runs inside the same statement as the write.
 */
const SEAT_AVAILABLE = `(SELECT COUNT(*) FROM users x WHERE x.partner_id = p.id AND x.role = 'student' AND x.staff_role IS NULL AND x.id != ?) < p.total_seats`;

accountsRouter.use("/accounts", rbac());
accountsRouter.use("/accounts/*", rbac());
accountsRouter.use("/roles", rbac());
accountsRouter.use("/roles/*", rbac());

/** Roles, permission catalog and organizations for the management screens. */
accountsRouter.get("/accounts/meta", permit("users.view", "roles.manage"), async (c) => {
  const partners = await c.env.DB.prepare("SELECT id, company_name, partner_type, total_seats, allocated_seats FROM partners ORDER BY company_name").all();
  return c.json({
    roles: ROLES.map(key => ({ key, ...ROLE_INFO[key] })),
    partners: partners.results,
    canManage: (await currentPermissions(c)).has("users.manage"),
    actorRole: c.get("user").role,
    actorRoles: c.get("user").roles
  });
});

accountsRouter.get("/accounts", permit("users.view"), async (c) => {
  const q = (c.req.query("q") || "").trim().slice(0, 100);
  const role = c.req.query("role");
  const status = c.req.query("status");
  const partnerId = c.req.query("partner_id");
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "25", 10) || 25, 1), 100);
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10) || 0, 0);
  const like = q ? `%${q.replace(/[\\%_]/g, ch => "\\" + ch)}%` : null;
  const where = `WHERE (? IS NULL OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')
    AND (? IS NULL OR EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = ?))
    AND (? IS NULL OR u.status = ?)
    AND (? IS NULL OR u.partner_id = ?)`;
  const filters = [like, like, like, isRole(role) ? role : null, isRole(role) ? role : null,
    status === "active" || status === "suspended" ? status : null, status === "active" || status === "suspended" ? status : null,
    partnerId || null, partnerId || null];
  const rows = await c.env.DB.prepare(`${ACCOUNT_SELECT} ${where} ORDER BY u.created_at DESC, u.email LIMIT ? OFFSET ?`)
    .bind(...filters, limit, offset).all<AccountRow>();
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users u ${where}`).bind(...filters).first<{ n: number }>();
  // An account with several roles is counted under each of them.
  const counts = await c.env.DB.prepare("SELECT role, COUNT(*) AS n FROM user_roles GROUP BY role").all<{ role: string; n: number }>();
  return c.json({
    users: rows.results.map(toAccount),
    total: total?.n ?? 0,
    roleCounts: Object.fromEntries(counts.results.map(r => [r.role, r.n]))
  });
});

accountsRouter.post("/accounts", permit("users.manage"), async (c) => {
  const actor = c.get("user");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  // invite: true emails a set-password link instead of the admin choosing a password.
  const invite = body.invite === true;
  const password = typeof body.password === "string" ? body.password : "";
  const roles = requestedRoles(body);
  const partnerId = typeof body.partner_id === "string" && body.partner_id ? body.partner_id : null;
  if (!EMAIL_RE.test(email) || email.length > 254) return c.json({ error: "อีเมลไม่ถูกต้อง" }, 400);
  if (!name || name.length > 120) return c.json({ error: "กรุณากรอกชื่อ (ไม่เกิน 120 ตัวอักษร)" }, 400);
  if (!invite && (password.length < 12 || password.length > 256)) return c.json({ error: "รหัสผ่านเริ่มต้นต้องยาว 12–256 ตัวอักษร" }, 400);
  if (!roles) return c.json({ error: "เลือกบทบาทอย่างน้อย 1 บทบาท" }, 400);
  if (roles.includes("admin") && !actor.roles.includes("admin")) return c.json({ error: "เฉพาะผู้ดูแลระบบเท่านั้นที่สร้างผู้ดูแลระบบได้" }, 403);
  if (!(await withinActorPermissions(c, roles))) return c.json({ error: BEYOND_ACTOR }, 403);
  const orgProblem = organizationRule(roles, partnerId);
  if (orgProblem) return c.json({ error: orgProblem }, 400);

  const db = c.env.DB;
  if (partnerId && !(await db.prepare("SELECT id FROM partners WHERE id = ?").bind(partnerId).first())) {
    return c.json({ error: "ไม่พบองค์กรที่เลือก" }, 400);
  }
  const id = "usr_" + crypto.randomUUID();
  const primary = primaryRole(roles);
  const stored = storedRole(primary);
  // Invited accounts get a random password nobody knows until they follow the link.
  const hash = await hashPassword(invite ? crypto.randomUUID() + crypto.randomUUID() : password);
  try {
    if (primary === "student" && partnerId) {
      // Organization students take a seat; the capacity check and insert are one statement.
      const result = await db.prepare(`INSERT INTO users (id, email, password_hash, name, role, staff_role, partner_id)
        SELECT ?, ?, ?, ?, 'student', NULL, p.id FROM partners p WHERE p.id = ? AND ${SEAT_AVAILABLE}`)
        .bind(id, email, hash, name, partnerId, id).run();
      if (!result.meta.changes) return c.json({ error: "องค์กรนี้ใช้ที่นั่งครบแล้ว เพิ่มที่นั่งก่อนหรือเลือกบทบาทอื่น" }, 409);
      await recountSeats(db, partnerId);
    } else {
      await db.prepare("INSERT INTO users (id, email, password_hash, name, role, staff_role, partner_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, email, hash, name, stored.role, stored.staff_role, partnerId).run();
    }
  } catch (error: any) {
    if (String(error?.message).includes("UNIQUE constraint failed")) return c.json({ error: "อีเมลนี้มีบัญชีอยู่แล้ว เพิ่มบทบาทให้บัญชีเดิมแทนการสร้างใหม่" }, 409);
    throw error;
  }
  await writeRoles(db, id, roles);
  await audit(c, "create", "user", id, { email, roles, partner_id: partnerId, invite });
  const debug = invite ? await sendInvite(c, { id, email, name }) : {};
  return c.json({ user: await loadAccount(db, id), ...(invite ? { message: `ส่งคำเชิญไปที่ ${email} แล้ว` } : {}), ...debug }, 201);
});

accountsRouter.patch("/accounts/:id", permit("users.manage"), async (c) => {
  const actor = c.get("user");
  const actorIsAdmin = actor.roles.includes("admin");
  const id = c.req.param("id");
  const db = c.env.DB;
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const target = await loadAccount(db, id);
  if (!target) return c.json({ error: "ไม่พบผู้ใช้" }, 404);

  const requested = requestedRoles(body);
  if (requested === null) return c.json({ error: "บทบาทไม่ถูกต้อง ต้องมีอย่างน้อย 1 บทบาท" }, 400);
  const nextRoles = requested ?? target.roles;
  const nextStatus = body.status === undefined ? target.status : body.status;
  if (nextStatus !== "active" && nextStatus !== "suspended") return c.json({ error: "สถานะไม่ถูกต้อง" }, 400);
  const nextName = body.name === undefined ? target.name : (typeof body.name === "string" ? body.name.trim() : "");
  if (!nextName || nextName.length > 120) return c.json({ error: "กรุณากรอกชื่อ (ไม่เกิน 120 ตัวอักษร)" }, 400);
  let nextPartner = body.partner_id === undefined ? target.partner_id : (typeof body.partner_id === "string" && body.partner_id ? body.partner_id : null);
  if (body.partner_id === undefined && nextRoles.some(r => r !== "partner" && r !== "student")) nextPartner = null;

  // Guard rails: no self-escalation or lockout, admins are managed by admins only, the last active admin stays.
  const rolesChanged = !sameRoles(nextRoles, target.roles);
  if (id === actor.id) {
    if (nextStatus !== "active") return c.json({ error: "ระงับบัญชีของตัวเองไม่ได้" }, 400);
    // Admins may add roles to themselves (e.g. also study); nobody else edits their own roles.
    if (rolesChanged && (!actorIsAdmin || !nextRoles.includes("admin"))) return c.json({ error: "แก้ไขบทบาทของตัวเองไม่ได้" }, 400);
  }
  if ((target.roles.includes("admin") || nextRoles.includes("admin")) && !actorIsAdmin) {
    return c.json({ error: "เฉพาะผู้ดูแลระบบเท่านั้นที่จัดการบัญชีผู้ดูแลระบบได้" }, 403);
  }
  if (id !== actor.id && (!(await withinActorPermissions(c, target.roles)) || !(await withinActorPermissions(c, nextRoles)))) {
    return c.json({ error: BEYOND_ACTOR }, 403);
  }
  if (target.roles.includes("admin") && (!nextRoles.includes("admin") || nextStatus !== "active") && (await activeAdmins(db, id)) === 0) {
    return c.json({ error: "ต้องมีผู้ดูแลระบบที่ใช้งานอยู่อย่างน้อย 1 คน" }, 400);
  }
  const orgProblem = organizationRule(nextRoles, nextPartner);
  if (orgProblem) return c.json({ error: orgProblem }, 400);
  if (nextPartner && nextPartner !== target.partner_id && !(await db.prepare("SELECT id FROM partners WHERE id = ?").bind(nextPartner).first())) {
    return c.json({ error: "ไม่พบองค์กรที่เลือก" }, 400);
  }

  const primary = primaryRole(nextRoles);
  const stored = storedRole(primary);
  const takesSeat = primary === "student" && !!nextPartner;
  const alreadyHolds = target.role === "student" && target.partner_id === nextPartner;
  if (takesSeat && !alreadyHolds) {
    const result = await db.prepare(`UPDATE users SET name = ?, role = 'student', staff_role = NULL, partner_id = ?, status = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM partners p WHERE p.id = ? AND ${SEAT_AVAILABLE})`)
      .bind(nextName, nextPartner, nextStatus, id, nextPartner, id).run();
    if (!result.meta.changes) return c.json({ error: "องค์กรนี้ใช้ที่นั่งครบแล้ว" }, 409);
  } else {
    await db.prepare("UPDATE users SET name = ?, role = ?, staff_role = ?, partner_id = ?, status = ? WHERE id = ?")
      .bind(nextName, stored.role, stored.staff_role, nextPartner, nextStatus, id).run();
  }
  if (rolesChanged) await writeRoles(db, id, nextRoles);
  await recountSeats(db, target.partner_id);
  if (nextPartner !== target.partner_id) await recountSeats(db, nextPartner);

  await audit(c, "update", "user", id, {
    ...(rolesChanged ? { roles: [target.roles, nextRoles] } : {}),
    ...(nextStatus !== target.status ? { status: nextStatus } : {}),
    ...(nextPartner !== target.partner_id ? { partner_id: nextPartner } : {}),
    ...(nextName !== target.name ? { name: nextName } : {})
  });
  return c.json({ user: await loadAccount(db, id) });
});

/** Sets a temporary password and signs the user out of every device. */
accountsRouter.post("/accounts/:id/password", permit("users.manage"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ password?: unknown }>().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  if (password.length < 12 || password.length > 256) return c.json({ error: "รหัสผ่านใหม่ต้องยาว 12–256 ตัวอักษร" }, 400);
  const roles = await targetRoles(c.env.DB, id);
  if (!roles) return c.json({ error: "ไม่พบผู้ใช้" }, 404);
  if (!c.get("user").roles.includes("admin") && roles.includes("admin")) return c.json({ error: "เฉพาะผู้ดูแลระบบเท่านั้นที่จัดการบัญชีผู้ดูแลระบบได้" }, 403);
  if (!(await withinActorPermissions(c, roles))) return c.json({ error: BEYOND_ACTOR }, 403);
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, sessions_revoked_at = ? WHERE id = ?")
    .bind(await hashPassword(password), new Date().toISOString(), id).run();
  await audit(c, "reset_password", "user", id);
  return c.json({ message: "ตั้งรหัสผ่านใหม่แล้ว ผู้ใช้ต้องเข้าสู่ระบบใหม่ทุกอุปกรณ์" });
});

/** Sends a new invitation link (older unused links stop working). */
accountsRouter.post("/accounts/:id/invite", permit("users.manage"), async (c) => {
  const target = await loadAccount(c.env.DB, c.req.param("id"));
  if (!target) return c.json({ error: "ไม่พบผู้ใช้" }, 404);
  if (target.roles.includes("admin") && !c.get("user").roles.includes("admin")) return c.json({ error: "เฉพาะผู้ดูแลระบบเท่านั้นที่จัดการบัญชีผู้ดูแลระบบได้" }, 403);
  if (!(await withinActorPermissions(c, target.roles))) return c.json({ error: BEYOND_ACTOR }, 403);
  if (target.status !== "active") return c.json({ error: "บัญชีนี้ถูกระงับ เปิดใช้งานก่อนส่งคำเชิญ" }, 400);
  const debug = await sendInvite(c, target);
  await audit(c, "invite", "user", target.id);
  return c.json({ message: `ส่งคำเชิญไปที่ ${target.email} อีกครั้งแล้ว`, ...debug });
});

accountsRouter.post("/accounts/:id/sign-out", permit("users.manage"), async (c) => {
  const id = c.req.param("id");
  const roles = await targetRoles(c.env.DB, id);
  if (!roles) return c.json({ error: "ไม่พบผู้ใช้" }, 404);
  if (!c.get("user").roles.includes("admin") && roles.includes("admin")) return c.json({ error: "เฉพาะผู้ดูแลระบบเท่านั้นที่จัดการบัญชีผู้ดูแลระบบได้" }, 403);
  if (!(await withinActorPermissions(c, roles))) return c.json({ error: BEYOND_ACTOR }, 403);
  await c.env.DB.prepare("UPDATE users SET sessions_revoked_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
  await audit(c, "sign_out", "user", id);
  return c.json({ message: "ออกจากระบบทุกอุปกรณ์แล้ว" });
});

// ---------- Role permission matrix ----------

accountsRouter.get("/roles", permit("users.view", "roles.manage"), async (c) => {
  const roles = await Promise.all(ROLES.map(async key => ({
    key, ...ROLE_INFO[key],
    locked: key === "admin",
    permissions: await permissionsForRole(c.env.DB, key as UserPayload["role"])
  })));
  return c.json({
    roles,
    permissions: PERMISSIONS.map(p => ({ key: p.key, group: p.group, label: p.label, grantable: grantable(p.key) })),
    defaults: DEFAULT_GRANTS,
    canEdit: (await currentPermissions(c)).has("roles.manage")
  });
});

accountsRouter.put("/roles/:role", permit("roles.manage"), async (c) => {
  const role = c.req.param("role");
  if (!isRole(role)) return c.json({ error: "บทบาทไม่ถูกต้อง" }, 404);
  if (role === "admin") return c.json({ error: "ผู้ดูแลระบบมีสิทธิ์ทุกข้อเสมอ แก้ไขไม่ได้" }, 400);
  const body = await c.req.json<{ permissions?: unknown }>().catch(() => null);
  if (!Array.isArray(body?.permissions) || !body!.permissions.every(isPermission)) return c.json({ error: "รายการสิทธิ์ไม่ถูกต้อง" }, 400);
  const next = Array.from(new Set(body!.permissions as Permission[]));
  const blocked = next.filter(p => !grantable(p));
  if (blocked.length) return c.json({ error: `สิทธิ์ต่อไปนี้ให้ได้เฉพาะผู้ดูแลระบบ: ${blocked.join(", ")}` }, 400);
  const before = await permissionsForRole(c.env.DB, role);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM role_permissions WHERE role = ?").bind(role),
    ...next.map(p => c.env.DB.prepare("INSERT INTO role_permissions (role, permission) VALUES (?, ?)").bind(role, p))
  ]);
  await audit(c, "update", "role", role, {
    added: next.filter(p => !before.includes(p)),
    removed: before.filter(p => !next.includes(p))
  });
  return c.json({ role, permissions: next });
});
