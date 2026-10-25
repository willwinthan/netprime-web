/**
 * Live meeting providers for online/hybrid training sessions and course live classes.
 *  - zoom:   Server-to-Server OAuth app (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET),
 *            scopes meeting:write:admin (create) and report:read:admin (participant report, paid plans).
 *  - teams:  Microsoft Graph online meeting with client credentials (MS_TENANT_ID, MS_CLIENT_ID,
 *            MS_CLIENT_SECRET, MS_TEAMS_ORGANIZER_ID = organizer's Entra object id); needs the
 *            OnlineMeetings.ReadWrite.All application permission and an application access policy.
 *  - meet / manual: staff paste the link (Google Meet, Webex, …); no API call.
 * Every external call is a no-op that answers 503 when its provider is not configured.
 */
export type MeetingProvider = "zoom" | "teams" | "meet" | "manual";
export const MEETING_PROVIDERS: MeetingProvider[] = ["zoom", "teams", "meet", "manual"];

export interface MeetingEnv {
  SESSIONS: KVNamespace;
  ZOOM_ACCOUNT_ID?: string;
  ZOOM_CLIENT_ID?: string;
  ZOOM_CLIENT_SECRET?: string;
  MS_TENANT_ID?: string;
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
  MS_TEAMS_ORGANIZER_ID?: string;
}

export class MeetingError extends Error {
  status: 400 | 502 | 503;
  constructor(message: string, status: 400 | 502 | 503) { super(message); this.status = status; }
}

export const zoomConfigured = (env: MeetingEnv) => !!(env.ZOOM_ACCOUNT_ID && env.ZOOM_CLIENT_ID && env.ZOOM_CLIENT_SECRET);
export const teamsConfigured = (env: MeetingEnv) => !!(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET && env.MS_TEAMS_ORGANIZER_ID);

export function providerStatus(env: MeetingEnv): Record<MeetingProvider, { configured: boolean; automatic: boolean; label: string }> {
  return {
    zoom: { configured: zoomConfigured(env), automatic: true, label: "Zoom" },
    teams: { configured: teamsConfigured(env), automatic: true, label: "Microsoft Teams" },
    meet: { configured: true, automatic: false, label: "Google Meet (วางลิงก์)" },
    manual: { configured: true, automatic: false, label: "ลิงก์อื่น ๆ" }
  };
}

export interface CreatedMeeting { join_url: string; external_id: string | null; passcode: string | null }

const TIMEOUT = 10_000;

async function zoomToken(env: MeetingEnv): Promise<string> {
  const cacheKey = `meeting-token:zoom:${env.ZOOM_CLIENT_ID}`;
  const cached = await env.SESSIONS.get(cacheKey);
  if (cached) return cached;
  const res = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(env.ZOOM_ACCOUNT_ID!)}`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`) },
    signal: AbortSignal.timeout(TIMEOUT)
  });
  const data = await res.json<any>().catch(() => ({}));
  if (!res.ok || typeof data.access_token !== "string") throw new MeetingError("เชื่อมต่อ Zoom ไม่สำเร็จ ตรวจสอบ Server-to-Server OAuth app", 502);
  await env.SESSIONS.put(cacheKey, data.access_token, { expirationTtl: Math.max(60, Math.min(3300, (Number(data.expires_in) || 3600) - 300)) });
  return data.access_token;
}

async function graphToken(env: MeetingEnv): Promise<string> {
  const cacheKey = `meeting-token:graph:${env.MS_CLIENT_ID}`;
  const cached = await env.SESSIONS.get(cacheKey);
  if (cached) return cached;
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env.MS_TENANT_ID!)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.MS_CLIENT_ID!, client_secret: env.MS_CLIENT_SECRET!, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
    signal: AbortSignal.timeout(TIMEOUT)
  });
  const data = await res.json<any>().catch(() => ({}));
  if (!res.ok || typeof data.access_token !== "string") throw new MeetingError("เชื่อมต่อ Microsoft Graph ไม่สำเร็จ ตรวจสอบ app registration", 502);
  await env.SESSIONS.put(cacheKey, data.access_token, { expirationTtl: Math.max(60, Math.min(3300, (Number(data.expires_in) || 3600) - 300)) });
  return data.access_token;
}

