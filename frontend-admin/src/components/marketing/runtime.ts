import { API_BASE_URL } from "../../hooks/useApi";

/**
 * Public-site marketing runtime: referral/UTM capture, analytics consent (PDPA), tracking pixels
 * (GA4, GTM, Meta, TikTok) and conversion events. Pixels load only after the visitor accepts
 * analytics cookies; nothing is sent before that.
 *
 * Third-party tags (GTM runs arbitrary JavaScript) never run on the signed-in console or on pages
 * whose URL carries account tokens: they load only on public marketing paths (isTaggablePath), and a
 * page that loaded them is fully reloaded when the SPA navigates to any other path, so the scripts
 * are gone before console content renders. Purchases seen in the console are queued and sent from
 * the next public page view, to GA4 / Meta / TikTok only (never via the GTM dataLayer).
 */

export interface TrackingConfig { ga4_id: string | null; gtm_id: string | null; meta_pixel_id: string | null; tiktok_pixel_id: string | null }
export interface LeadFormField { key: string; label: string; type: "text" | "email" | "tel" | "textarea" | "select" | "checkbox"; required: boolean; options?: string[] }
export interface PopupConfig { enabled: boolean; trigger: "delay" | "scroll" | "exit"; delay_seconds: number; scroll_percent: number; frequency_days: number; pages: string[] }
export interface PublicLeadForm {
  id: string; title: string; description: string | null; fields: LeadFormField[]; submit_label: string; success_message: string;
  consent_text: string; popup: PopupConfig | null;
}
export interface MarketingConfig { tracking: TrackingConfig; popups: PublicLeadForm[] }

const REF_KEY = "netprime_ref";
const UTM_KEY = "netprime_utm";
const CONSENT_KEY = "netprime_consent";
const PURCHASES_KEY = "netprime_tracked_purchases";
const PENDING_PURCHASES_KEY = "netprime_pending_purchases";
const KEEP_DAYS = 30;
export const CONSENT_EVENT = "netprime-consent-change";

type Stored<T> = T & { ts: number };

function readStored<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Stored<T>;
    if (!value.ts || Date.now() - value.ts > KEEP_DAYS * 86400_000) { localStorage.removeItem(key); return null; }
    return value;
  } catch { return null; }
}

function writeStored(key: string, value: object) {
  try { localStorage.setItem(key, JSON.stringify({ ...value, ts: Date.now() })); } catch { /* storage unavailable */ }
}

