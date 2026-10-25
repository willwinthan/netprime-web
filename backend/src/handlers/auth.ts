import { Context, Hono } from "hono";
import jwt from "@tsndr/cloudflare-worker-jwt";
import { Env, UserPayload, rbac } from "../middleware/rbac";
import { hashPassword, verifyPassword, needsPasswordUpgrade } from "../utils/crypto";
import { validOAuthRedirect } from "../utils/origins";
import { revocationKey } from "../utils/session";
import { parseRoles, permissionsForRoles, primaryRole, rolesColumn } from "../utils/permissions";
import { issueAccountToken, consumeAccountToken } from "../utils/tokens";
import { clientIp, hit, isLimited, rateLimited, tooManyRequests } from "../utils/ratelimit";
import { appUrl, sendPasswordChangedEmail, sendPasswordResetEmail, sendVerificationEmail } from "../utils/email";
import { trackEvent } from "../utils/events";
import { signupPolicyError } from "../utils/school";

export const authRouter = new Hono<Env>();
const validEmail = (value: unknown): value is string => typeof value === "string" && value.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

async function session(user: UserPayload, secret: string, db: D1Database, extra: { email_verified?: boolean; iat_ms?: number } = {}) {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const token = await jwt.sign({ ...user, exp, iat_ms: extra.iat_ms ?? Date.now(), jti: crypto.randomUUID() } as any, secret);
  return {
    token,
    user: { ...user, corporate_id: user.partner_id, permissions: await permissionsForRoles(db, user.roles), email_verified: extra.email_verified ?? false }
  };
}

/** Secret links are only echoed back for the local test harness (never set in staging/production). */
const debugLink = (c: Context<Env>, url: string) => c.env.ALLOW_LOCAL_SEED_PASSWORDS === "true" ? { debug_url: url } : {};

/** Sends after the response when the runtime allows it, so slow mail does not reveal which emails exist. */
function deliver(c: Context<Env>, label: string, task: () => Promise<void>): Promise<void> {
  const guarded = task().catch(error => console.error(`${label} email delivery failed`, error));
  try { c.executionCtx.waitUntil(guarded); return Promise.resolve(); } catch { return guarded; }
}

const validNewPassword = (value: unknown): value is string => typeof value === "string" && value.length >= 12 && value.length <= 256;

async function sendVerificationLink(c: Context<Env>, user: { id: string; email: string; name: string }): Promise<string> {
  const url = appUrl(c.env, "/verify-email?token=" + await issueAccountToken(c.env.DB, user.id, "verify"));
  await deliver(c, "Verification", () => sendVerificationEmail(user.email, user.name, url, c.env.RESEND_API_KEY, c.env.DB));
  return url;
}

// Fixed-window limits (10 minutes). Login counts failed attempts only, so busy offices behind one IP still sign in.
const LIMITS = {
  loginIp: 20, loginEmail: 10, register: 10, forgotIp: 10, forgotEmail: 5, tokenIp: 30, resend: 3, changePassword: 10
};

authRouter.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (!c.env.JWT_SECRET || c.env.JWT_SECRET.length < 32) {
    return c.json({ error: "ระบบยืนยันตัวตนยังไม่ได้ตั้งค่า" }, 503);
  }
  await next();
});

