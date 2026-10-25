/**
 * Outgoing webhook building blocks: event catalog, destination URL guard (SSRF) and payload signing.
 * Pure functions only (no D1, no local imports) so they are unit-tested under Node in
 * tests/oidc-verify.test.mjs. The delivery engine lives in handlers/platform.ts.
 *
 * Signature (Stripe-style, Zapier/Make friendly):
 *   X-NetPrime-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 * Receivers recompute the HMAC over the raw body and reject timestamps older than 5 minutes.
 */

/** Webhook event name → user_events types (utils/events.ts trackEvent) that produce it. */
export const WEBHOOK_EVENTS = {
  "user.created": { label: "สมัครสมาชิก / สร้างผู้ใช้ใหม่", types: ["signup"] },
  "enrollment.created": { label: "ลงทะเบียนเรียนคอร์ส", types: ["enroll"] },
  "lesson.completed": { label: "เรียนจบบทเรียน", types: ["lesson_complete"] },
  "course.completed": { label: "เรียนจบคอร์ส", types: ["course_complete"] },
  "order.created": { label: "สร้างคำสั่งซื้อ", types: ["order_created"] },
  "order.paid": { label: "ชำระเงินสำเร็จ", types: ["order_paid"] },
  "certificate.issued": { label: "ออกใบประกาศ", types: ["certificate_issued"] },
  "exam.submitted": { label: "ส่งข้อสอบ", types: ["exam_submit"] },
  "quiz.submitted": { label: "ส่งแบบทดสอบ", types: ["quiz_submit"] },
  "assignment.submitted": { label: "ส่งงาน", types: ["assignment_submit"] },
  "lead.created": { label: "มี lead ใหม่จากฟอร์ม", types: ["lead_created", "lead_submit"] },
  "registration.created": { label: "สมัครรอบอบรม", types: ["session_register", "registration_created"] }
} as const;

export type WebhookEvent = keyof typeof WEBHOOK_EVENTS;
export const WEBHOOK_EVENT_NAMES = Object.keys(WEBHOOK_EVENTS) as WebhookEvent[];

/** Maps a tracked user_events type to its webhook event, or null when nothing subscribes to it. */
export function webhookEventFor(type: string): WebhookEvent | null {
  if ((WEBHOOK_EVENT_NAMES as string[]).includes(type)) return type as WebhookEvent;
  for (const name of WEBHOOK_EVENT_NAMES) {
    if ((WEBHOOK_EVENTS[name].types as readonly string[]).includes(type)) return name;
  }
  return null;
}

/** True when an endpoint subscribed to `events` (["*"] = everything) should receive `event`. */
export function subscribed(events: readonly string[], event: string): boolean {
  return event === "ping" || events.includes("*") || events.includes(event);
}

// ---------- Destination guard ----------

const BLOCKED_HOSTS = new Set([
  "localhost", "metadata", "metadata.google.internal", "metadata.goog", "instance-data", "instance-data.ec2.internal",
  "metadata.azure.com", "kubernetes.default", "kubernetes.default.svc"
]);
const BLOCKED_SUFFIXES = [".localhost", ".test", ".local", ".internal", ".lan", ".home", ".intranet", ".corp", ".svc", ".cluster.local", ".home.arpa"];

function ipv4Private(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function ipv6Private(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false;
  if (h === "::" || h === "::1") return true;
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Private(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(h)) return true; // IPv4-mapped in hex form
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(h) || h.startsWith("64:ff9b:") || h.startsWith("2001:db8");
}

/**
 * Returns a Thai error message when the URL may not receive webhooks, else null.
 * https only, standard ports, no credentials, no IP literals in private/loopback/link-local ranges
 * (WHATWG URL parsing already normalizes decimal/hex IPv4 forms), no internal or metadata hosts.
 * Cloudflare egress cannot reach private networks anyway; this is defence in depth. `allowMock`
 * lets the local test harness use https://hooks.mock.test (never set in production).
 */
export function webhookUrlError(raw: unknown, options: { allowMock?: boolean } = {}): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 500) return "กรุณาระบุ URL ปลายทาง (ไม่เกิน 500 ตัวอักษร)";
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return "URL ไม่ถูกต้อง"; }
  if (url.protocol !== "https:") return "URL ปลายทางต้องขึ้นต้นด้วย https://";
  if (url.username || url.password) return "URL ต้องไม่มีชื่อผู้ใช้หรือรหัสผ่าน";
  if (url.port && !["443", "8443"].includes(url.port)) return "อนุญาตเฉพาะพอร์ต 443 หรือ 8443";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (options.allowMock && host === "hooks.mock.test") return null;
  if (!host || BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some(s => host.endsWith(s))) return "ไม่อนุญาตให้ส่งไปยังโฮสต์ภายในหรือ metadata";
  if (ipv4Private(host) || ipv6Private(host)) return "ไม่อนุญาตให้ส่งไปยัง IP ภายใน loopback หรือ link-local";
  if (/^[\d.]+$/.test(host)) return "URL ไม่ถูกต้อง";
  if (!host.includes(".") && !host.includes(":")) return "ต้องเป็นชื่อโดเมนแบบเต็ม เช่น hooks.zapier.com";
  return null;
}

/** Hostname or IP literal check shared with the OIDC issuer validation. */
export const isPrivateHost = (host: string) => {
  const h = host.toLowerCase().replace(/\.$/, "");
  return BLOCKED_HOSTS.has(h) || BLOCKED_SUFFIXES.some(s => h.endsWith(s)) || ipv4Private(h) || ipv6Private(h);
};

// ---------- Signing ----------

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Value of the X-NetPrime-Signature header for `body` sent at `timestamp` (unix seconds). */
export async function signatureHeader(secret: string, timestamp: number, body: string): Promise<string> {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${body}`)}`;
}

/** Receiver-side check (used by the local mock endpoint and documented for integrators). */
export async function verifySignatureHeader(secret: string, header: string, body: string, now = Math.floor(Date.now() / 1000), toleranceSeconds = 300): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map(p => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[a-f0-9]{64}$/.test(parts.v1 || "") || Math.abs(now - t) > toleranceSeconds) return false;
  const expected = await hmacHex(secret, `${t}.${body}`);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

/** Retry delays after failed attempt 1, 2, … ; after the last one the delivery is marked failed. */
export const RETRY_DELAYS_SECONDS = [5 * 60, 30 * 60, 2 * 3600, 12 * 3600, 24 * 3600];
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;

export function nextAttemptAt(attempts: number, now = Date.now()): string | null {
  const delay = RETRY_DELAYS_SECONDS[attempts - 1];
  return delay === undefined ? null : new Date(now + delay * 1000).toISOString();
}
