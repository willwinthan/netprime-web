import React, { useEffect, useSyncExternalStore } from "react";

// Minimal client-side router for the public website. The app has no router library;
// Workers static assets and Vite both serve index.html for unknown paths (SPA fallback).
const NAVIGATE_EVENT = "netprime-navigate";

function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(NAVIGATE_EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(NAVIGATE_EVENT, listener);
  };
}

const snapshot = () => window.location.pathname + window.location.search + window.location.hash;

/** Current location; components using it re-render on every navigation. */
export function useLocation(): URL {
  const href = useSyncExternalStore(subscribe, snapshot);
  return new URL(href, window.location.origin);
}

function scrollToHash(hash: string, smooth: boolean) {
  const target = document.getElementById(decodeURIComponent(hash.slice(1)));
  target?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
}

export function navigate(to: string, options: { replace?: boolean } = {}) {
  const url = new URL(to, window.location.href);
  if (url.origin !== window.location.origin) {
    window.location.assign(url.href);
    return;
  }
  const samePage = url.pathname === window.location.pathname && url.search === window.location.search;
  const next = url.pathname + url.search + url.hash;
  if (options.replace) window.history.replaceState({}, "", next);
  else window.history.pushState({}, "", next);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
  // Wait for the new page to render before scrolling.
  window.setTimeout(() => {
    if (url.hash) scrollToHash(url.hash, samePage);
    else if (!samePage) window.scrollTo(0, 0);
  }, 30);
}

type LinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

/** In-app link: plain clicks navigate without a reload; modified clicks open normally. */
export const Link: React.FC<LinkProps> = ({ to, onClick, children, ...rest }) => (
  <a
    href={to}
    {...rest}
    onClick={event => {
      onClick?.(event);
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || rest.target === "_blank") return;
      if (new URL(to, window.location.href).origin !== window.location.origin) return;
      event.preventDefault();
      navigate(to);
    }}
  >
    {children}
  </a>
);

/** Scrolls to the URL hash once on first render (e.g. a shared link to /#contact). */
export function useInitialHashScroll() {
  useEffect(() => {
    if (window.location.hash) window.setTimeout(() => scrollToHash(window.location.hash, false), 300);
  }, []);
}

const DEFAULT_TITLE = "NetPrime LMS — ระบบเรียนออนไลน์และอบรมด้าน IT";

function setMeta(attr: "name" | "property", key: string, value: string) {
  let tag = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute(attr, key);
    document.head.appendChild(tag);
  }
  tag.content = value;
}

/**
 * Page title and description for browsers and search engines that run JavaScript.
 * Link previews in LINE/Facebook need server-side tags (see docs/PUBLIC-SITE.md).
 */
export function usePageMeta(title: string | null, description?: string | null) {
  useEffect(() => {
    const fullTitle = title ? `${title} | NetPrime` : DEFAULT_TITLE;
    document.title = fullTitle;
    setMeta("property", "og:title", fullTitle);
    if (description) {
      setMeta("name", "description", description);
      setMeta("property", "og:description", description);
    }
  }, [title, description]);
}