authRouter.post("/register", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลการสมัครสมาชิกไม่ถูกต้อง" }, 400);
  const { email, password, name, role, partner_id } = body;
  if (!validEmail(email) || typeof name !== "string" || !name.trim() || name.trim().length > 120 || !validNewPassword(password)) {
    return c.json({ error: "ต้องระบุอีเมลที่ถูกต้อง ชื่อ และรหัสผ่านความยาว 12–256 ตัวอักษร" }, 400);
  }
  if ((role !== undefined && role !== "student") || partner_id != null) {
    return c.json({ error: "การสมัครสมาชิกทั่วไปสำหรับผู้เรียนบุคคลเท่านั้น" }, 403);
  }
  if (await rateLimited(c.env.SESSIONS, "register", clientIp(c), LIMITS.register)) return tooManyRequests(c);
  // School sign-up terms (settings page): open sign-up and allowed email domains.
  const signupBlocked = await signupPolicyError(c.env.DB, email);
  if (signupBlocked) return c.json({ error: signupBlocked, code: "signup_closed" }, 403);
  const user: UserPayload = { id: "usr_" + crypto.randomUUID(), email: email.trim().toLowerCase(), name: name.trim(), role: "student", roles: ["student"], partner_id: null };
  try {
    await c.env.DB.prepare("INSERT INTO users (id, email, password_hash, name, role, partner_id) VALUES (?, ?, ?, ?, 'student', NULL)")
      .bind(user.id, user.email, await hashPassword(password), user.name).run();
  } catch (error: any) {
    if (error.message?.includes("UNIQUE constraint failed")) return c.json({ error: "อีเมลนี้ถูกใช้สมัครสมาชิกแล้ว" }, 409);
    throw error;
  }
  await trackEvent(c.env.DB, user.id, "signup", { data: { method: "password" } });
  // Verification is soft: the new account can sign in and study right away.
  let verifyUrl = "";
  try { verifyUrl = await sendVerificationLink(c, user); } catch (error) { console.error("Verification link failed", error); }
  return c.json({
    message: "สมัครสมาชิกสำเร็จ กรุณายืนยันอีเมลจากลิงก์ที่ส่งไป",
    ...await session(user, c.env.JWT_SECRET, c.env.DB, { email_verified: false }),
    ...(verifyUrl ? debugLink(c, verifyUrl) : {})
  }, 201);
});

