import React, { useEffect, useRef, useState } from "react";
import { localized, useI18n } from "../i18n";
import type { MessageKey } from "../i18n";
import { publicGet } from "../components/site/PublicSections";
import { Theme, fontHref, themeVars, useTheme } from "../components/builder/theme";
import { useApi } from "../hooks/useApi";
import { Link, usePageMeta } from "./router";

// Self-learning lessons are self-contained HTML files uploaded by staff (backend handlers/selfLearning.ts).
// Each file runs its own scripts, so it is served from another origin and embedded in a sandboxed iframe;
// it reports its height and current position by postMessage and keeps progress in its own storage.

export interface PublicLesson {
  slug: string; title: string; title_en: string | null; summary: string | null; summary_en: string | null;
  cover_url: string | null; level: "beginner" | "intermediate" | "advanced" | null;
  published_at: string | null; updated_at: string; content_url?: string;
}

/** Message types a lesson may send; "protocol-explorer:" is the prefix of the first lesson (Basic Network). */
const PREFIXES = ["netprime-lesson:", "protocol-explorer:"];
const messageType = (data: unknown): string | null => {
  const type = (data as { type?: unknown } | null)?.type;
  if (typeof type !== "string") return null;
  const prefix = PREFIXES.find(p => type.startsWith(p));
  return prefix ? type.slice(prefix.length) : null;
};

export const levelKey = (level: PublicLesson["level"]): MessageKey | null => level ? `selfLearning.level.${level}` as MessageKey : null;

/** Site theme as the Lesson Kit receives it: the --np-* variables and the font stylesheet. */
function lessonTheme(theme: Theme, custom: boolean) {
  const vars = Object.fromEntries(Object.entries(themeVars(theme)).filter(([name]) => name.startsWith("--np-")));
  return { vars, font: theme.font, fontHref: fontHref(theme.font), custom };
}

/**
 * One lesson in a sandboxed iframe. It speaks the Lesson Kit protocol (docs/SELF-LEARNING-LESSON-KIT.md):
 * the lesson sends ready / height / location / progress, the site answers with theme, parent (share URL)
 * and restore (the signed-in learner's saved progress). `slug` turns progress saving on; previews omit it.
 * syncUrl keeps the lesson's position in the address bar, so a link opens that spot.
 */