function setCookie(name: string, value: string, days: number) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${days * 86400}; Path=/; SameSite=Lax${secure}`;
}

function readCookie(name: string): string | null {
  const match = document.cookie.split("; ").find(part => part.startsWith(name + "="));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

const clip = (value: string | null, max = 100) => (value ? value.trim().slice(0, max) || null : null);

// ==========================================
// Referral code + UTM capture
// ==========================================

/**
 * Reads ?ref= and utm_* from the current URL. The referral code (last click) and the UTM tags
 * (first touch) are kept for 30 days in localStorage and a first-party cookie.
 */
export function captureAttribution(): void {
  const params = new URLSearchParams(window.location.search);
  const ref = params.get("ref");
  if (ref && /^[A-Za-z0-9]{4,20}$/.test(ref)) {
    const code = ref.toUpperCase();
    writeStored(REF_KEY, { code, landing_path: window.location.pathname });
    setCookie("np_ref", code, KEEP_DAYS);
    fetch(`${API_BASE_URL}/public/marketing/ref/click`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, path: window.location.pathname })
    }).catch(() => undefined);
  }
  const utm = { utm_source: clip(params.get("utm_source")), utm_medium: clip(params.get("utm_medium")), utm_campaign: clip(params.get("utm_campaign")) };
  if ((utm.utm_source || utm.utm_medium || utm.utm_campaign) && !readStored(UTM_KEY)) {
    writeStored(UTM_KEY, { ...utm, landing_path: window.location.pathname });
  }
}

export function storedUtm(): { utm_source: string | null; utm_medium: string | null; utm_campaign: string | null; landing_path?: string } {
  const utm = readStored<{ utm_source: string | null; utm_medium: string | null; utm_campaign: string | null; landing_path?: string }>(UTM_KEY);
  return utm ?? { utm_source: null, utm_medium: null, utm_campaign: null };
}

export function storedRef(): { code: string; landing_path?: string } | null {
  const stored = readStored<{ code: string; landing_path?: string }>(REF_KEY);
  if (stored) return stored;
  const cookie = readCookie("np_ref");
  return cookie ? { code: cookie } : null;
}

/**
 * Sends the stored referral + first-touch UTM after sign-up (the server accepts it once, only for
 * accounts created in the last 2 days, and blocks self-referral). Safe to call after every sign-in.
 */
export async function sendSignupAttribution(token: string): Promise<void> {
  const ref = storedRef();
  const utm = storedUtm();
  if (!ref && !utm.utm_source && !utm.utm_medium && !utm.utm_campaign) return;
  try {
    const res = await fetch(`${API_BASE_URL}/marketing/attribution`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ref: ref?.code, ...utm, landing_path: utm.landing_path || ref?.landing_path })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && (data.recorded || data.reason === "already_recorded" || data.reason === "account_too_old")) {
      try { localStorage.removeItem(REF_KEY); } catch { /* storage unavailable */ }
      setCookie("np_ref", "", 0);
    }
  } catch { /* Attribution is best effort. */ }
}

// ==========================================
// Consent (PDPA) and pixel loading
// ==========================================

export type Consent = "granted" | "denied" | null;

export function getConsent(): Consent {
  try {
    const value = localStorage.getItem(CONSENT_KEY);
    return value === "granted" || value === "denied" ? value : null;
  } catch { return null; }
}

export function setConsent(value: "granted" | "denied") {
  const previous = getConsent();
  try { localStorage.setItem(CONSENT_KEY, value); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(CONSENT_EVENT));
  // Pixels cannot be unloaded from a running page; reload so a withdrawn consent takes effect.
  if (previous === "granted" && value === "denied") window.location.reload();
}

/** Opens the consent banner again (footer "ตั้งค่าคุกกี้"). */
export function reopenConsent() {
  try { localStorage.removeItem(CONSENT_KEY); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(CONSENT_EVENT));
}

let configPromise: Promise<MarketingConfig | null> | null = null;
export function loadMarketingConfig(): Promise<MarketingConfig | null> {
  configPromise ??= fetch(`${API_BASE_URL}/public/marketing/config`)
    .then(res => (res.ok ? res.json() as Promise<MarketingConfig> : null))
    .catch(() => { configPromise = null; return null; });
  return configPromise;
}

export const hasTracking = (t: TrackingConfig | null | undefined) => !!t && !!(t.ga4_id || t.gtm_id || t.meta_pixel_id || t.tiktok_pixel_id);

// Same patterns as the server; ids are interpolated into script URLs only after this check.
const VALID = {
  ga4_id: /^G-[A-Z0-9]{4,15}$/, gtm_id: /^GTM-[A-Z0-9]{4,10}$/, meta_pixel_id: /^\d{8,20}$/, tiktok_pixel_id: /^[A-Z0-9]{15,25}$/
};

let loaded: TrackingConfig | null = null;

const TAGGABLE_EXACT = new Set(["/", "/courses", "/schedule", "/about", "/blog", "/privacy", "/terms", "/refund-policy"]);

/**
 * Public marketing pages where tags may run. Everything else is the signed-in console (or an account
 * page such as /reset-password, /verify-email, /auth/sso/complete whose URL carries a secret).
 */
export function isTaggablePath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return TAGGABLE_EXACT.has(path) || path.startsWith("/blog/") || path.startsWith("/p/") || /^\/courses\/[^/]+$/.test(path);
}

let navigationGuard = false;
/** After tags loaded, leaving the public site reloads the page so no tag script survives into the console. */
function guardNavigation() {
  if (navigationGuard) return;
  navigationGuard = true;
  const check = () => { if (loaded && !isTaggablePath(window.location.pathname)) window.location.reload(); };
  window.addEventListener("popstate", check);
  window.addEventListener("netprime-navigate", check);
}

function addScript(src: string) {
  const script = document.createElement("script");
  script.async = true;
  script.src = src;
  document.head.appendChild(script);
}

/** Injects the configured pixels once, only when consent is granted. */
export function loadPixels(tracking: TrackingConfig): boolean {
  if (!isTaggablePath(window.location.pathname)) return false;
  if (getConsent() !== "granted" || loaded) return !!loaded;
  const w = window as any;
  const t: TrackingConfig = {
    ga4_id: tracking.ga4_id && VALID.ga4_id.test(tracking.ga4_id) ? tracking.ga4_id : null,
    gtm_id: tracking.gtm_id && VALID.gtm_id.test(tracking.gtm_id) ? tracking.gtm_id : null,
    meta_pixel_id: tracking.meta_pixel_id && VALID.meta_pixel_id.test(tracking.meta_pixel_id) ? tracking.meta_pixel_id : null,
    tiktok_pixel_id: tracking.tiktok_pixel_id && VALID.tiktok_pixel_id.test(tracking.tiktok_pixel_id) ? tracking.tiktok_pixel_id : null
  };
  if (!hasTracking(t)) return false;
  w.dataLayer = w.dataLayer || [];
  if (t.gtm_id) {
    w.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
    addScript(`https://www.googletagmanager.com/gtm.js?id=${t.gtm_id}`);
  }
  if (t.ga4_id) {
    w.gtag = w.gtag || function gtag() { w.dataLayer.push(arguments); };
    w.gtag("js", new Date());
    // Page views are sent by trackPageView() on every SPA navigation.
    w.gtag("config", t.ga4_id, { send_page_view: false });
    addScript(`https://www.googletagmanager.com/gtag/js?id=${t.ga4_id}`);
  }
  if (t.meta_pixel_id && !w.fbq) {
    const fbq: any = function (...args: unknown[]) { fbq.callMethod ? fbq.callMethod(...args) : fbq.queue.push(args); };
    fbq.push = fbq; fbq.loaded = true; fbq.version = "2.0"; fbq.queue = [];
    w.fbq = fbq; w._fbq = fbq;
    addScript("https://connect.facebook.net/en_US/fbevents.js");
    w.fbq("init", t.meta_pixel_id);
  }
  if (t.tiktok_pixel_id && !w.ttq) {
    const methods = ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie"];
    const ttq: any = [];
    methods.forEach(m => { ttq[m] = (...args: unknown[]) => { ttq.push([m, ...args]); }; });
    w.TiktokAnalyticsObject = "ttq";
    w.ttq = ttq;
    addScript(`https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${t.tiktok_pixel_id}&lib=ttq`);
  }
  loaded = t;
  guardNavigation();
  return true;
}