authRouter.post("/login", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ต้องระบุอีเมลและรหัสผ่าน" }, 400);
  const { email, password } = body;
  if (!validEmail(email) || typeof password !== "string" || !password || password.length > 256) {
    return c.json({ error: "ต้องระบุอีเมลและรหัสผ่าน" }, 400);
  }
  const normalized = email.trim().toLowerCase();
  const ip = clientIp(c);
  if (await isLimited(c.env.SESSIONS, "login-ip", ip, LIMITS.loginIp) || await isLimited(c.env.SESSIONS, "login-email", normalized, LIMITS.loginEmail)) {
    return tooManyRequests(c);
  }
  const user = await c.env.DB.prepare(`SELECT u.id, u.email, u.password_hash, u.name, COALESCE(u.staff_role, u.role) AS role, ${rolesColumn("u")} AS role_list,
    u.partner_id, u.status, u.email_verified_at FROM users u WHERE u.email = ?`)
    .bind(normalized).first<Omit<UserPayload, "roles"> & { role_list: string | null; password_hash: string; status: string; email_verified_at: string | null }>();
  // Run the KDF even for unknown users to avoid a cheap account enumeration path.
  const stored = user?.password_hash || "pbkdf2-sha256$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000";
  const valid = await verifyPassword(password, stored, c.env.ALLOW_LOCAL_SEED_PASSWORDS === "true");
  if (!user || !valid) {
    await Promise.all([hit(c.env.SESSIONS, "login-ip", ip), hit(c.env.SESSIONS, "login-email", normalized)]);
    return c.json({ error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" }, 401);
  }
  if (user.status !== "active") return c.json({ error: "บัญชีนี้ถูกระงับ กรุณาติดต่อผู้ดูแลระบบ" }, 403);
  await c.env.DB.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?").bind(user.id).run();
  await trackEvent(c.env.DB, user.id, "login", { data: { method: "password" } });
  if (needsPasswordUpgrade(user.password_hash)) {
    await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?")
      .bind(await hashPassword(password), user.id, user.password_hash).run();
  }
  const { password_hash, status, role_list, email_verified_at, ...rest } = user;
  const roles = parseRoles(role_list, rest.role);
  const identity: UserPayload = { ...rest, role: primaryRole(roles), roles };
  return c.json({ message: "เข้าสู่ระบบสำเร็จ", ...await session(identity, c.env.JWT_SECRET, c.env.DB, { email_verified: !!email_verified_at }) });
});

// ---------- Password reset, invitations and email verification ----------

const FORGOT_MESSAGE = "หากอีเมลนี้มีบัญชีอยู่ในระบบ เราได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปแล้ว ลิงก์ใช้ได้ 1 ชั่วโมง";

/** Always answers the same way whether or not the account exists. */
authRouter.post("/forgot-password", async (c) => {
  const body = await c.req.json<{ email?: unknown }>().catch(() => null);
  if (!validEmail(body?.email)) return c.json({ error: "กรุณากรอกอีเมลที่ถูกต้อง" }, 400);
  const email = body!.email.trim().toLowerCase();
  if (await rateLimited(c.env.SESSIONS, "forgot-ip", clientIp(c), LIMITS.forgotIp) ||
      await rateLimited(c.env.SESSIONS, "forgot-email", email, LIMITS.forgotEmail)) return tooManyRequests(c);
  const user = await c.env.DB.prepare("SELECT id, email, name, status FROM users WHERE email = ?").bind(email)
    .first<{ id: string; email: string; name: string; status: string }>();
  if (!user || user.status !== "active") return c.json({ message: FORGOT_MESSAGE });
  const url = appUrl(c.env, "/reset-password?token=" + await issueAccountToken(c.env.DB, user.id, "reset"));
  await deliver(c, "Password reset", () => sendPasswordResetEmail(user.email, user.name, url, c.env.RESEND_API_KEY, c.env.DB));
  return c.json({ message: FORGOT_MESSAGE, ...debugLink(c, url) });
});

/** Sets a password from a reset or invitation link, then signs out every existing session. */
authRouter.post("/reset-password", async (c) => {
  const body = await c.req.json<{ token?: unknown; password?: unknown }>().catch(() => null);
  if (typeof body?.token !== "string" || !body.token) return c.json({ error: "ลิงก์ไม่ถูกต้อง" }, 400);
  if (!validNewPassword(body.password)) return c.json({ error: "รหัสผ่านใหม่ต้องยาว 12–256 ตัวอักษร" }, 400);
  if (await rateLimited(c.env.SESSIONS, "token-ip", clientIp(c), LIMITS.tokenIp)) return tooManyRequests(c);
  const db = c.env.DB;
  const consumed = await consumeAccountToken(db, body.token, ["reset", "invite"]);
  if (!consumed) return c.json({ error: "ลิงก์ไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่" }, 400);
  const user = await db.prepare("SELECT id, email, name, status FROM users WHERE id = ?").bind(consumed.user_id)
    .first<{ id: string; email: string; name: string; status: string }>();
  if (!user) return c.json({ error: "ลิงก์ไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่" }, 400);
  if (user.status !== "active") return c.json({ error: "บัญชีนี้ถูกระงับ กรุณาติดต่อผู้ดูแลระบบ" }, 403);
  const now = new Date().toISOString();
  await db.batch([
    // Receiving the link proves the address, so the account also becomes verified.
    db.prepare("UPDATE users SET password_hash = ?, sessions_revoked_at = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?")
      .bind(await hashPassword(body.password), now, now, user.id),
    db.prepare("UPDATE account_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND purpose IN ('reset', 'invite') AND used_at IS NULL").bind(user.id)
  ]);
  if (consumed.purpose === "reset") {
    await deliver(c, "Password changed", () => sendPasswordChangedEmail(user.email, user.name, appUrl(c.env, "/dashboard"), c.env.RESEND_API_KEY, c.env.DB));
  }
  return c.json({
    message: consumed.purpose === "invite" ? "ตั้งรหัสผ่านเรียบร้อย เข้าสู่ระบบด้วยอีเมลและรหัสผ่านใหม่ได้เลย" : "ตั้งรหัสผ่านใหม่แล้ว กรุณาเข้าสู่ระบบอีกครั้ง",
    email: user.email,
    invite: consumed.purpose === "invite"
  });
});

authRouter.post("/verify-email", async (c) => {
  const body = await c.req.json<{ token?: unknown }>().catch(() => null);
  if (typeof body?.token !== "string" || !body.token) return c.json({ error: "ลิงก์ไม่ถูกต้อง" }, 400);
  if (await rateLimited(c.env.SESSIONS, "token-ip", clientIp(c), LIMITS.tokenIp)) return tooManyRequests(c);
  const consumed = await consumeAccountToken(c.env.DB, body.token, ["verify"]);
  if (!consumed) return c.json({ error: "ลิงก์ยืนยันไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว ขอลิงก์ใหม่ได้จากหน้าโปรไฟล์" }, 400);
  await c.env.DB.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?")
    .bind(new Date().toISOString(), consumed.user_id).run();
  return c.json({ message: "ยืนยันอีเมลเรียบร้อยแล้ว", email_verified: true });
});

authRouter.post("/resend-verification", rbac(), async (c) => {
  const user = c.get("user");
  const row = await c.env.DB.prepare("SELECT email_verified_at FROM users WHERE id = ?").bind(user.id).first<{ email_verified_at: string | null }>();
  if (row?.email_verified_at) return c.json({ message: "อีเมลนี้ยืนยันแล้ว", email_verified: true });
  if (await rateLimited(c.env.SESSIONS, "resend-verify", user.id, LIMITS.resend)) return tooManyRequests(c);
  const url = await sendVerificationLink(c, user);
  return c.json({ message: `ส่งลิงก์ยืนยันไปที่ ${user.email} แล้ว`, email_verified: false, ...debugLink(c, url) });
});

/**
 * Logout User (Blacklist Token)
 * POST /api/auth/logout
 */
authRouter.post("/logout", rbac(), async (c) => {
  const authHeader = c.req.header("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    try {
      const decoded = jwt.decode(token);
      const payload = decoded.payload as UserPayload;
      const exp = payload?.exp;
      
      // Calculate expiration TTL in seconds
      const ttl = exp ? exp - Math.floor(Date.now() / 1000) : 86400;

      if (ttl > 0) {
        // Blacklist token in KV with expiration matching JWT exp
        await c.env.SESSIONS.put(await revocationKey(token), "blacklisted", { expirationTtl: Math.max(60, ttl) });
      } else {
        await c.env.SESSIONS.put(await revocationKey(token), "blacklisted");
      }
    } catch (err) {
      // Fallback if decode fails
      await c.env.SESSIONS.put(await revocationKey(token), "blacklisted", { expirationTtl: 86400 });
    }
  }

  return c.json({ message: "ออกจากระบบและสิ้นสุดเซสชันเรียบร้อยแล้ว" });
});

