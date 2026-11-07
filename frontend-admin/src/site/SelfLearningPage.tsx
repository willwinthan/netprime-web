import React, { useEffect, useRef, useState } from "react";
import { localized, useI18n } from "../i18n";
import type { MessageKey } from "../i18n";
import { publicGet } from "../components/site/PublicSections";
import { Link, usePageMeta } from "./router";
import { ArrowIcon } from "./shared";

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

/** syncUrl keeps the lesson's position in the address bar, so a link opens that spot. */
export const LessonFrame: React.FC<{ src: string; title: string; shareUrl: string; syncUrl?: boolean }> = ({ src, title, shareUrl, syncUrl = false }) => {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(900);
  const [initialSrc] = useState(() => `${src}${syncUrl ? window.location.hash : ""}`);
  const origin = new URL(src, window.location.href).origin;

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== origin) return;
      const type = messageType(e.data);
      if (type === "height" && Number.isFinite(e.data.height)) setHeight(Math.max(600, e.data.height));
      if (syncUrl && type === "location" && typeof e.data.hash === "string" && /^[a-z0-9-]+(\/\d+)?$/.test(e.data.hash)) {
        window.history.replaceState(window.history.state, "", `#${e.data.hash}`);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [syncUrl, origin]);

  // The lesson's share button should give out the site's page, not the bare file.
  const onLoad = () => {
    for (const prefix of PREFIXES) frame.current?.contentWindow?.postMessage({ type: `${prefix}parent`, url: shareUrl }, origin);
  };

  // allow-same-origin applies to the lesson's own origin (never the site's), so its storage works;
  // without allow-top-navigation it cannot move the site away.
  return <iframe ref={frame} src={initialSrc} title={title} onLoad={onLoad} allow="fullscreen; clipboard-write"
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

const LessonCardBody: React.FC<{ lesson: PublicLesson }> = ({ lesson }) => {
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
      </span>
    </>
  );
};

const LessonGrid: React.FC<{ lessons: PublicLesson[] | null; error: string | null; onOpen?: (lesson: PublicLesson) => void }> = ({ lessons, error, onOpen }) => {
  const { t } = useI18n();
  if (error) return <p role="alert" style={{ color: "#b42318" }}>{error}</p>;
  if (!lessons) return <p className="ps-muted">{t("selfLearning.loading")}</p>;
  if (!lessons.length) return <div className="ps-card ps-empty">{t("selfLearning.empty")}</div>;
  return (
    <div className="ps-grid">
      {lessons.map(lesson => onOpen ? (
        <button key={lesson.slug} type="button" className="ps-card ps-article-card" onClick={() => onOpen(lesson)}
          style={{ font: "inherit", textAlign: "left", cursor: "pointer", padding: 0, color: "var(--ps-ink)" }}>
          <LessonCardBody lesson={lesson} />
        </button>
      ) : (
        <Link key={lesson.slug} to={`/self-learning/${lesson.slug}`} className="ps-card ps-article-card"><LessonCardBody lesson={lesson} /></Link>
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
          <LessonFrame key={lesson.content_url} src={lesson.content_url} title={title} syncUrl
            shareUrl={`${window.location.origin}/self-learning/${lesson.slug}`} />
        )}
      </div>
    </>
  );
};

/** Console tab for learners: the same lessons, opened inside the console. */
export const SelfLearningLibrary: React.FC = () => {
  const { t, lang } = useI18n();
  const { lessons, error } = useLessons();
  const [open, setOpen] = useState<PublicLesson | null>(null);
  const [detail, setDetail] = useState<PublicLesson | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    if (open) publicGet<{ lesson: PublicLesson }>(`/self-learning/${encodeURIComponent(open.slug)}`).then(d => setDetail(d.lesson)).catch(err => setDetailError(err.message));
  }, [open?.slug]);
  // A single lesson opens straight away, as the tab did before there were several.
  useEffect(() => { if (lessons?.length === 1) setOpen(lessons[0]); }, [lessons]);

  return (
    <div className="ps" style={{ background: "transparent" }}>
      {open ? (
        <>
          {lessons && lessons.length > 1 && (
            <button type="button" className="ps-btn ps-btn-ghost" onClick={() => setOpen(null)} style={{ marginBottom: 12 }}>
              <span style={{ display: "inline-flex", transform: "scaleX(-1)" }}><ArrowIcon size={16} /></span> {t("selfLearning.all")}
            </button>
          )}
          {detailError && <p role="alert" style={{ color: "#b42318" }}>{detailError}</p>}
          {detail?.content_url && <LessonFrame key={detail.content_url} src={detail.content_url} title={localized(lang, detail.title, detail.title_en)}
            shareUrl={`${window.location.origin}/self-learning/${detail.slug}`} />}
        </>
      ) : <LessonGrid lessons={lessons} error={error} onOpen={setOpen} />}
    </div>
  );
};
