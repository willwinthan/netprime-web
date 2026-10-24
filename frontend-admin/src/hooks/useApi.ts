import { useCallback, useSyncExternalStore } from "react";

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787/api";

export interface User {
  id: string;
  email: string;
  name: string;
  /** Primary (highest) role. */
  role: "student" | "hr" | "partner" | "instructor" | "admin" | "coordinator";
  /** Every role the account holds; one account may be e.g. a coordinator and a student. */
  roles?: User["role"][];
  corporate_id: string | null;
  /** Feature permissions from the server (role permission matrix). */
  permissions?: string[];
  /** False until the address is confirmed from the emailed link (soft: sign-in is never blocked). */
  email_verified?: boolean;
}

/** True when the signed-in user holds any of the given roles (older cached users only have `role`). */
export function hasRole(user: User | null | undefined, ...roles: User["role"][]): boolean {
  if (!user) return false;
  const held = user.roles?.length ? user.roles : [user.role];
  return roles.some(r => held.includes(r));
}

/** True when the signed-in user holds any of the given permissions. */
export function can(user: User | null | undefined, ...permissions: string[]): boolean {
  return !!user?.permissions && permissions.some(p => user.permissions!.includes(p));
}

// All consumers in the same tab and other tabs observe the same auth snapshot.
const AUTH_EVENT = "netprime-auth-change";
function subscribe(listener: () => void) {
  window.addEventListener(AUTH_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(AUTH_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}
function publish(token: string | null, user: User | null) {
  if (token && user) {
    localStorage.setItem("netprime_token", token);
    localStorage.setItem("netprime_user", JSON.stringify(user));
  } else {
    localStorage.removeItem("netprime_token");
    localStorage.removeItem("netprime_user");
  }
  window.dispatchEvent(new Event(AUTH_EVENT));
}

export function useApi() {
  const token = useSyncExternalStore(subscribe, () => localStorage.getItem("netprime_token"));
  const savedUser = useSyncExternalStore(subscribe, () => localStorage.getItem("netprime_user"));
  let user: User | null = null;
  try { user = savedUser ? JSON.parse(savedUser) : null; } catch { /* Invalid cached user will be refreshed. */ }
  const saveAuth = useCallback((newToken: string, newUser: User) => publish(newToken, newUser), []);

  const request = useCallback(async <T,>(endpoint: string, options: RequestInit = {}): Promise<T> => {
    const headers = new Headers(options.headers || {});
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (!(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(`${API_BASE_URL}${endpoint}`, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // A late response from a previous login must not clear a newer session.
      if (response.status === 401 && token && localStorage.getItem("netprime_token") === token) publish(null, null);
      throw new Error(data.error || `คำขอไม่สำเร็จ (${response.status})`);
    }
    return data as T;
  }, [token]);

  const logout = useCallback(async () => {
    // Keep the current session visible on failure so the user can retry revocation.
    if (token) await request("/auth/logout", { method: "POST" });
    if (localStorage.getItem("netprime_token") === token) publish(null, null);
  }, [token, request]);

  const refreshUser = useCallback(async () => {
    if (!token) return;
    const data = await request<{ user: User }>("/auth/me");
    if (localStorage.getItem("netprime_token") === token) publish(token, data.user);
  }, [token, request]);

  return {
    token, user, saveAuth, logout, refreshUser, request,
    get: <T,>(endpoint: string) => request<T>(endpoint, { method: "GET" }),
    post: <T,>(endpoint: string, body: unknown) => request<T>(endpoint, { method: "POST", body: JSON.stringify(body) }),
    patch: <T,>(endpoint: string, body: unknown) => request<T>(endpoint, { method: "PATCH", body: JSON.stringify(body) })
  };
}
