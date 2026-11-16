/** Selects the only origin allowed to receive bearer signed-file URLs. */
const canonical = (value: string, protocol: "https:" | "http:", loopbackOnly: boolean): string | null => {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const normalized = raw.replace(/\/+$/, "");
    if (url.protocol !== protocol || url.username || url.password || url.origin !== normalized) return null;
    if (loopbackOnly && !["127.0.0.1", "localhost"].includes(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
};

/**
 * Production requires an explicitly configured HTTPS origin. Local disposable tests may instead
 * use an HTTP loopback request/forwarded origin; no other request Host is trusted.
 */
export function canonicalApiOrigin(configured: string | undefined, allowLocal: boolean,
  requestOrigin: string, forwardedOrigin?: string): string | null {
  if (configured?.trim()) return canonical(configured, "https:", false);
  if (!allowLocal) return null;
  return (forwardedOrigin ? canonical(forwardedOrigin, "http:", true) : null) || canonical(requestOrigin, "http:", true);
}
