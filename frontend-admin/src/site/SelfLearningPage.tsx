import React, { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { usePageMeta } from "./router";

// The lesson is a self-contained page in public/lessons, built to run inside a parent site: it reports
// its height and current lesson by postMessage and keeps each learner's progress in their browser.
const LESSON_PATH = "/lessons/basic-network.html";
const PAGE_PATH = "/self-learning";

/** syncUrl keeps the current lesson in the address bar, so a link opens that lesson. */
export const LessonFrame: React.FC<{ syncUrl?: boolean }> = ({ syncUrl = false }) => {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(900);
  const [src] = useState(() => `${LESSON_PATH}${syncUrl ? window.location.hash : ""}`);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data) return;
      if (e.data.type === "protocol-explorer:height" && Number.isFinite(e.data.height)) setHeight(Math.max(600, e.data.height));
      if (syncUrl && e.data.type === "protocol-explorer:location" && /^[a-z0-9]+(\/\d+)?$/.test(e.data.hash)) {
        window.history.replaceState(window.history.state, "", `#${e.data.hash}`);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [syncUrl]);

  // The lesson's share button should give out this page, not the bare lesson file.
  const onLoad = () => frame.current?.contentWindow?.postMessage(
    { type: "protocol-explorer:parent", url: `${window.location.origin}${PAGE_PATH}` }, window.location.origin);

  return <iframe ref={frame} src={src} title="Basic Network" onLoad={onLoad} allow="fullscreen; clipboard-write"
    style={{ display: "block", width: "100%", height, border: "none" }} />;
};

export const SelfLearningPage: React.FC = () => {
  const { t } = useI18n();
  usePageMeta(t("nav.selfLearning"), t("selfLearning.lead"));
  return (
    <>
      <section className="ps-page-head">
        <div className="ps-container ps-page-head-inner">
          <div>
            <span className="ps-kicker">{t("nav.selfLearning")}</span>
            <h1>{t("selfLearning.title")}</h1>
            <p className="ps-lead" style={{ marginTop: 8, fontSize: 17 }}>{t("selfLearning.lead")}</p>
          </div>
        </div>
      </section>
      <div className="ps-container" style={{ paddingTop: 24, paddingBottom: 48 }}>
        <LessonFrame syncUrl />
      </div>
    </>
  );
};
