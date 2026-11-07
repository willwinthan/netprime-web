/**
 * Absolute link into the web app for emails: APP_URL, else the first allowed frontend origin.
 * `path` starts with "/" (e.g. "/dashboard", "/reset-password?token=…").
 */
export function appUrl(env: { APP_URL?: string; FRONTEND_ORIGINS?: string }, path = "/"): string {
  const base = (env.APP_URL || (env.FRONTEND_ORIGINS || "").split(",")[0] || "http://localhost:5173").trim().replace(/\/+$/, "");
  return base + path;
}

/**
 * Email for Netprime LMS: sends through Resend when RESEND_API_KEY is set (a key containing "mock" only
 * logs), and records every message in email_log (ตั้งค่าระบบ › อีเมล). See deliver().
 */

export async function sendWelcomeEmail(email: string, name: string, apiKey?: string, baseUrl = appUrl({}, ""), db?: D1Database): Promise<void> {
  let subject = "ยินดีต้อนรับสู่ Netprime LMS! 🚀";
  let html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eaeaea; padding: 20px; border-radius: 10px;">
      <h2 style="color: #6366f1;">ยินดีต้อนรับสู่ Netprime LMS, ${escapeHtml(name)}!</h2>
      <p>เรายินดีที่คุณเข้าร่วมชุมชนการเรียนรู้ของเรา</p>
      <p>สร้างบัญชีผู้เรียนของคุณเรียบร้อยแล้ว ตอนนี้คุณสามารถเข้าใช้แดชบอร์ดส่วนตัวและพื้นที่เรียนของคุณได้</p>
      <div style="margin: 20px 0; text-align: center;">
        <a href="${escapeHtml(baseUrl + "/dashboard")}" style="background-color: #6366f1; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">ไปที่แดชบอร์ด</a>
      </div>
      <p style="color: #666; font-size: 12px; border-top: 1px solid #eaeaea; padding-top: 10px; margin-top: 20px;">
        ส่งถึง: ${escapeHtml(email)} • Netprime Learning Inc.
      </p>
    </div>
  `;
  
  ({ subject, html } = await renderTemplate(db, "welcome", { name, email, link: baseUrl + "/dashboard" }, { subject, html }));
  await deliver(email, subject, html, apiKey, "welcome");
}

export async function sendPaymentConfirmationEmail(
  email: string,
  name: string,
  courseTitle: string,
  amount: number,
  paymentId: string,
  apiKey?: string,
  baseUrl = appUrl({}, ""),
  db?: D1Database
): Promise<void> {
  let subject = `ใบเสร็จการลงทะเบียนเรียน: ${courseTitle} 💳`;
  let html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eaeaea; padding: 20px; border-radius: 10px;">
      <h2 style="color: #10b981;">ยืนยันการชำระเงินแล้ว!</h2>
      <p>สวัสดีคุณ ${escapeHtml(name)} ขอบคุณที่สั่งซื้อ การลงทะเบียนเรียนของคุณเปิดใช้งานแล้ว!</p>
      <div style="background-color: #f9fafb; padding: 15px; border-radius: 5px; margin: 20px 0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="font-weight: bold; padding: 5px 0;">คอร์ส:</td>
            <td style="text-align: right;">${escapeHtml(courseTitle)}</td>
          </tr>
          <tr>
            <td style="font-weight: bold; padding: 5px 0;">จำนวนเงิน:</td>
            <td style="text-align: right;">฿${amount.toLocaleString("th-TH", { minimumFractionDigits: 2 })}</td>
          </tr>
          <tr>
            <td style="font-weight: bold; padding: 5px 0;">รหัสธุรกรรม:</td>
            <td style="text-align: right; font-family: monospace;">${escapeHtml(paymentId)}</td>
          </tr>
        </table>
      </div>
      <div style="margin: 20px 0; text-align: center;">
        <a href="${escapeHtml(baseUrl + "/dashboard")}" style="background-color: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">เริ่มเรียนเลย</a>
      </div>
      <p style="color: #666; font-size: 12px; border-top: 1px solid #eaeaea; padding-top: 10px; margin-top: 20px;">
        ส่งถึง: ${escapeHtml(email)} • Netprime Learning Inc.
      </p>
    </div>
  `;
  
  ({ subject, html } = await renderTemplate(db, "receipt", { name, email, course: courseTitle, amount: amount.toLocaleString("th-TH", { minimumFractionDigits: 2 }), payment_id: paymentId, link: baseUrl + "/dashboard" }, { subject, html }));
  await deliver(email, subject, html, apiKey, "receipt");
}

