import { useEffect, useState } from "react";
import { API_BASE_URL } from "../../hooks/useApi";
import type { Lang } from "../../i18n";

/** Header/footer menus from the website builder (/api/public/website/nav), fetched once per page load. */
export interface NavItem { label: string; label_en: string | null; href: string; new_tab: boolean }
export interface NavPage { slug: string; path: string; title: string; title_en: string | null; show_in_nav: boolean; show_in_footer: boolean }
export interface SiteNav { nav: { header: NavItem[]; footer: NavItem[] }; pages: NavPage[] }

let navPromise: Promise<SiteNav> | null = null;
const listeners = new Set<(nav: SiteNav) => void>();

function fetchNav(): Promise<SiteNav> {
  navPromise ??= fetch(`${API_BASE_URL}/public/website/nav`)
    .then(res => res.ok ? res.json() as Promise<SiteNav> : Promise.reject(new Error(String(res.status))))
    .catch(error => { navPromise = null; throw error; });
  return navPromise;
}

/** Re-fetch after the builder saves menus or pages. */
export function refreshSiteNav() {
  navPromise = null;
  fetchNav().then(nav => listeners.forEach(l => l(nav))).catch(() => undefined);
}

/** null while loading or when the API is unreachable: callers keep their built-in menu. */
export function useSiteNav(): SiteNav | null {
  const [nav, setNav] = useState<SiteNav | null>(null);
  useEffect(() => {
    let alive = true;
    fetchNav().then(n => { if (alive) setNav(n); }).catch(() => undefined);
    listeners.add(setNav);
    return () => { alive = false; listeners.delete(setNav); };
  }, []);
  return nav;
}

export interface MenuLink { to: string; label: string; newTab: boolean }

/** Menu items in the active language: configured items first, then pages flagged for that menu. */
export function menuLinks(nav: SiteNav | null, where: "header" | "footer", lang: Lang): MenuLink[] | null {
  if (!nav) return null;
  const items = nav.nav[where].map(i => ({ to: i.href, label: lang === "en" && i.label_en ? i.label_en : i.label, newTab: i.new_tab }));
  const pages = nav.pages.filter(p => where === "header" ? p.show_in_nav : p.show_in_footer)
    .filter(p => !items.some(i => i.to === p.path))
    .map(p => ({ to: p.path, label: lang === "en" && p.title_en ? p.title_en : p.title, newTab: false }));
  return [...items, ...pages];
}
