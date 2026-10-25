/**
 * Which permission opens each tab of the multi-tab console pages. Kept apart from the pages so the
 * sidebar (App.tsx) can decide visibility without pulling the lazily loaded pages into the main bundle.
 */
export const TRAINING_TABS = {
  overview: "site.dashboard", sessions: "site.sessions", inquiries: "site.inquiries"
} as const;

export const WEBSITE_TABS = {
  home: "site.settings", pages: "website.design", nav: "website.design", theme: "website.design",
  promotions: "site.promotions", settings: "site.settings"
} as const;

export const CERTIFICATE_TABS = { issued: "certificates.manage", templates: "website.design" } as const;

const unique = (map: Record<string, string>) => Array.from(new Set(Object.values(map)));
/** Any of these shows the page in the sidebar. */
export const TRAINING_PERMISSIONS = unique(TRAINING_TABS);
export const WEBSITE_PERMISSIONS = unique(WEBSITE_TABS);
export const CERTIFICATE_PERMISSIONS = unique(CERTIFICATE_TABS);