async function profile(c: Context<Env>, user: UserPayload) {
  const row = await c.env.DB.prepare("SELECT email_verified_at FROM users WHERE id = ?").bind(user.id).first<{ email_verified_at: string | null }>();
  return {
    ...user,
    corporate_id: user.partner_id,
    permissions: await permissionsForRoles(c.env.DB, user.roles),
    email_verified: !!row?.email_verified_at
  };
}

/**
 * Get profile context
 * GET /api/auth/me
 */
authRouter.get("/me", rbac(), async (c) => c.json({ user: await profile(c, c.get("user")) }));

/** Self-service profile: only the display name is editable (email is the sign-in identity). */
authRouter.patch("/me", rbac(), async (c) => {
  const body = await c.req.json<{ name?: unknown }>().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 120) return c.json({ error: "กรุณากรอกชื่อ (ไม่เกิน 120 ตัวอักษร)" }, 400);
  const user = c.get("user");
  await c.env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, user.id).run();
  return c.json({ message: "บันทึกชื่อแล้ว", user: await profile(c, { ...user, name }) });
});

/**
 * Changes the password after checking the current one, signs out every other session
 * and returns a fresh token so this browser stays signed in.
 */
authRouter.post("/change-password", rbac(), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ current_password?: unknown; new_password?: unknown }>().catch(() => null);
  const current = typeof body?.current_password === "string" ? body.current_password : "";
  if (!current || current.length > 256) return c.json({ error: "กรุณากรอกรหัสผ่านปัจจุบัน" }, 400);
  if (!validNewPassword(body?.new_password)) return c.json({ error: "รหัสผ่านใหม่ต้องยาว 12–256 ตัวอักษร" }, 400);
  const next = body!.new_password as string;
  if (next === current) return c.json({ error: "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม" }, 400);
  if (await isLimited(c.env.SESSIONS, "change-password", user.id, LIMITS.changePassword)) return tooManyRequests(c);
  const row = await c.env.DB.prepare("SELECT password_hash, email_verified_at FROM users WHERE id = ?").bind(user.id)
    .first<{ password_hash: string; email_verified_at: string | null }>();
  if (!row || !(await verifyPassword(current, row.password_hash, c.env.ALLOW_LOCAL_SEED_PASSWORDS === "true"))) {
    await hit(c.env.SESSIONS, "change-password", user.id);
    return c.json({ error: "รหัสผ่านปัจจุบันไม่ถูกต้อง" }, 400);
  }
  const revokedMs = Date.now();
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, sessions_revoked_at = ? WHERE id = ?")
    .bind(await hashPassword(next), new Date(revokedMs).toISOString(), user.id).run();
  await deliver(c, "Password changed", () => sendPasswordChangedEmail(user.email, user.name, appUrl(c.env, "/dashboard"), c.env.RESEND_API_KEY, c.env.DB));
  const { exp, ...identity } = user;
  const fresh = await session(identity, c.env.JWT_SECRET, c.env.DB, { iat_ms: revokedMs + 1, email_verified: !!row.email_verified_at });
  return c.json({ message: "เปลี่ยนรหัสผ่านแล้ว อุปกรณ์อื่นถูกออกจากระบบ", ...fresh });
});

