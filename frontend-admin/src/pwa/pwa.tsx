import React, { useEffect, useSyncExternalStore } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import { translate, useI18n } from "../i18n";

/**
 * PWA support: service worker registration (public/sw.js), the install prompt and the update flow.
 * - The worker URL carries the build's entry-script name (/sw.js?v=index-abc123.js), so every deploy
 *   registers a new worker version even though sw.js itself is a static file.
 * - A new version waits until the user clicks "มีเวอร์ชันใหม่ — รีโหลด"; it then takes over and the page reloads.
 * - Registration runs only in production builds (dev servers must not be cached).
 */

interface PwaState { installEvent: BeforeInstallPromptEvent | null; installed: boolean; waiting: ServiceWorker | null; offline: boolean; dismissed: boolean }
interface BeforeInstallPromptEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }

let state: PwaState = {
  installEvent: null, installed: false, waiting: null,
  offline: typeof navigator !== "undefined" && navigator.onLine === false, dismissed: false
};
const listeners = new Set<() => void>();
const update = (patch: Partial<PwaState>) => { state = { ...state, ...patch }; listeners.forEach(l => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function usePwa() {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  return {
    ...snapshot,
    canInstall: !!snapshot.installEvent && !snapshot.installed,
    install: async () => {
      const event = snapshot.installEvent;
      if (!event) return;
      await event.prompt();
      const choice = await event.userChoice.catch(() => null);
      update({ installEvent: null, installed: choice?.outcome === "accepted" });
    },
    applyUpdate: () => {
      if (!snapshot.waiting) { window.location.reload(); return; }
      snapshot.waiting.postMessage({ type: "SKIP_WAITING" });
    },
    dismissUpdate: () => update({ dismissed: true })
  };
}

let started = false;

/** Version tag from the hashed entry script, e.g. "index-B2x9c.js"; "dev" when unbuilt. */
function buildVersion(): string {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  const name = script?.src.split("/").pop() || "dev";
  return name.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) || "dev";
}

export function startPwa() {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); update({ installEvent: event as BeforeInstallPromptEvent }); });
  window.addEventListener("appinstalled", () => update({ installEvent: null, installed: true }));
  window.addEventListener("online", () => update({ offline: false }));
  window.addEventListener("offline", () => update({ offline: true }));
  if (window.matchMedia?.("(display-mode: standalone)").matches) update({ installed: true });

  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  const register = () => navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(buildVersion())}`, { scope: "/" }).then(registration => {
    const track = (worker: ServiceWorker | null) => {
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        // "installed" with an existing controller = an update is ready (first installs need no prompt).
        if (worker.state === "installed" && navigator.serviceWorker.controller) update({ waiting: worker, dismissed: false });
      });
    };
    if (registration.waiting && navigator.serviceWorker.controller) update({ waiting: registration.waiting });
    track(registration.installing);
    registration.addEventListener("updatefound", () => track(registration.installing));
    // Long-lived tabs (the console) check for a new version every hour.
    window.setInterval(() => registration.update().catch(() => undefined), 60 * 60 * 1000);
  }).catch(error => console.warn("Service worker registration failed:", error));
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

/** "ติดตั้งแอป" button; renders nothing when the browser offers no install prompt. */
export const InstallAppButton: React.FC<{ className?: string; style?: React.CSSProperties; label?: string }> = ({ className, style, label }) => {
  const pwa = usePwa();
  const { t } = useI18n();
  useEffect(() => { startPwa(); }, []);
  if (!pwa.canInstall) return null;
  return (
    <button type="button" className={className ?? "tech-button-outline"} style={style} onClick={() => { pwa.install(); }} title={t("pwa.installHint")}>
      <Download size={16} aria-hidden="true" />{label ?? t("pwa.install")}
    </button>
  );
};

/** Bottom toast for a waiting update; mounted globally by src/pwa/boot.tsx. */
export const PwaUpdateBanner: React.FC = () => {
  const pwa = usePwa();
  useEffect(() => { startPwa(); }, []);
  // The banner lives outside both apps; the console is Thai, the public site follows the chosen language.
  const lang = window.location.pathname.startsWith("/dashboard") ? "th" : undefined;
  const { t: tr } = useI18n();
  const t = (key: Parameters<typeof tr>[0]) => lang ? translate(lang, key) : tr(key);
  if (!pwa.waiting || pwa.dismissed) return null;
  return (
    <div role="status" style={{
      position: "fixed", left: "50%", bottom: 20, transform: "translateX(-50%)", zIndex: 10000, display: "flex", alignItems: "center", gap: 10,
      padding: "8px", borderRadius: 14, background: "#182443", color: "#ffffff", boxShadow: "0 12px 30px rgba(0,0,0,0.25)",
      fontFamily: "'Anuphan', system-ui, sans-serif", fontSize: 14, maxWidth: "calc(100vw - 32px)"
    }}>
      <button type="button" onClick={pwa.applyUpdate} style={{ display: "inline-flex", alignItems: "center", gap: 8, minHeight: 36, padding: "0 14px", border: 0, borderRadius: 10, background: "#ffffff", color: "#182443", fontWeight: 700, cursor: "pointer", font: "inherit" }}>
        <RefreshCw size={14} aria-hidden="true" />{t("pwa.update")}
      </button>
      <button type="button" onClick={pwa.dismissUpdate} aria-label={t("pwa.updateLater")} style={{ display: "inline-flex", minHeight: 36, minWidth: 36, alignItems: "center", justifyContent: "center", border: 0, borderRadius: 10, background: "transparent", color: "#d7deec", cursor: "pointer" }}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
};