export async function sendCertificateClaimedEmail(
  email: string,
  name: string,
  courseTitle: string,
  certificateCode: string,
  apiKey?: string,
  baseUrl = appUrl({}, ""),
  db?: D1Database
): Promise<void> {
  let subject = `ยินดีด้วย! ใบประกาศนียบัตรของคุณพร้อมแล้ว: ${courseTitle} 🎓`;
  let html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eaeaea; padding: 20px; border-radius: 10px;">
      <h2 style="color: #8b5cf6;">ยินดีด้วยที่เรียนจบ! 🎓</h2>
      <p>สวัสดีคุณ ${escapeHtml(name)} คุณผ่านการประเมินครบทุกขั้นตอนของคอร์ส <strong>${escapeHtml(courseTitle)}</strong> เรียบร้อยแล้ว</p>
      <p>ใบประกาศนียบัตรรับรองการเรียนจบของคุณได้รับการออกให้แล้ว และสามารถตรวจสอบความถูกต้องทางออนไลน์ได้</p>
      <div style="background-color: #f5f3ff; border: 1px dashed #8b5cf6; padding: 15px; border-radius: 5px; margin: 20px 0; text-align: center;">
        <p style="margin: 0; font-size: 12px; color: #6d28d9; text-transform: uppercase; letter-spacing: 1px; font-weight: bold;">รหัสตรวจสอบใบประกาศนียบัตร</p>
        <p style="margin: 10px 0 0 0; font-family: monospace; font-size: 18px; font-weight: bold; color: #4c1d95;">${escapeHtml(certificateCode)}</p>
      </div>
      <p style="margin-top: 20px;">คุณสามารถดูและดาวน์โหลดใบประกาศนียบัตรแบบ PDF ความละเอียดสูงสำหรับพิมพ์ได้ทุกเมื่อจากพื้นที่เรียนของคุณ</p>
      <div style="margin: 20px 0; text-align: center;">
        <a href="${escapeHtml(baseUrl + "/dashboard")}" style="background-color: #8b5cf6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">ไปที่พื้นที่เรียน</a>
      </div>
      <p style="color: #666; font-size: 12px; border-top: 1px solid #eaeaea; padding-top: 10px; margin-top: 20px;">
        ส่งถึง: ${escapeHtml(email)} • Netprime Learning Inc.
      </p>
    </div>
  `;
  
  ({ subject, html } = await renderTemplate(db, "certificate", { name, email, course: courseTitle, code: certificateCode, link: baseUrl + "/dashboard" }, { subject, html }));
  await deliver(email, subject, html, apiKey, "certificate");
}

const DEFAULT_SENDER = "Netprime LMS <noreply@netprime-lms.com>";
let sender = DEFAULT_SENDER;

/**
 * Sets the From address from the EMAIL_FROM var (e.g. "NetPrime <noreply@netprime.co.th>").
 * Called once per request/cron run; the value is the same for the whole Worker deployment.
 */
export function configureEmailSender(from?: string) {
  sender = from && /<[^\s@<>]+@[^\s@<>]+>|^[^\s@<>]+@[^\s@<>]+$/.test(from.trim()) ? from.trim() : DEFAULT_SENDER;
}

/** Database for email_log; set per request / cron run by configureEmail (one D1 binding per deployment). */
let logDb: D1Database | null = null;

/** Sender and delivery log for this request or cron run. */
export function configureEmail(env: { EMAIL_FROM?: string; DB?: D1Database }) {
  configureEmailSender(env.EMAIL_FROM);
  logDb = env.DB ?? null;
}

/** Current sender, for the admin status page. */
export const currentSender = () => sender;

/** Whether this API key really sends (local and test configs use a key containing "mock"). */
export const isLiveEmailKey = (apiKey?: string): apiKey is string => !!apiKey && !apiKey.includes("mock");

export interface SendOutcome {
  status: "sent" | "failed" | "logged";
  providerId?: string;
  error?: string;
  /** Rate limit, server error or network failure: worth sending again later. */
  retryable?: boolean;
}

/** One Resend request. Never throws. */
async function resendSend(to: string[], subject: string, html: string, apiKey: string): Promise<SendOutcome> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: sender, to, subject, html })
    });
    const data = await res.json().catch(() => ({})) as { id?: string; message?: string; name?: string };
    if (res.ok) return { status: "sent", providerId: data.id };
    const error = `Resend ${res.status}: ${data.message || data.name || "ส่งไม่สำเร็จ"}`.slice(0, 500);
    console.error("Resend API error:", error);
    return { status: "failed", error, retryable: res.status === 429 || res.status >= 500 };
  } catch (error) {
    console.error("Failed to send email via Resend:", error);
    return { status: "failed", error: `เชื่อมต่อ Resend ไม่ได้: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500), retryable: true };
  }
}

