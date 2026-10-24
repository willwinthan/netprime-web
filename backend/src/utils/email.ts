/**
 * Absolute link into the web app for emails: APP_URL, else the first allowed frontend origin.
 * `path` starts with "/" (e.g. "/dashboard", "/reset-password?token=…").
 */
export function appUrl(env: { APP_URL?: string; FRONTEND_ORIGINS?: string }, path = "/"): string {
  const base = (env.APP_URL || (env.FRONTEND_ORIGINS || "").split(",")[0] || "http://localhost:5173").trim().replace(/\/+$/, "");
  return base + path;
}

/**
 * Mock Email Notification Service for Netprime LMS
 * Logs formatted, clean emails to the console simulating a transaction service (e.g. Resend, SendGrid)
 */

export async function sendWelcomeEmail(email: string, name: string, apiKey?: string, baseUrl = appUrl({}, "")): Promise<void> {
  const subject = "ยินดีต้อนรับสู่ Netprime LMS! 🚀";
  const html = `
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
  
  if (apiKey && !apiKey.includes("mock")) {
    await sendViaResend(email, subject, html, apiKey);
  } else {
    logEmail(email, subject, html);
  }
}

export async function sendPaymentConfirmationEmail(
  email: string,
  name: string,
  courseTitle: string,
  amount: number,
  paymentId: string,
  apiKey?: string,
  baseUrl = appUrl({}, "")
): Promise<void> {
  const subject = `ใบเสร็จการลงทะเบียนเรียน: ${courseTitle} 💳`;
  const html = `
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
  
  if (apiKey && !apiKey.includes("mock")) {
    await sendViaResend(email, subject, html, apiKey);
  } else {
    logEmail(email, subject, html);
  }
}

export async function sendCertificateClaimedEmail(
  email: string,
  name: string,
  courseTitle: string,
  certificateCode: string,
  apiKey?: string,
  baseUrl = appUrl({}, "")
): Promise<void> {
  const subject = `ยินดีด้วย! ใบประกาศนียบัตรของคุณพร้อมแล้ว: ${courseTitle} 🎓`;
  const html = `
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
  
  if (apiKey && !apiKey.includes("mock")) {
    await sendViaResend(email, subject, html, apiKey);
  } else {
    logEmail(email, subject, html);
  }
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

async function sendViaResend(to: string | string[], subject: string, html: string, apiKey: string) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: sender,
        to: Array.isArray(to) ? to : [to],
        subject: subject,
        html: html
      })
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("Resend API error:", err);
    } else {
      console.log(`[RESEND] Successfully sent email to ${to}`);
    }
  } catch (error) {
    console.error("Failed to send email via Resend:", error);
  }
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
export async function sendEmail(to: string | string[], subject: string, html: string, apiKey?: string): Promise<void> {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (recipients.length === 0) return;
  if (apiKey && !apiKey.includes("mock")) {
    await sendViaResend(recipients, subject, html, apiKey);
  } else {
    logEmail(recipients, subject, html);
  }
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
export async function sendPasswordResetEmail(email: string, name: string, url: string, apiKey?: string): Promise<void> {
  await sendEmail(email, "ตั้งรหัสผ่านใหม่สำหรับ Netprime LMS", accountEmailHtml(email,
    "ตั้งรหัสผ่านใหม่",
    `สวัสดีคุณ ${escapeHtml(name)} เราได้รับคำขอตั้งรหัสผ่านใหม่สำหรับบัญชีของคุณ`,
    "ตั้งรหัสผ่านใหม่", url,
    "ลิงก์นี้ใช้ได้ครั้งเดียวภายใน 1 ชั่วโมง หากคุณไม่ได้ขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้ตามปกติ"), apiKey);
}

export async function sendInvitationEmail(email: string, name: string, invitedBy: string, url: string, apiKey?: string): Promise<void> {
  await sendEmail(email, "คำเชิญเข้าใช้งาน Netprime LMS", accountEmailHtml(email,
    "คุณได้รับเชิญเข้าใช้งาน Netprime LMS",
    `สวัสดีคุณ ${escapeHtml(name)} ${escapeHtml(invitedBy)} ได้สร้างบัญชีให้คุณแล้ว ตั้งรหัสผ่านเพื่อเริ่มใช้งาน`,
    "ตั้งรหัสผ่านเพื่อเริ่มใช้งาน", url,
    "ลิงก์นี้ใช้ได้ครั้งเดียวภายใน 7 วัน หากหมดอายุ ติดต่อผู้ดูแลเพื่อขอคำเชิญใหม่"), apiKey);
}

export async function sendVerificationEmail(email: string, name: string, url: string, apiKey?: string): Promise<void> {
  await sendEmail(email, "ยืนยันอีเมลของคุณ - Netprime LMS", accountEmailHtml(email,
    "ยืนยันอีเมลของคุณ",
    `สวัสดีคุณ ${escapeHtml(name)} กรุณายืนยันว่าอีเมลนี้เป็นของคุณ เพื่อรับการแจ้งเตือนและกู้คืนบัญชีได้`,
    "ยืนยันอีเมล", url,
    "ลิงก์นี้ใช้ได้ภายใน 3 วัน หากคุณไม่ได้สมัครสมาชิก ไม่ต้องทำอะไร"), apiKey);
}

/** Security notice after a password change or reset. */
export async function sendPasswordChangedEmail(email: string, name: string, loginUrl: string, apiKey?: string): Promise<void> {
  await sendEmail(email, "รหัสผ่าน Netprime LMS ของคุณถูกเปลี่ยนแล้ว", accountEmailHtml(email,
    "รหัสผ่านถูกเปลี่ยนแล้ว",
    `สวัสดีคุณ ${escapeHtml(name)} รหัสผ่านของบัญชีคุณเพิ่งถูกเปลี่ยน และอุปกรณ์อื่นถูกออกจากระบบแล้ว`,
    "เข้าสู่ระบบ", loginUrl,
    "หากคุณไม่ได้เปลี่ยนรหัสผ่านเอง ให้ใช้ \"ลืมรหัสผ่าน?\" ทันทีและติดต่อผู้ดูแลระบบ"), apiKey);
}
