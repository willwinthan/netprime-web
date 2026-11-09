import { MiddlewareHandler } from "hono";
import jwt from "@tsndr/cloudflare-worker-jwt";
import { revocationKey } from "../utils/session";
import { parseRoles, primaryRole, rolesColumn, Role } from "../utils/permissions";

export interface UserPayload {
  id: string;
  email: string;
  name: string;
  /**
   * Role the current request acts as: the highest-priority role the route allows,
   * or the primary role on routes open to everyone.
   */
  role: Role;
  /** Every role the account holds, in priority order. */
  roles: Role[];
  partner_id: string | null;
  exp?: number;
  /** Issue time in milliseconds; compared with users.sessions_revoked_at. */
  iat_ms?: number;
}

export type Env = {
  Bindings: {
    DB: D1Database;
    ASSETS: R2Bucket;
    SESSIONS: KVNamespace;
    JWT_SECRET: string;
    FRONTEND_ORIGINS?: string;
    ALLOW_LOCAL_SEED_PASSWORDS?: string;
    STREAM_SIGNING_KEY: string;
    STREAM_KEY_ID: string;
    STRIPE_WEBHOOK_SECRET?: string;
    OMISE_SECRET_KEY?: string;
    RESEND_API_KEY?: string;
    /** Notion internal integration secret for article import (optional). */
    NOTION_TOKEN?: string;
    /** Public site origin used in email links, e.g. https://www.netprime.co.th (no trailing slash). */
    APP_URL?: string;
    /**
     * Origin that serves uploaded self-learning HTML, e.g. https://lessons.netprime.co.th (no trailing slash),
     * routed to this Worker. Must differ from the site's origin. Unset: this Worker's own origin.
     */
    SELF_LEARNING_ORIGIN?: string;
    /** Email From header; the domain must be verified in Resend (SPF/DKIM). */
    EMAIL_FROM?: string;
    /** Cloudflare account and API token for Stream direct creator uploads (optional). */
    STREAM_ACCOUNT_ID?: string;
    STREAM_API_TOKEN?: string;
    TURNSTILE_SECRET_KEY?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    MICROSOFT_CLIENT_ID?: string;
    MICROSOFT_CLIENT_SECRET?: string;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    AI: any;
  };
  Variables: {
    user: UserPayload;
    /** Feature permissions of the user, cached per request by utils/permissions. */
    permissions?: Set<string>;
  };
};

/** Routes an account flagged must_change_password may still call (migrations/0040_must_change_password.sql). */
const PASSWORD_CHANGE_PATHS = new Set(["/api/auth/me", "/api/auth/change-password", "/api/auth/logout"]);

/**
 * RBAC Protection Middleware
 * - Verifies Bearer JWT tokens.
 * - Performs KV session check against a blacklisted sessions lookup.
 * - Restricts access to routes based on user role authorization constraints.
 *   An account with several roles passes when any of them is allowed.
 */
export function rbac(allowedRoles?: Array<UserPayload["role"]>): MiddlewareHandler<Env> {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "ยังไม่ได้เข้าสู่ระบบ: ไม่พบโทเค็นหรือรูปแบบโทเค็นไม่ถูกต้อง" }, 401);
    }

    const token = authHeader.substring(7).trim();

    if (!c.env.JWT_SECRET || c.env.JWT_SECRET.length < 32) {
      return c.json({ error: "ระบบยืนยันตัวตนยังไม่ได้ตั้งค่า" }, 503);
    }

    try {
      // 1. Verify token session blacklist in KV store
      const isBlacklisted = await c.env.SESSIONS.get(await revocationKey(token));
      if (isBlacklisted) {
        return c.json({ error: "ยังไม่ได้เข้าสู่ระบบ: เซสชันถูกยกเลิกหรือออกจากระบบแล้ว" }, 401);
      }

      // 2. Cryptographically verify JWT using Private Secret Key
      const isValid = await jwt.verify(token, c.env.JWT_SECRET);
      if (!isValid) {
        return c.json({ error: "ยังไม่ได้เข้าสู่ระบบ: โทเค็นไม่ถูกต้องหรือหมดอายุ" }, 401);
      }

      // 3. Decode token payload context
      const decoded = jwt.decode(token);
      const payload = decoded.payload as UserPayload;

      if (!payload || typeof payload.id !== "string" || !Number.isFinite(payload.exp) || payload.exp! <= Date.now() / 1000) {
        return c.json({ error: "ยังไม่ได้เข้าสู่ระบบ: ข้อมูลในโทเค็นไม่ถูกต้อง" }, 401);
      }

      // Reload identity so changed roles, organizations and deleted users take effect.
      const account = await c.env.DB.prepare(`SELECT u.id, u.email, u.name, COALESCE(u.staff_role, u.role) AS primary_role, ${rolesColumn("u")} AS role_list,
        u.partner_id, u.status, u.sessions_revoked_at, u.must_change_password FROM users u WHERE u.id = ?`).bind(payload.id)
        .first<{ id: string; email: string; name: string; primary_role: string; role_list: string | null; partner_id: string | null; status: string; sessions_revoked_at: string | null; must_change_password: number | null }>();
      if (!account) return c.json({ error: "ยังไม่ได้เข้าสู่ระบบ: ไม่พบบัญชีผู้ใช้นี้แล้ว" }, 401);
      if (account.status !== "active") return c.json({ error: "บัญชีนี้ถูกระงับ กรุณาติดต่อผู้ดูแลระบบ" }, 401);
      // "Sign out everywhere": tokens issued before the revocation time stop working.
      if (account.sessions_revoked_at) {
        const revokedAt = Date.parse(account.sessions_revoked_at);
        if (!Number.isFinite(payload.iat_ms) || payload.iat_ms! <= revokedAt) {
          return c.json({ error: "ยังไม่ได้เข้าสู่ระบบ: เซสชันถูกยกเลิก กรุณาเข้าสู่ระบบใหม่" }, 401);
        }
      }
      // A password chosen by someone else must be replaced before anything else works.
      if (account.must_change_password && !PASSWORD_CHANGE_PATHS.has(c.req.path.replace(/\/+$/, ""))) {
        return c.json({ error: "กรุณาตั้งรหัสผ่านใหม่ของคุณก่อนใช้งานระบบ", code: "password_change_required" }, 403);
      }
      const roles = parseRoles(account.role_list, account.primary_role);

      // 4. Role Authorization check: act as the most privileged role this route allows.
      let role = primaryRole(roles);
      if (allowedRoles && allowedRoles.length > 0) {
        const allowed = roles.find(r => allowedRoles.includes(r));
        if (!allowed) {
          return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: บทบาทของคุณไม่ได้รับอนุญาต" }, 403);
        }
        role = allowed;
      }

      // 5. Store user payload context inside Hono variables
      c.set("user", { id: account.id, email: account.email, name: account.name, role, roles, partner_id: account.partner_id, exp: payload.exp });
    } catch (err: any) {
      console.error("RBAC authorization validation error:", err);
      return c.json({ error: "ยังไม่ได้เข้าสู่ระบบ: ตรวจสอบการยืนยันตัวตนไม่สำเร็จ" }, 401);
    }
    await next();
  };
}