/**
 * Get Available OAuth Providers Configuration & Status
 * GET /api/auth/oauth/providers
 */
function oauthConfig(env: Env["Bindings"], provider: string) {
  const configs: Record<string, { clientId?: string; secret?: string; url: string; scope: string }> = {
    google: { clientId: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET, url: "https://accounts.google.com/o/oauth2/v2/auth", scope: "openid email profile" },
    github: { clientId: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET, url: "https://github.com/login/oauth/authorize", scope: "user:email read:user" }
  };
  // Microsoft remains disabled until tenant/issuer validation and account linking are implemented.
  return configs[provider];
}

authRouter.get("/oauth/providers", (c) => {
  const providers = Object.fromEntries(["google", "microsoft", "github"].map(provider => {
    const config = oauthConfig(c.env, provider);
    const enabled = !!(config?.clientId && config?.secret);
    return [provider, { enabled, configured: enabled, supportsOneTap: false }];
  }));
  return c.json({ providers });
});

authRouter.get("/oauth/:provider/url", async (c) => {
  const provider = c.req.param("provider").toLowerCase();
  const config = oauthConfig(c.env, provider);
  if (!config?.clientId || !config.secret) return c.json({ error: "ผู้ให้บริการเข้าสู่ระบบนี้ยังไม่พร้อมใช้งาน" }, 503);
  const redirectUri = c.req.query("redirect_uri") || "";
  if (!validOAuthRedirect(redirectUri, provider, c.env.FRONTEND_ORIGINS)) return c.json({ error: "ไม่อนุญาตให้ใช้ Redirect URI นี้" }, 400);
  const state = crypto.randomUUID() + crypto.randomUUID();
  await c.env.SESSIONS.put(`oauth-state:${state}`, JSON.stringify({ provider, redirectUri }), { expirationTtl: 600 });
  const url = config.url + "?" + new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri, response_type: "code", scope: config.scope, state });
  return c.json({ url, state, provider });
});

class SignupBlockedError extends Error {}

/**
 * Helper to authenticate or auto-provision OAuth profile in D1
 */