// ==========================================
// Events
// ==========================================

type MarketingEvent = "page_view" | "sign_up" | "begin_checkout" | "purchase";
interface EventParams { value?: number; currency?: string; transaction_id?: string; item_id?: string; item_name?: string; method?: string }

const META_EVENT: Record<MarketingEvent, string> = { page_view: "PageView", sign_up: "CompleteRegistration", begin_checkout: "InitiateCheckout", purchase: "Purchase" };
const TIKTOK_EVENT: Record<MarketingEvent, string> = { page_view: "", sign_up: "CompleteRegistration", begin_checkout: "InitiateCheckout", purchase: "CompletePayment" };

/** Sends one event to every loaded pixel; a no-op without consent or off the public site. `skipGtm` keeps it out of the GTM dataLayer. */
export function track(event: MarketingEvent, params: EventParams = {}, options: { skipGtm?: boolean } = {}): void {
  if (!loaded || getConsent() !== "granted" || !isTaggablePath(window.location.pathname)) return;
  const w = window as any;
  const currency = params.currency || "THB";
  const items = params.item_id ? [{ item_id: params.item_id, item_name: params.item_name, price: params.value, quantity: 1 }] : undefined;
  try {
    if (loaded.gtm_id && !options.skipGtm) w.dataLayer.push({ event, ...params, currency });
    if (loaded.ga4_id && w.gtag) {
      if (event === "page_view") w.gtag("event", "page_view", { page_location: window.location.href, page_path: window.location.pathname, page_title: document.title });
      else w.gtag("event", event, { ...params, currency, items });
    }
    if (loaded.meta_pixel_id && w.fbq) {
      if (event === "page_view") w.fbq("track", "PageView");
      else w.fbq("track", META_EVENT[event], params.value !== undefined ? { value: params.value, currency, content_ids: params.item_id ? [params.item_id] : undefined } : {});
    }
    if (loaded.tiktok_pixel_id && w.ttq) {
      if (event === "page_view") w.ttq.page();
      else w.ttq.track(TIKTOK_EVENT[event], params.value !== undefined ? { value: params.value, currency, content_id: params.item_id } : {});
    }
  } catch (error) {
    console.warn("Tracking event failed", error);
  }
}

