import { useEffect, useRef } from "react";
import { useApi } from "./useApi";

/** What the user has open, so learning time is credited to that course/lesson. */
export interface PresenceContext {
  courseId?: string | null;
  lessonId?: string | null;
}

const INTERVAL_MS = 60_000;

/**
 * Sends POST /api/me/heartbeat every 60 s while the tab is visible and the user is signed in.
 * The server credits at most 60 s per beat (never more than the time since the previous beat),
 * powering "online users" and learning time. Call once near the top of the console (App.tsx);
 * pass the current course/lesson when known.
 */
export function usePresenceHeartbeat(context?: PresenceContext) {
  const api = useApi();
  const contextRef = useRef<PresenceContext | undefined>(context);
  contextRef.current = context;
  const requestRef = useRef(api.request);
  requestRef.current = api.request;
  const visibleSince = useRef<number | null>(null);

  useEffect(() => {
    if (!api.token) return;
    let stopped = false;

    const beat = () => {
      if (stopped || document.visibilityState !== "visible") return;
      const now = Date.now();
      const seconds = visibleSince.current ? Math.min(60, Math.round((now - visibleSince.current) / 1000)) : 0;
      visibleSince.current = now;
      const ctx = contextRef.current;
      requestRef.current("/me/heartbeat", {
        method: "POST",
        body: JSON.stringify({ seconds, course_id: ctx?.courseId || undefined, lesson_id: ctx?.lessonId || undefined })
      }).catch(() => { /* Presence is best-effort. */ });
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Time while hidden does not count; the next beat starts measuring from now.
        visibleSince.current = Date.now();
        beat();
      } else {
        visibleSince.current = null;
      }
    };

    visibleSince.current = document.visibilityState === "visible" ? Date.now() : null;
    beat();
    const timer = window.setInterval(beat, INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [api.token]);

  // Report a course/lesson change right away so presence shows what is open.
  useEffect(() => {
    if (!api.token || document.visibilityState !== "visible" || !context?.courseId) return;
    const now = Date.now();
    const seconds = visibleSince.current ? Math.min(60, Math.round((now - visibleSince.current) / 1000)) : 0;
    visibleSince.current = now;
    requestRef.current("/me/heartbeat", {
      method: "POST",
      body: JSON.stringify({ seconds, course_id: context.courseId, lesson_id: context.lessonId || undefined })
    }).catch(() => { /* Presence is best-effort. */ });
  }, [api.token, context?.courseId, context?.lessonId]);
}