async function handleOAuthUserProfile(
  db: D1Database,
  jwtSecret: string,
  resendApiKey: string | undefined,
  appBase: string,
  profile: {
    email: string;
    name: string;
    avatarUrl?: string;
    provider: string;
    providerId?: string;
  }
) {
  if (!validEmail(profile.email) || !profile.providerId) throw new Error("INVALID_PROVIDER_IDENTITY");
  const normalizedEmail = profile.email.toLowerCase().trim();
  const displayName = profile.name || normalizedEmail.split("@")[0];
  const linked = await db.prepare(`SELECT u.id, u.email, u.name, COALESCE(u.staff_role, u.role) AS role, ${rolesColumn("u")} AS role_list, u.partner_id, u.status, u.email_verified_at
    FROM oauth_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?`)
    .bind(profile.provider, profile.providerId).first<Omit<UserPayload, "roles"> & { role_list: string | null; status: string; email_verified_at: string | null }>();
  if (linked && linked.status !== "active") throw new Error("ACCOUNT_SUSPENDED");
  let userId: string;
  let userRoles: UserPayload["roles"] = ["student"];
  let partnerId: string | null = null;
  let userName = displayName;
  let userEmail = normalizedEmail;
  if (linked) {
    userId = linked.id;
    userRoles = parseRoles(linked.role_list, linked.role);
    partnerId = linked.partner_id;
    userName = linked.name;
    userEmail = linked.email;
  } else {
    const existing = await db.prepare("SELECT id FROM users WHERE email = ?").bind(normalizedEmail).first();
    if (existing) throw new Error("ACCOUNT_LINK_REQUIRED");
    // A new account through Google/GitHub is a self-service sign-up: the school's sign-up terms apply.
    const signupBlocked = await signupPolicyError(db, normalizedEmail);
    if (signupBlocked) throw new SignupBlockedError(signupBlocked);
    userId = "usr_" + crypto.randomUUID();
    await db.batch([
      // The provider only returns verified addresses, so OAuth accounts start verified.
      db.prepare("INSERT INTO users (id, email, password_hash, name, role, partner_id, email_verified_at) VALUES (?, ?, ?, ?, 'student', NULL, ?)")
        .bind(userId, normalizedEmail, await hashPassword(crypto.randomUUID()), displayName, new Date().toISOString()),
      db.prepare("INSERT INTO oauth_identities (provider, subject, user_id) VALUES (?, ?, ?)")
        .bind(profile.provider, profile.providerId, userId)
    ]);
    try {
      const { sendWelcomeEmail } = await import("../utils/email");
      await sendWelcomeEmail(normalizedEmail, displayName, resendApiKey, appBase, db);
    } catch (error) { console.error("Welcome email delivery failed", error); }
  }

  const userRole = primaryRole(userRoles);
  if (!linked) await trackEvent(db, userId, "signup", { data: { method: profile.provider } });
  await db.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?").bind(userId).run().catch(() => undefined);
  await trackEvent(db, userId, "login", { data: { method: profile.provider } });

  // 3. Issue 24-hour Netprime JWT Token
  const exp = Math.floor(Date.now() / 1000) + (24 * 60 * 60);
  const payload: UserPayload = {
    id: userId,
    email: userEmail,
    name: userName,
    role: userRole,
    roles: userRoles,
    partner_id: partnerId,
    exp
  };

  const token = await jwt.sign({ ...payload, iat_ms: Date.now(), jti: crypto.randomUUID() } as any, jwtSecret);

  return {
    token,
    user: {
      id: userId,
      email: userEmail,
      name: userName,
      role: userRole,
      roles: userRoles,
      partner_id: partnerId,
      corporate_id: partnerId,
      permissions: await permissionsForRoles(db, userRoles),
      email_verified: linked ? !!linked.email_verified_at : true,
      avatar_url: profile.avatarUrl || null,
      auth_provider: profile.provider
    }
  };
}

/**
 * Handle OAuth Callback / Exchange / Simulation
 * POST /api/auth/oauth/:provider/callback
 */
