import React, { useEffect, useSyncExternalStore } from "react";
import { API_BASE_URL } from "../../hooks/useApi";

/**
 * Theme & branding (website.design): loaded once from /api/public/website/theme and applied as CSS
 * variables on <html>. The public site reads --np-* through site.css; the console's --color-brand-primary
 * is overridden too, so the header/sidebar buttons follow the brand color. Nothing changes until a
 * theme has been saved (updated_at set), so the built-in look stays the default.
 * The variables are cached in localStorage and re-applied by an inline script in index.html before
 * the app loads, so repeat visits do not flash the default colors.
 */

export const FONTS = ["Anuphan", "IBM Plex Sans Thai", "Noto Sans Thai", "Sarabun", "Prompt", "Kanit"] as const;
export type FontName = typeof FONTS[number];

export interface Theme {
  school_name: string; tagline: string | null; logo_url: string | null; favicon_url: string | null;
  primary_color: string; secondary_color: string; font: FontName; radius: number;
}

export const DEFAULT_THEME: Theme = {
  school_name: "NetPrime", tagline: "ศูนย์ฝึกอบรมด้าน IT", logo_url: null, favicon_url: null,
  primary_color: "#c2541a", secondary_color: "#182443", font: "Anuphan", radius: 14
};

const VARS_KEY = "netprime.theme.vars";
const HEX = /^#[0-9a-f]{6}$/i;

// ---------- Color helpers ----------

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
const toHex = (c: number[]) => "#" + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
/** Mixes `hex` toward `target` by `amount` (0..1). */
export function mix(hex: string, target: string, amount: number): string {
  const a = rgb(hex), b = rgb(target);
  return toHex(a.map((v, i) => v + (b[i] - v) * amount));
}

/** WCAG 2 contrast ratio (same formula as the server check). */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = rgb(hex).map(v => v / 255).map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const isHex = (value: string) => HEX.test(value);

export function fontStack(font: FontName): string {
  return `'${font}', 'Anuphan', 'Inter', system-ui, sans-serif`;
}

/** Google Fonts stylesheet for an allowlisted font (Anuphan is already in index.html). */
export function fontHref(font: FontName): string | null {
  if (font === "Anuphan" || !FONTS.includes(font)) return null;
  return `https://fonts.googleapis.com/css2?family=${font.replace(/ /g, "+")}:wght@400;500;600;700&display=swap`;
}

export function loadFont(font: FontName) {
  const href = fontHref(font);
  if (!href || document.querySelector(`link[data-np-font="${font}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.npFont = font;
  document.head.appendChild(link);
}

/** CSS variables for a theme; used on <html> and on preview containers. */
export function themeVars(theme: Theme): Record<string, string> {
  const primary = isHex(theme.primary_color) ? theme.primary_color : DEFAULT_THEME.primary_color;
  const secondary = isHex(theme.secondary_color) ? theme.secondary_color : DEFAULT_THEME.secondary_color;
  return {
    "--np-primary": primary,
    "--np-primary-dark": mix(primary, "#000000", 0.22),
    "--np-primary-tint": mix(primary, "#ffffff", 0.9),
    "--np-accent": mix(primary, "#ffffff", 0.3),
    "--np-secondary": secondary,
    "--np-radius": `${Math.max(0, Math.min(24, theme.radius))}px`,
    "--np-font": fontStack(theme.font),
    // Console (index.css): --primary is var(--color-brand-primary).
    "--color-brand-primary": primary,
    "--color-brand-primary-glow": `rgba(${rgb(primary).join(", ")}, 0.12)`
  };
}

const safeAsset = (url: string | null) => !!url && ((url.startsWith("/") && !url.startsWith("//")) || /^https?:\/\//.test(url));

function setFavicon(url: string | null) {
  if (!safeAsset(url)) return;
  let link = document.head.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.removeAttribute("type");
  link.href = url!;
}

/** Applies (custom=true) or clears (default theme) the variables on <html>. */
export function applyTheme(theme: Theme, custom: boolean) {
  const root = document.documentElement;
  const vars = themeVars(theme);
  for (const name of Object.keys(vars)) root.style.removeProperty(name);
  if (!custom) {
    try { localStorage.removeItem(VARS_KEY); } catch { /* storage unavailable */ }
    return;
  }
  // The console keeps its own orange until a different primary color is chosen.
  if (theme.primary_color.toLowerCase() === DEFAULT_THEME.primary_color) {
    delete vars["--color-brand-primary"];
    delete vars["--color-brand-primary-glow"];
  }
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  loadFont(theme.font);
  setFavicon(theme.favicon_url);
  try { localStorage.setItem(VARS_KEY, JSON.stringify({ vars, font: fontHref(theme.font) })); } catch { /* storage unavailable */ }
}

// ---------- Shared store ----------

interface ThemeState { theme: Theme; custom: boolean; loaded: boolean }
let state: ThemeState = { theme: DEFAULT_THEME, custom: false, loaded: false };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

function emit(next: ThemeState) {
  state = next;
  listeners.forEach(l => l());
}

export function loadTheme(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = fetch(`${API_BASE_URL}/public/website/theme`)
    .then(res => res.ok ? res.json() : Promise.reject(new Error(String(res.status))))
    .then((data: { theme: Theme; updated_at: string | null }) => {
      const custom = !!data.updated_at;
      applyTheme(data.theme, custom);
      emit({ theme: data.theme, custom, loaded: true });
    })
    .catch(() => { emit({ ...state, loaded: true }); loading = null; });
  return loading;
}

/** Call after saving in the builder so every open view (site chrome, console) updates at once. */
export function publishTheme(theme: Theme) {
  applyTheme(theme, true);
  emit({ theme, custom: true, loaded: true });
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useTheme(): ThemeState {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  useEffect(() => { loadTheme(); }, []);
  return snapshot;
}

/** School name, tagline and logo for headers (logo null = use the bundled logo). */
export function useBranding() {
  const { theme } = useTheme();
  return { name: theme.school_name || DEFAULT_THEME.school_name, tagline: theme.tagline, logo: safeAsset(theme.logo_url) ? theme.logo_url : null };
}

/** Mount once (console or site) to load and apply the theme. Renders nothing. */
export const ThemeBridge: React.FC = () => { useTheme(); return null; };
