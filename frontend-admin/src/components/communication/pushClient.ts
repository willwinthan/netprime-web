/**
 * Browser side of Web Push. Uses the page's existing service worker registration (the PWA sw.js, which should
 * `importScripts("/push-handler.js")`); when none exists, registers /push-handler.js on its own.
 */

export const pushSupported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + "===".slice((base64.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, ch => ch.charCodeAt(0));
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  await navigator.serviceWorker.register("/push-handler.js");
  return navigator.serviceWorker.ready;
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Asks for permission and returns the subscription JSON to POST to /push/subscriptions. */
export async function subscribeToPush(publicKey: string): Promise<PushSubscriptionJSON> {
  if (!pushSupported()) throw new Error("เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("ยังไม่ได้อนุญาตการแจ้งเตือนในเบราว์เซอร์");
  const reg = await registration();
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource });
  return sub.toJSON();
}

export async function unsubscribeFromPush(): Promise<string | null> {
  const sub = await currentPushSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}