authRouter.post("/oauth/:provider/callback", async (c) => {
  const provider = c.req.param("provider").toLowerCase();
  const body = await c.req.json<{
    code?: string;
    state?: string;
    redirectUri?: string;
    simulatedProfile?: {
      email: string;
      name: string;
      avatarUrl?: string;
    };
  }>();

  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูล OAuth callback ไม่ถูกต้อง" }, 400);
  try {
    if (body.simulatedProfile) {
      return c.json({ error: "ไม่รับข้อมูลตัวตนจำลอง" }, 403);
    }
    const config = oauthConfig(c.env, provider);
    if (!config?.clientId || !config.secret) return c.json({ error: "ผู้ให้บริการเข้าสู่ระบบนี้ยังไม่พร้อมใช้งาน" }, 503);
    if (!body.state || typeof body.state !== "string" || body.state.length > 200 || !body.code || typeof body.code !== "string" || body.code.length > 4096 ||
        !body.redirectUri || !validOAuthRedirect(body.redirectUri, provider, c.env.FRONTEND_ORIGINS)) {
      return c.json({ error: "พารามิเตอร์ OAuth callback ไม่ถูกต้อง" }, 400);
    }
    const stateKey = `oauth-state:${body.state}`;
    const savedState = await c.env.SESSIONS.get(stateKey, "json") as { provider: string; redirectUri: string } | null;
    if (!savedState || savedState.provider !== provider || savedState.redirectUri !== body.redirectUri) {
      return c.json({ error: "ค่า OAuth state ไม่ถูกต้องหรือหมดอายุ" }, 400);
    }
    await c.env.SESSIONS.delete(stateKey);

    // B. Handle Live Google OAuth Code Exchange
    if (provider === "google" && body.code) {
      const clientId = c.env.GOOGLE_CLIENT_ID;
      const clientSecret = c.env.GOOGLE_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        return c.json({ error: "ยังไม่ได้ตั้งค่า Google OAuth credentials ใน Worker secrets" }, 400);
      }

      // Exchange authorization code for tokens
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: body.code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: body.redirectUri || "",
          grant_type: "authorization_code"
        })
      });

      const tokenData = await tokenRes.json<any>();
      if (!tokenRes.ok || !tokenData.access_token) {
        return c.json({ error: tokenData.error_description || "แลกเปลี่ยน Google OAuth code ไม่สำเร็จ" }, 400);
      }

      // Fetch user profile from Google UserInfo endpoint
      const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const googleUser = await userRes.json<any>();

      if (!userRes.ok || !googleUser.sub || !googleUser.email || googleUser.email_verified !== true) {
        return c.json({ error: "บัญชี Google นี้ไม่มีอีเมลที่ยืนยันแล้ว" }, 400);
      }

      const result = await handleOAuthUserProfile(
        c.env.DB,
        c.env.JWT_SECRET,
        c.env.RESEND_API_KEY,
        appUrl(c.env, ""),
        {
          email: googleUser.email,
          name: googleUser.name || googleUser.given_name || "ผู้ใช้ Google",
          avatarUrl: googleUser.picture,
          provider: "google",
          providerId: googleUser.sub
        }
      );

      return c.json({ message: "เข้าสู่ระบบด้วย Google สำเร็จ", ...result });
    }

    // D. Handle Live GitHub OAuth Code Exchange
    if (provider === "github" && body.code) {
      const clientId = c.env.GITHUB_CLIENT_ID;
      const clientSecret = c.env.GITHUB_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        return c.json({ error: "ยังไม่ได้ตั้งค่า GitHub OAuth credentials ใน Worker secrets" }, 400);
      }

      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code: body.code,
          redirect_uri: body.redirectUri
        })
      });

      const tokenData = await tokenRes.json<any>();
      if (!tokenData.access_token) {
        return c.json({ error: tokenData.error_description || "แลกเปลี่ยน GitHub OAuth code ไม่สำเร็จ" }, 400);
      }

      // Fetch GitHub User Profile
      const ghUserRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "User-Agent": "Netprime-LMS-OAuth"
        }
      });
      const ghUser = await ghUserRes.json<any>();
      if (!ghUserRes.ok || !ghUser.id) return c.json({ error: "ตรวจสอบโปรไฟล์ GitHub ไม่สำเร็จ" }, 401);

      // Fetch emails if primary email is private
      let ghEmail: string | undefined;
      if (!ghEmail) {
        const emailRes = await fetch("https://api.github.com/user/emails", {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            "User-Agent": "Netprime-LMS-OAuth"
          }
        });
        const emails = await emailRes.json<any[]>();
        const primary = Array.isArray(emails) ? emails.find(e => e.primary && e.verified) || emails.find(e => e.verified) : undefined;
        ghEmail = primary?.email;
      }

      if (!ghEmail) {
        return c.json({ error: "บัญชี GitHub นี้ไม่มีอีเมลสาธารณะหรืออีเมลที่ยืนยันแล้ว" }, 400);
      }

      const result = await handleOAuthUserProfile(
        c.env.DB,
        c.env.JWT_SECRET,
        c.env.RESEND_API_KEY,
        appUrl(c.env, ""),
        {
          email: ghEmail,
          name: ghUser.name || ghUser.login,
          avatarUrl: ghUser.avatar_url,
          provider: "github",
          providerId: String(ghUser.id)
        }
      );

      return c.json({ message: "เข้าสู่ระบบด้วย GitHub สำเร็จ", ...result });
    }

    return c.json({ error: "ไม่พบ authorization code หรือข้อมูลจำลอง" }, 400);

  } catch (error: any) {
    console.error("OAuth callback processing error:", error);
    if (error instanceof SignupBlockedError) return c.json({ error: error.message, code: "signup_closed" }, 403);
    if (error.message === "ACCOUNT_LINK_REQUIRED") return c.json({ error: "โปรดเข้าสู่ระบบด้วยรหัสผ่าน ต้องเชื่อมบัญชีก่อนใช้ผู้ให้บริการนี้" }, 409);
    if (error.message === "ACCOUNT_SUSPENDED") return c.json({ error: "บัญชีนี้ถูกระงับ กรุณาติดต่อผู้ดูแลระบบ" }, 403);
    return c.json({ error: "ยืนยัน OAuth ไม่สำเร็จ" }, 502);
  }
});

/**
 * Direct Google Token / One-Tap Verification
 * POST /api/auth/oauth/google-token
 */
authRouter.post("/oauth/google-token", (c) => c.json({ error: "โปรดใช้การเข้าสู่ระบบแบบ authorization code" }, 403));