export function trackPageView() {
  track("page_view");
  flushPendingPurchases();
}

type PendingPurchase = { transaction_id: string; value: number; item_id?: string; item_name?: string };

/** Sends queued purchase events (GA4 / Meta / TikTok only) once tags are running on a public page. */
function flushPendingPurchases() {
  if (!loaded || getConsent() !== "granted" || !isTaggablePath(window.location.pathname)) return;
  let pending: PendingPurchase[] = [];
  try { pending = JSON.parse(localStorage.getItem(PENDING_PURCHASES_KEY) || "[]"); } catch { pending = []; }
  if (!Array.isArray(pending) || !pending.length) return;
  try { localStorage.removeItem(PENDING_PURCHASES_KEY); } catch { /* storage unavailable */ }
  for (const p of pending.slice(-50)) {
    if (p && typeof p.transaction_id === "string" && Number.isFinite(p.value)) {
      track("purchase", { transaction_id: p.transaction_id, value: p.value, item_id: p.item_id, item_name: p.item_name }, { skipGtm: true });
    }
  }
}

/**
 * Records `purchase` once per paid order (remembered in localStorage). Called from the learner's
 * order/payment view in the console, where no tag may load: the events are queued and sent to
 * GA4 / Meta / TikTok (not GTM) from the next public page view, only with analytics consent.
 */
export async function trackPaidOrders(orders: Array<{ id: string; status: string; amount: number; course_id?: string; course_title?: string; reference?: string }>): Promise<void> {
  if (getConsent() !== "granted") return;
  let seen: string[] = [];
  try { seen = JSON.parse(localStorage.getItem(PURCHASES_KEY) || "[]"); } catch { seen = []; }
  const fresh = orders.filter(o => o.status === "paid" && !seen.includes(o.id));
  if (!fresh.length) return;
  let pending: PendingPurchase[] = [];
  try { pending = JSON.parse(localStorage.getItem(PENDING_PURCHASES_KEY) || "[]"); } catch { pending = []; }
  if (!Array.isArray(pending)) pending = [];
  pending.push(...fresh.map(o => ({ transaction_id: o.reference || o.id, value: o.amount, item_id: o.course_id, item_name: o.course_title })));
  try {
    localStorage.setItem(PENDING_PURCHASES_KEY, JSON.stringify(pending.slice(-50)));
    localStorage.setItem(PURCHASES_KEY, JSON.stringify([...seen, ...fresh.map(o => o.id)].slice(-200)));
  } catch { /* storage unavailable */ }
  flushPendingPurchases();
}

// ==========================================
// Popup targeting + frequency cap
// ==========================================

/** "/courses" matches exactly; "/blog/*" matches the prefix. An empty list matches every page. */
export function pageMatches(pages: string[], pathname: string): boolean {
  if (!pages.length) return true;
  const path = pathname.replace(/\/+$/, "") || "/";
  return pages.some(p => p.endsWith("*") ? path.startsWith(p.slice(0, -1).replace(/\/+$/, "")) : (p.replace(/\/+$/, "") || "/") === path);
}

const popupKey = (id: string) => `netprime_popup_${id}`;

export function popupAllowed(form: PublicLeadForm): boolean {
  const popup = form.popup;
  if (!popup?.enabled) return false;
  try {
    const raw = localStorage.getItem(popupKey(form.id));
    if (raw === "done") return false;
    if (popup.frequency_days === 0) return sessionStorage.getItem(popupKey(form.id)) !== "shown";
    const last = Number(raw);
    return !last || Date.now() - last > popup.frequency_days * 86400_000;
  } catch { return true; }
}

export function markPopup(form: PublicLeadForm, state: "shown" | "done") {
  try {
    if (state === "done") localStorage.setItem(popupKey(form.id), "done");
    else {
      localStorage.setItem(popupKey(form.id), String(Date.now()));
      sessionStorage.setItem(popupKey(form.id), "shown");
    }
  } catch { /* storage unavailable */ }
}