/** Creates a meeting with the provider API (zoom/teams). Callers handle meet/manual links themselves. */
export async function createMeeting(env: MeetingEnv, provider: MeetingProvider, input: { topic: string; startsAt: string; durationMinutes: number }): Promise<CreatedMeeting> {
  if (provider === "zoom") {
    if (!zoomConfigured(env)) throw new MeetingError("ยังไม่ได้ตั้งค่า Zoom (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET)", 503);
    const res = await fetch("https://api.zoom.us/v2/users/me/meetings", {
      method: "POST",
      headers: { Authorization: `Bearer ${await zoomToken(env)}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: input.topic.slice(0, 200), type: 2, start_time: input.startsAt, duration: input.durationMinutes, timezone: "Asia/Bangkok",
        settings: { join_before_host: false, waiting_room: true, approval_type: 2, meeting_authentication: false }
      }),
      signal: AbortSignal.timeout(TIMEOUT)
    });
    const data = await res.json<any>().catch(() => ({}));
    if (!res.ok || typeof data.join_url !== "string") throw new MeetingError("สร้างห้อง Zoom ไม่สำเร็จ", 502);
    return { join_url: data.join_url, external_id: data.id != null ? String(data.id) : null, passcode: typeof data.password === "string" ? data.password : null };
  }
  if (provider === "teams") {
    if (!teamsConfigured(env)) throw new MeetingError("ยังไม่ได้ตั้งค่า Microsoft Teams (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TEAMS_ORGANIZER_ID)", 503);
    const end = new Date(Date.parse(input.startsAt) + input.durationMinutes * 60_000).toISOString();
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.MS_TEAMS_ORGANIZER_ID!)}/onlineMeetings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await graphToken(env)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subject: input.topic.slice(0, 200), startDateTime: input.startsAt, endDateTime: end, lobbyBypassSettings: { scope: "organization" } }),
      signal: AbortSignal.timeout(TIMEOUT)
    });
    const data = await res.json<any>().catch(() => ({}));
    if (!res.ok || typeof data.joinWebUrl !== "string") throw new MeetingError("สร้างห้อง Microsoft Teams ไม่สำเร็จ", 502);
    return { join_url: data.joinWebUrl, external_id: typeof data.id === "string" ? data.id : null, passcode: data.joinMeetingIdSettings?.passcode ?? null };
  }
  throw new MeetingError("ผู้ให้บริการนี้ต้องวางลิงก์เอง", 400);
}

export interface Participant { email: string; name: string; minutes: number }

/** Zoom past-meeting participant report (paid Zoom plans, report:read:admin). Emails are lower-cased. */
export async function zoomParticipants(env: MeetingEnv, meetingId: string): Promise<Participant[]> {
  if (!zoomConfigured(env)) throw new MeetingError("ยังไม่ได้ตั้งค่า Zoom", 503);
  if (!/^\d{6,15}$/.test(meetingId)) throw new MeetingError("รหัสห้อง Zoom ไม่ถูกต้อง", 400);
  const token = await zoomToken(env);
  const byEmail = new Map<string, Participant>();
  let next = "";
  for (let page = 0; page < 20; page++) {
    const url = `https://api.zoom.us/v2/report/meetings/${meetingId}/participants?page_size=300${next ? `&next_page_token=${encodeURIComponent(next)}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT) });
    const data = await res.json<any>().catch(() => ({}));
    if (res.status === 404) throw new MeetingError("ยังไม่มีรายงานผู้เข้าร่วม (ห้องต้องจบแล้ว)", 400);
    if (!res.ok) throw new MeetingError("ดึงรายงานผู้เข้าร่วมจาก Zoom ไม่สำเร็จ (ต้องใช้ Zoom แบบเสียเงินและสิทธิ์ report:read:admin)", 502);
    for (const p of Array.isArray(data.participants) ? data.participants : []) {
      const email = typeof p.user_email === "string" ? p.user_email.trim().toLowerCase() : "";
      if (!email) continue;
      const prev = byEmail.get(email);
      const minutes = Math.round((Number(p.duration) || 0) / 60);
      byEmail.set(email, { email, name: String(p.name || prev?.name || ""), minutes: (prev?.minutes || 0) + minutes });
    }
    next = typeof data.next_page_token === "string" ? data.next_page_token : "";
    if (!next) break;
  }
  return [...byEmail.values()];
}

// ---------- Join window ----------

/** Learners see the join button from 30 minutes before the start until 30 minutes after the end. */
export const JOIN_OPENS_BEFORE_MS = 30 * 60_000;
export const JOIN_GRACE_AFTER_MS = 30 * 60_000;

export function joinWindow(startsAt: string, endsAt: string, now = Date.now()): { open: boolean; opens_at: string; closes_at: string; ended: boolean } {
  const start = Date.parse(startsAt);
  const end = Math.max(Date.parse(endsAt), start);
  const opens = start - JOIN_OPENS_BEFORE_MS;
  const closes = end + JOIN_GRACE_AFTER_MS;
  return { open: now >= opens && now <= closes, opens_at: new Date(opens).toISOString(), closes_at: new Date(closes).toISOString(), ended: now > closes };
}

/** Normalizes an ISO date-time with an offset (or Z) to UTC ISO; null when invalid. */
export function isoInstant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** End of a YYYY-MM-DD day in Bangkok (training sessions run until their end_date). */
export const bangkokDayEnd = (ymd: string) => new Date(Date.parse(`${ymd}T23:59:59+07:00`)).toISOString();

/** Join links must be https (meeting providers never use other schemes). */
export function validJoinUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 1000) return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}
