import { useSyncExternalStore } from "react";

/**
 * Live preview of the public site inside the website builder (components/builder/SitePreview.tsx).
 *
 * The builder loads the real site in an iframe at `/?np-preview=1` (same origin) and posts unsaved
 * edits to it. Here, inside the iframe, those edits override what the hooks fetched (usePublicSite,
 * useSiteNav, the theme), nothing is saved, links do not navigate, and parts of the page marked with
 * data-np-section can be highlighted and clicked to open their form in the builder.
 *
 * Messages are accepted only from the parent window on the same origin.
 */

export type PreviewSection =
  | "announcement" | "nav" | "hero" | "promotion" | "brands" | "services" | "faq" | "contact" | "footer" | "legal";

export interface PreviewDraft {
  home?: unknown;
  settings?: Record<string, unknown>;
  nav?: { header: unknown[]; footer: unknown[] };
  theme?: unknown;
}

export type PreviewMessage =
  | { type: "np-preview:draft"; draft: PreviewDraft }
  | { type: "np-preview:focus"; section: PreviewSection | null }
  | { type: "np-preview:ready" }
  | { type: "np-preview:select"; section: PreviewSection };

export const IN_PREVIEW = typeof window !== "undefined" && window.parent !== window
  && new URLSearchParams(window.location.search).has("np-preview");

let draft: PreviewDraft = {};
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Unsaved builder edits (always empty outside the preview). */
export function usePreviewDraft(): PreviewDraft {
  return useSyncExternalStore(subscribe, () => draft);
}

/** Called by the theme module so a draft theme is applied without being cached for the real site. */
let themeHandler: ((theme: unknown) => void) | null = null;
export function onPreviewTheme(handler: (theme: unknown) => void) { themeHandler = handler; if (draft.theme) handler(draft.theme); }

let started = false;

/** Mount once in the app shell. Does nothing outside the builder's preview iframe. */
export function startPreviewBridge() {
  if (!IN_PREVIEW || started) return;
  started = true;
  const post = (message: PreviewMessage) => window.parent.postMessage(message, window.location.origin);

  window.addEventListener("message", event => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    const message = event.data as PreviewMessage;
    if (message?.type === "np-preview:draft") {
      draft = message.draft ?? {};
      listeners.forEach(l => l());
      if (draft.theme) themeHandler?.(draft.theme);
    } else if (message?.type === "np-preview:focus") {
      focusSection(message.section);
    }
  });

  // Clicking the page selects the section to edit; links, buttons and forms do nothing in the preview.
  document.addEventListener("click", event => {
    const target = event.target as Element | null;
    if (!target) return;
    const section = target.closest<HTMLElement>("[data-np-section]");
    if (target.closest("a, button, summary, input, select, textarea, label") || section) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (section) post({ type: "np-preview:select", section: section.dataset.npSection as PreviewSection });
  }, true);
  document.addEventListener("submit", event => event.preventDefault(), true);

  const style = document.createElement("style");
  style.textContent = `
    [data-np-section] { cursor: pointer; outline: 2px dashed transparent; outline-offset: -2px; transition: outline-color .15s; }
    [data-np-section]:hover { outline-color: rgba(194, 84, 26, .45); }
    [data-np-section].np-preview-active { outline: 3px solid #c2541a; }
  `;
  document.head.appendChild(style);
  post({ type: "np-preview:ready" });
}

let active: PreviewSection | null = null;

function focusSection(section: PreviewSection | null) {
  active = section;
  document.querySelectorAll(".np-preview-active").forEach(el => el.classList.remove("np-preview-active"));
  if (!section) return;
  const apply = (tries: number) => {
    if (active !== section) return;
    const el = document.querySelector<HTMLElement>(`[data-np-section="${section}"]`);
    // The section may not be rendered yet (data loading, or empty until the draft fills it).
    if (!el) { if (tries > 0) window.setTimeout(() => apply(tries - 1), 150); return; }
    el.classList.add("np-preview-active");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  apply(10);
}