export const LessonFrame: React.FC<{
  src: string; title: string; shareUrl: string; slug?: string; syncUrl?: boolean;
  /** Called after the saved progress is stored (signed-in learners only), e.g. to refresh course progress. */
  onSaved?: (saved: { completed: boolean; completedInCourses: number }) => void;
}> = ({ src, title, shareUrl, slug, syncUrl = false, onSaved }) => {
  const api = useApi();
  const { theme, custom } = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(900);
  const [initialSrc] = useState(() => `${src}${syncUrl ? window.location.hash : ""}`);
  const origin = new URL(src, window.location.href).origin;
  // Saved progress: undefined while loading, null when there is none or nobody is signed in.
  const saved = useRef<{ state: unknown; percent: number } | null | undefined>(undefined);
  const restoreSent = useRef(false);
  const signedIn = !!api.token && !!slug;

  const post = (type: string, data: Record<string, unknown>) => {
    for (const prefix of PREFIXES) frame.current?.contentWindow?.postMessage({ ...data, type: `${prefix}${type}` }, origin);
  };
  const sendRestore = () => {
    if (restoreSent.current || saved.current === undefined) return;
    restoreSent.current = true;
    post("restore", { signedIn, state: saved.current?.state ?? null, percent: saved.current?.percent ?? 0 });
  };
  // The site's share page, theme and saved progress; sent on load and when the lesson says it is ready.
  // Restore goes once per load of the frame, but a lesson may still see it twice and must apply it idempotently.
  const greet = () => {
    post("parent", { url: shareUrl });
    post("theme", { theme: lessonTheme(theme, custom) });
    sendRestore();
  };

  useEffect(() => {
    saved.current = signedIn ? undefined : null;
    restoreSent.current = false;
    if (!signedIn) return;
    api.get<{ progress: { state: unknown; percent: number } | null }>(`/me/self-learning/${encodeURIComponent(slug!)}`)
      .then(d => { saved.current = d.progress; }).catch(() => { saved.current = null; })
      .finally(sendRestore);
  }, [signedIn, slug]);

  useEffect(() => { post("theme", { theme: lessonTheme(theme, custom) }); }, [theme, custom]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== origin) return;
      const type = messageType(e.data);
      if (type === "ready") greet();
      if (type === "height" && Number.isFinite(e.data.height)) setHeight(Math.max(600, e.data.height));
      if (syncUrl && type === "location" && typeof e.data.hash === "string" && /^[a-z0-9-]+(\/\d+)?$/.test(e.data.hash)) {
        window.history.replaceState(window.history.state, "", `#${e.data.hash}`);
      }
      if (type === "progress" && signedIn && Number.isFinite(e.data.percent)) {
        const completed = e.data.completed === true;
        api.request<{ completed_in_courses?: number }>(`/me/self-learning/${encodeURIComponent(slug!)}`, {
          method: "PUT", body: JSON.stringify({ percent: e.data.percent, completed, state: e.data.state ?? null })
        }).then(res => onSaved?.({ completed, completedInCourses: res.completed_in_courses ?? 0 })).catch(() => undefined);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  // allow-same-origin applies to the lesson's own origin (never the site's), so its storage works;
  // without allow-top-navigation it cannot move the site away.
  return <iframe ref={frame} src={initialSrc} title={title} onLoad={() => { restoreSent.current = false; greet(); }} allow="fullscreen; clipboard-write"
    sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
    style={{ display: "block", width: "100%", height, border: "none" }} />;
};

export function useLessons(): { lessons: PublicLesson[] | null; error: string | null } {
  const [lessons, setLessons] = useState<PublicLesson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    publicGet<{ lessons: PublicLesson[] }>("/self-learning").then(d => setLessons(d.lessons)).catch(err => setError(err.message));
  }, []);
  return { lessons, error };
}

type MyProgress = Record<string, { percent: number; completed_at: string | null }>;

/** The signed-in learner's progress per lesson slug; empty when signed out. */
function useMyProgress(): MyProgress {
  const api = useApi();
  const [progress, setProgress] = useState<MyProgress>({});
  useEffect(() => {
    if (!api.token) { setProgress({}); return; }
    api.get<{ progress: Array<{ slug: string; percent: number; completed_at: string | null }> }>("/me/self-learning")
      .then(d => setProgress(Object.fromEntries(d.progress.map(p => [p.slug, p])))).catch(() => undefined);
  }, [api.token]);
  return progress;
}