/**
 * Sends one email (several recipients share it) and records it in email_log. A temporary failure
 * (rate limit, Resend down) is tried once more right away; if it still fails, the body is kept so the
 * daily job can try again. Never throws: email must not break the request that triggered it.
 */
export async function deliver(to: string | string[], subject: string, html: string, apiKey: string | undefined, kind = "general"): Promise<SendOutcome> {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { status: "failed", error: "ไม่มีผู้รับ" };
  let outcome: SendOutcome;
  let attempts = 1;
  if (!isLiveEmailKey(apiKey)) {
    logEmail(recipients, subject, html);
    outcome = { status: "logged" };
  } else {
    outcome = await resendSend(recipients, subject, html, apiKey);
    if (outcome.status === "failed" && outcome.retryable) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      outcome = await resendSend(recipients, subject, html, apiKey);
      attempts = 2;
    }
  }
  await recordEmail(recipients.join(", "), subject, kind, outcome, attempts, outcome.status === "failed" && outcome.retryable ? html : null);
  return outcome;
}

async function recordEmail(to: string, subject: string, kind: string, outcome: SendOutcome, attempts: number, retryHtml: string | null) {
  if (!logDb) return;
  try {
    await logDb.prepare(`INSERT INTO email_log (id, to_email, subject, kind, status, provider_id, error, attempts, retry_html)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), to.slice(0, 1000), subject.slice(0, 300), kind, outcome.status, outcome.providerId ?? null, outcome.error ?? null, attempts, retryHtml)
      .run();
  } catch (error) {
    console.error("Email log write failed:", error);
  }
}

/** Retry budget for the daily job: emails failed temporarily in the last day, at most 4 tries in all. */
const MAX_ATTEMPTS = 4;

/**
 * Sends one logged email again (retry button or daily job). Only failed emails that kept their body can be
 * retried. Returns the new outcome, or null when the row cannot be retried.
 */
export async function retryLoggedEmail(db: D1Database, id: string, apiKey: string | undefined): Promise<SendOutcome | null> {
  const row = await db.prepare("SELECT to_email, subject, attempts, retry_html FROM email_log WHERE id = ? AND status = 'failed' AND retry_html IS NOT NULL")
    .bind(id).first<{ to_email: string; subject: string; attempts: number; retry_html: string }>();
  if (!row) return null;
  if (!isLiveEmailKey(apiKey)) return { status: "failed", error: "ยังไม่ได้ตั้งค่า RESEND_API_KEY", retryable: true };
  const outcome = await resendSend(row.to_email.split(", "), row.subject, row.retry_html, apiKey);
  const keep = outcome.status === "failed" && outcome.retryable && row.attempts + 1 < MAX_ATTEMPTS;
  await db.prepare(`UPDATE email_log SET status = ?, provider_id = COALESCE(?, provider_id), error = ?, attempts = attempts + 1,
      retry_html = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(outcome.status, outcome.providerId ?? null, outcome.status === "sent" ? null : outcome.error ?? null, keep ? row.retry_html : null, id).run();
  return outcome;
}

/**
 * Daily job: retries emails that failed temporarily in the last 24 hours, drops kept bodies older than
 * that (links inside may have expired), and deletes log rows older than 90 days.
 */
export async function runEmailLogJobs(env: { DB: D1Database; RESEND_API_KEY?: string }): Promise<{ retried: number; sent: number }> {
  let retried = 0, sent = 0;
  if (isLiveEmailKey(env.RESEND_API_KEY)) {
    const due = await env.DB.prepare(`SELECT id FROM email_log WHERE status = 'failed' AND retry_html IS NOT NULL
        AND attempts < ? AND created_at >= datetime('now', '-1 day') ORDER BY created_at LIMIT 50`).bind(MAX_ATTEMPTS).all<{ id: string }>();
    for (const { id } of due.results) {
      const outcome = await retryLoggedEmail(env.DB, id, env.RESEND_API_KEY);
      retried++;
      if (outcome?.status === "sent") sent++;
    }
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE email_log SET retry_html = NULL WHERE retry_html IS NOT NULL AND created_at < datetime('now', '-1 day')"),
    env.DB.prepare("DELETE FROM email_log WHERE created_at < datetime('now', '-90 days')")
  ]);
  return { retried, sent };
}

function logEmail(to: string | string[], subject: string, html: string) {
  console.log("\n========================================================");
  console.log(`✉️  [MOCK EMAIL SERVICE] SENDING EMAIL TO: ${to}`);
  console.log(`✉️  SUBJECT: ${subject}`);
  console.log("--------------------------------------------------------");
  
  // Strip tags for terminal readability
  const textBody = html
    .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
    
  console.log(textBody);
  console.log("========================================================\n");
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/**
 * Generic transactional email used by website workflows. Callers must escape user input with escapeHtml.
 */
export async function sendEmail(to: string | string[], subject: string, html: string, apiKey?: string, kind = "general"): Promise<void> {
  if (!(Array.isArray(to) ? to : [to]).some(Boolean)) return;
  await deliver(to, subject, html, apiKey, kind);
}

// ---------- Account links (reset / invitation / verification) ----------

function accountEmailHtml(email: string, heading: string, intro: string, buttonLabel: string, url: string, note: string): string {
  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eaeaea; padding: 20px; border-radius: 10px;">
      <h2 style="color: #6366f1;">${heading}</h2>
      <p>${intro}</p>
      <div style="margin: 20px 0; text-align: center;">
        <a href="${escapeHtml(url)}" style="background-color: #6366f1; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">${buttonLabel}</a>
      </div>
      <p style="color: #666; font-size: 13px;">${note}</p>
      <p style="color: #666; font-size: 12px; word-break: break-all;">หากปุ่มกดไม่ได้ ให้คัดลอกลิงก์นี้ไปเปิดในเบราว์เซอร์: ${escapeHtml(url)}</p>
      <p style="color: #666; font-size: 12px; border-top: 1px solid #eaeaea; padding-top: 10px; margin-top: 20px;">
        ส่งถึง: ${escapeHtml(email)} • Netprime Learning Inc.
      </p>
    </div>
  `;
}

/** `url` comes from appUrl(env, "/reset-password?token=…"). */
export async function sendPasswordResetEmail(email: string, name: string, url: string, apiKey?: string, db?: D1Database): Promise<void> {
  await sendTemplated(db, "reset", { name, email, link: url }, email, "ตั้งรหัสผ่านใหม่สำหรับ Netprime LMS", accountEmailHtml(email,
    "ตั้งรหัสผ่านใหม่",
    `สวัสดีคุณ ${escapeHtml(name)} เราได้รับคำขอตั้งรหัสผ่านใหม่สำหรับบัญชีของคุณ`,
    "ตั้งรหัสผ่านใหม่", url,
    "ลิงก์นี้ใช้ได้ครั้งเดียวภายใน 1 ชั่วโมง หากคุณไม่ได้ขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้ตามปกติ"), apiKey);
}

export async function sendInvitationEmail(email: string, name: string, invitedBy: string, url: string, apiKey?: string, db?: D1Database): Promise<void> {
  await sendTemplated(db, "invite", { name, email, link: url, invited_by: invitedBy }, email, "คำเชิญเข้าใช้งาน Netprime LMS", accountEmailHtml(email,
    "คุณได้รับเชิญเข้าใช้งาน Netprime LMS",
    `สวัสดีคุณ ${escapeHtml(name)} ${escapeHtml(invitedBy)} ได้สร้างบัญชีให้คุณแล้ว ตั้งรหัสผ่านเพื่อเริ่มใช้งาน`,
    "ตั้งรหัสผ่านเพื่อเริ่มใช้งาน", url,
    "ลิงก์นี้ใช้ได้ครั้งเดียวภายใน 7 วัน หากหมดอายุ ติดต่อผู้ดูแลเพื่อขอคำเชิญใหม่"), apiKey);
}

export async function sendVerificationEmail(email: string, name: string, url: string, apiKey?: string, db?: D1Database): Promise<void> {
  await sendTemplated(db, "verification", { name, email, link: url }, email, "ยืนยันอีเมลของคุณ - Netprime LMS", accountEmailHtml(email,
    "ยืนยันอีเมลของคุณ",
    `สวัสดีคุณ ${escapeHtml(name)} กรุณายืนยันว่าอีเมลนี้เป็นของคุณ เพื่อรับการแจ้งเตือนและกู้คืนบัญชีได้`,
    "ยืนยันอีเมล", url,
    "ลิงก์นี้ใช้ได้ภายใน 3 วัน หากคุณไม่ได้สมัครสมาชิก ไม่ต้องทำอะไร"), apiKey);
}

/** Security notice after a password change or reset. */
export async function sendPasswordChangedEmail(email: string, name: string, loginUrl: string, apiKey?: string, db?: D1Database): Promise<void> {
  await sendTemplated(db, "password_changed", { name, email, link: loginUrl }, email, "รหัสผ่าน Netprime LMS ของคุณถูกเปลี่ยนแล้ว", accountEmailHtml(email,
    "รหัสผ่านถูกเปลี่ยนแล้ว",
    `สวัสดีคุณ ${escapeHtml(name)} รหัสผ่านของบัญชีคุณเพิ่งถูกเปลี่ยน และอุปกรณ์อื่นถูกออกจากระบบแล้ว`,
    "เข้าสู่ระบบ", loginUrl,
    "หากคุณไม่ได้เปลี่ยนรหัสผ่านเอง ให้ใช้ \"ลืมรหัสผ่าน?\" ทันทีและติดต่อผู้ดูแลระบบ"), apiKey);
}

// ---------- Editable email templates (communication.manage; table email_templates) ----------

export type EmailTemplateKey = "welcome" | "verification" | "invite" | "reset" | "password_changed" | "receipt" | "reminder" | "certificate" | "broadcast";

/**
 * System emails staff may override. `body` is the default override text shown in the editor; the
 * built-in HTML in the send functions above stays the fallback whenever no override is saved.
 * Variables are written {{name}}; values are HTML-escaped. {{content}} (broadcast only) is pre-sanitized HTML.
 */
export const EMAIL_TEMPLATES: Record<EmailTemplateKey, { label: string; variables: string[]; subject: string; body: string; sample: Record<string, string> }> = {
  welcome: { label: "ยินดีต้อนรับ (สมัครสมาชิก)", variables: ["name", "email", "link"],
    subject: "ยินดีต้อนรับสู่ Netprime LMS!",
    body: '<h2>ยินดีต้อนรับ {{name}}!</h2><p>สร้างบัญชีผู้เรียนของคุณเรียบร้อยแล้ว</p><p><a href="{{link}}">ไปที่แดชบอร์ด</a></p>',
    sample: { name: "สมชาย ใจดี", email: "somchai@example.com", link: "https://example.com/dashboard" } },
  verification: { label: "ยืนยันอีเมล", variables: ["name", "email", "link"],
    subject: "ยืนยันอีเมลของคุณ - Netprime LMS",
    body: '<h2>ยืนยันอีเมลของคุณ</h2><p>สวัสดีคุณ {{name}} กรุณายืนยันอีเมลนี้</p><p><a href="{{link}}">ยืนยันอีเมล</a></p><p>ลิงก์ใช้ได้ภายใน 3 วัน</p>',
    sample: { name: "สมชาย ใจดี", email: "somchai@example.com", link: "https://example.com/verify-email?token=demo" } },
  invite: { label: "คำเชิญเข้าใช้งาน", variables: ["name", "email", "link", "invited_by"],
    subject: "คำเชิญเข้าใช้งาน Netprime LMS",
    body: '<h2>คุณได้รับเชิญเข้าใช้งาน</h2><p>สวัสดีคุณ {{name}} {{invited_by}} ได้สร้างบัญชีให้คุณแล้ว</p><p><a href="{{link}}">ตั้งรหัสผ่านเพื่อเริ่มใช้งาน</a></p><p>ลิงก์ใช้ได้ภายใน 7 วัน</p>',
    sample: { name: "สมชาย ใจดี", email: "somchai@example.com", link: "https://example.com/reset-password?token=demo", invited_by: "เจ้าหน้าที่" } },
  reset: { label: "ตั้งรหัสผ่านใหม่", variables: ["name", "email", "link"],
    subject: "ตั้งรหัสผ่านใหม่สำหรับ Netprime LMS",
    body: '<h2>ตั้งรหัสผ่านใหม่</h2><p>สวัสดีคุณ {{name}} เราได้รับคำขอตั้งรหัสผ่านใหม่</p><p><a href="{{link}}">ตั้งรหัสผ่านใหม่</a></p><p>ลิงก์ใช้ได้ครั้งเดียวภายใน 1 ชั่วโมง</p>',
    sample: { name: "สมชาย ใจดี", email: "somchai@example.com", link: "https://example.com/reset-password?token=demo" } },
  password_changed: { label: "แจ้งเปลี่ยนรหัสผ่าน", variables: ["name", "email", "link"],
    subject: "รหัสผ่าน Netprime LMS ของคุณถูกเปลี่ยนแล้ว",
    body: '<h2>รหัสผ่านถูกเปลี่ยนแล้ว</h2><p>สวัสดีคุณ {{name}} หากคุณไม่ได้เปลี่ยนเอง กรุณาติดต่อผู้ดูแลระบบทันที</p><p><a href="{{link}}">เข้าสู่ระบบ</a></p>',
    sample: { name: "สมชาย ใจดี", email: "somchai@example.com", link: "https://example.com/dashboard" } },
  receipt: { label: "ใบเสร็จ/ยืนยันการชำระเงิน", variables: ["name", "email", "course", "amount", "payment_id", "link"],
    subject: "ใบเสร็จการลงทะเบียนเรียน: {{course}}",
    body: '<h2>ยืนยันการชำระเงินแล้ว</h2><p>สวัสดีคุณ {{name}} การลงทะเบียนคอร์ส <strong>{{course}}</strong> เปิดใช้งานแล้ว</p><p>จำนวนเงิน ฿{{amount}} • รหัสธุรกรรม {{payment_id}}</p><p><a href="{{link}}">เริ่มเรียนเลย</a></p>',
    sample: { name: "สมชาย ใจดี", email: "somchai@example.com", course: "Cloudflare Workers", amount: "1,715.00", payment_id: "pay_demo", link: "https://example.com/dashboard" } },
  reminder: { label: "เตือนก่อนวันอบรม", variables: ["name", "email", "session", "date", "link"],
    subject: "เตือนความจำ: {{session}} เริ่ม {{date}}",
    body: '<h2>อีกไม่นานจะถึงวันอบรม</h2><p>สวัสดีคุณ {{name}} รอบอบรม <strong>{{session}}</strong> จะเริ่มวันที่ {{date}}</p><p><a href="{{link}}">ดูรายละเอียด</a></p>',
    sample: { name: "สมชาย ใจดี", email: "somchai@example.com", session: "CCNA รุ่นที่ 5", date: "1 ธ.ค. 2569", link: "https://example.com/training" } },
  certificate: { label: "ใบประกาศนียบัตรพร้อมแล้ว", variables: ["name", "email", "course", "code", "link"],
    subject: "ยินดีด้วย! ใบประกาศนียบัตรของคุณพร้อมแล้ว: {{course}}",
    body: '<h2>ยินดีด้วยที่เรียนจบ!</h2><p>สวัสดีคุณ {{name}} คุณเรียนจบคอร์ส <strong>{{course}}</strong> แล้ว</p><p>รหัสตรวจสอบ: <code>{{code}}</code></p><p><a href="{{link}}">ไปที่พื้นที่เรียน</a></p>',
    sample: { name: "สมชาย ใจดี", email: "somchai@example.com", course: "Cloudflare Workers", code: "NP-DEMO-0001", link: "https://example.com/dashboard" } },
  broadcast: { label: "กรอบอีเมลประกาศ (broadcast)", variables: ["name", "email", "title", "content", "link", "unsubscribe_link"],
    subject: "{{title}}",
    body: '<h2>{{title}}</h2>{{content}}<p style="color:#666;font-size:12px">ไม่ต้องการรับอีเมลลักษณะนี้? <a href="{{unsubscribe_link}}">ยกเลิกการรับอีเมล</a></p>',
    sample: { name: "สมชาย ใจดี", email: "somchai@example.com", title: "ข่าวสารประจำเดือน", content: "<p>เนื้อหาประกาศตัวอย่าง</p>", link: "https://example.com/dashboard", unsubscribe_link: "https://example.com/unsubscribe" } }
};

export const isEmailTemplateKey = (value: unknown): value is EmailTemplateKey =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(EMAIL_TEMPLATES, value);

/** Variables whose values are trusted HTML (already sanitized by the caller). */
const RAW_VARIABLES = new Set(["content"]);

/** Replaces {{var}}: escaped for HTML bodies, plain (single line) for subjects. Unknown variables become empty. */
export function fillTemplate(text: string, vars: Record<string, unknown>, mode: "html" | "text"): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, name: string) => {
    const value = vars[name.toLowerCase()];
    if (value === undefined || value === null) return "";
    if (mode === "text") return String(value).replace(/[\r\n]+/g, " ");
    return RAW_VARIABLES.has(name.toLowerCase()) ? String(value) : escapeHtml(value);
  });
}

/** Standard frame around an overridden body (same look as the built-in emails). */
export function emailFrame(innerHtml: string, to?: string): string {
  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eaeaea; padding: 20px; border-radius: 10px;">
      ${innerHtml}
      <p style="color: #666; font-size: 12px; border-top: 1px solid #eaeaea; padding-top: 10px; margin-top: 20px;">
        ${to ? `ส่งถึง: ${escapeHtml(to)} • ` : ""}Netprime Learning Inc.
      </p>
    </div>
  `;
}

/**
 * Subject and HTML for a system email: the staff override from email_templates when one is saved,
 * else `fallback` (the built-in email). Never throws; a database error falls back too.
 */
export async function renderTemplate(
  db: D1Database | undefined | null,
  key: EmailTemplateKey,
  vars: Record<string, unknown>,
  fallback: { subject: string; html: string }
): Promise<{ subject: string; html: string; overridden: boolean }> {
  if (!db) return { ...fallback, overridden: false };
  try {
    const row = await db.prepare("SELECT subject, body_html FROM email_templates WHERE key = ?").bind(key).first<{ subject: string; body_html: string }>();
    if (!row) return { ...fallback, overridden: false };
    return renderTemplateText(row.subject, row.body_html, vars, key);
  } catch (error) {
    console.error("Email template lookup failed:", error);
    return { ...fallback, overridden: false };
  }
}

/** Renders a template body (already sanitized when saved) with variables. */
export function renderTemplateText(subject: string, body: string, vars: Record<string, unknown>, key?: EmailTemplateKey): { subject: string; html: string; overridden: boolean } {
  let inner = fillTemplate(body, vars, "html");
  // A broadcast layout without {{content}} still carries the message.
  if (key === "broadcast" && !/\{\{\s*content\s*\}\}/i.test(body)) inner += String(vars.content ?? "");
  return { subject: fillTemplate(subject, vars, "text").slice(0, 300), html: emailFrame(inner, typeof vars.email === "string" ? vars.email : undefined), overridden: true };
}

async function sendTemplated(db: D1Database | undefined, key: EmailTemplateKey, vars: Record<string, unknown>, to: string, subject: string, html: string, apiKey?: string): Promise<void> {
  const rendered = await renderTemplate(db, key, vars, { subject, html });
  await sendEmail(to, rendered.subject, rendered.html, apiKey, key);
}

export interface BatchEmail { to: string; subject: string; html: string; headers?: Record<string, string> }

/**
 * Up to 100 separate emails in one Resend batch request (one recipient each, so headers such as
 * List-Unsubscribe stay personal). Returns how many were accepted; logs only in mock/local mode.
 */
export async function sendEmailBatch(messages: BatchEmail[], apiKey?: string): Promise<{ sent: number; failed: number }> {
  const list = messages.filter(m => m.to).slice(0, 100);
  if (!list.length) return { sent: 0, failed: 0 };
  const outcome = await resendBatch(list, apiKey);
  // Broadcast retries are handled by the broadcast queue, so no body is kept here.
  if (logDb) {
    try {
      await logDb.batch(list.map((m, i) => logDb!.prepare(`INSERT INTO email_log (id, to_email, subject, kind, status, provider_id, error, attempts)
          VALUES (?, ?, ?, 'broadcast', ?, ?, ?, 1)`)
        .bind(crypto.randomUUID(), m.to.slice(0, 1000), m.subject.slice(0, 300), outcome.status, outcome.ids?.[i] ?? null, outcome.error ?? null)));
    } catch (error) {
      console.error("Email log write failed:", error);
    }
  }
  return outcome.status === "failed" ? { sent: 0, failed: list.length } : { sent: list.length, failed: 0 };
}

async function resendBatch(list: BatchEmail[], apiKey?: string): Promise<{ status: SendOutcome["status"]; ids?: string[]; error?: string }> {
  if (!isLiveEmailKey(apiKey)) {
    for (const m of list) console.log(`✉️  [MOCK EMAIL BATCH] ${m.to}: ${m.subject}`);
    return { status: "logged" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(list.map(m => ({ from: sender, to: [m.to], subject: m.subject, html: m.html, headers: m.headers })))
    });
    const data = await res.json().catch(() => ({})) as { data?: { id: string }[]; message?: string };
    if (!res.ok) {
      const error = `Resend ${res.status}: ${data.message || "ส่งไม่สำเร็จ"}`.slice(0, 500);
      console.error("Resend batch error:", error);
      return { status: "failed", error };
    }
    return { status: "sent", ids: data.data?.map(d => d.id) };
  } catch (error) {
    console.error("Resend batch request failed:", error);
    return { status: "failed", error: `เชื่อมต่อ Resend ไม่ได้: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) };
  }
}