const LessonCardBody: React.FC<{ lesson: PublicLesson; progress?: MyProgress[string] }> = ({ lesson, progress }) => {
  const { t, lang } = useI18n();
  const level = levelKey(lesson.level);
  return (
    <>
      <div className="ps-cover" style={{ background: "#e7f0ff", color: "#1d4ea8" }}>
        {lesson.cover_url ? <img src={lesson.cover_url} alt="" loading="lazy" /> : "Self-learning"}
      </div>
      <span className="ps-article-body">
        {level && <span className="ps-meta">{t(level)}</span>}
        <strong>{localized(lang, lesson.title, lesson.title_en)}</strong>
        {lesson.summary && <span className="ps-muted" style={{ fontSize: 15 }}>{localized(lang, lesson.summary, lesson.summary_en)}</span>}
        {progress && (
          <span style={{ display: "grid", gap: 4, marginTop: 4 }}>
            <span className="ps-meta">{progress.completed_at ? t("selfLearning.completed") : t("selfLearning.progress", { percent: progress.percent })}</span>
            <span aria-hidden style={{ height: 6, borderRadius: 3, background: "var(--ps-line)", overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", width: `${progress.completed_at ? 100 : progress.percent}%`, background: "var(--ps-brand-strong)" }} />
            </span>
          </span>
        )}
      </span>
    </>
  );
};

const LessonGrid: React.FC<{ lessons: PublicLesson[] | null; error: string | null }> = ({ lessons, error }) => {
  const { t } = useI18n();
  const progress = useMyProgress();
  if (error) return <p role="alert" style={{ color: "#b42318" }}>{error}</p>;
  if (!lessons) return <p className="ps-muted">{t("selfLearning.loading")}</p>;
  if (!lessons.length) return <div className="ps-card ps-empty">{t("selfLearning.empty")}</div>;
  return (
    <div className="ps-grid">
      {lessons.map(lesson => (
        <Link key={lesson.slug} to={`/self-learning/${lesson.slug}`} className="ps-card ps-article-card"><LessonCardBody lesson={lesson} progress={progress[lesson.slug]} /></Link>
      ))}
    </div>
  );
};

const PageHead: React.FC<{ kicker: string; title: string; lead?: string | null; back?: React.ReactNode }> = ({ kicker, title, lead, back }) => (
  <section className="ps-page-head">
    <div className="ps-container ps-page-head-inner">
      <div>
        {back}
        <span className="ps-kicker">{kicker}</span>
        <h1>{title}</h1>
        {lead && <p className="ps-lead" style={{ marginTop: 8, fontSize: 17 }}>{lead}</p>}
      </div>
    </div>
  </section>
);

/** /self-learning — every published lesson. */
export const SelfLearningPage: React.FC = () => {
  const { t } = useI18n();
  usePageMeta(t("nav.selfLearning"), t("selfLearning.lead"));
  const { lessons, error } = useLessons();
  return (
    <>
      <PageHead kicker={t("nav.selfLearning")} title={t("selfLearning.title")} lead={t("selfLearning.lead")} />
      <div className="ps-container" style={{ paddingTop: 24, paddingBottom: 48 }}>
        <LessonGrid lessons={lessons} error={error} />
      </div>
    </>
  );
};

/** /self-learning/:slug — one lesson inside the site's header and footer. */
export const SelfLearningLessonPage: React.FC<{ slug: string }> = ({ slug }) => {
  const { t, lang } = useI18n();
  const [lesson, setLesson] = useState<PublicLesson | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    publicGet<{ lesson: PublicLesson }>(`/self-learning/${encodeURIComponent(slug)}`).then(d => setLesson(d.lesson)).catch(err => setError(err.message));
  }, [slug]);
  const title = lesson ? localized(lang, lesson.title, lesson.title_en) : t("nav.selfLearning");
  const summary = lesson?.summary ? localized(lang, lesson.summary, lesson.summary_en) : null;
  usePageMeta(title, summary || t("selfLearning.lead"));
  const back = <Link to="/self-learning" className="ps-muted" style={{ display: "inline-block", marginBottom: 8, fontSize: 14 }}>← {t("selfLearning.back")}</Link>;
  return (
    <>
      <PageHead kicker={t("nav.selfLearning")} title={title} lead={summary} back={back} />
      <div className="ps-container" style={{ paddingTop: 24, paddingBottom: 48 }}>
        {error && <div className="ps-card ps-empty">{error}<div style={{ marginTop: 12 }}><Link to="/self-learning" className="ps-btn ps-btn-ghost">{t("selfLearning.all")}</Link></div></div>}
        {!lesson && !error && <p className="ps-muted">{t("selfLearning.loading")}</p>}
        {lesson?.content_url && (
          <LessonFrame key={lesson.content_url} src={lesson.content_url} title={title} slug={lesson.slug} syncUrl
            shareUrl={`${window.location.origin}/self-learning/${lesson.slug}`} />
        )}
      </div>
    </>
  );
};
