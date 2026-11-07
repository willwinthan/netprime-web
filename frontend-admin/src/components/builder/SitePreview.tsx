import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { EyeOff, Monitor, RefreshCw, Smartphone, Tablet } from "lucide-react";
import type { PreviewDraft, PreviewMessage, PreviewSection } from "../../site/preview";
import "./builder.css";

/**
 * Live preview for the website builder: the real public site in an iframe (`?np-preview=1`, see
 * site/preview.ts) that shows unsaved edits as they are typed, highlights the part being edited,
 * and reports clicks so the builder can open that part's form.
 */

export interface BuilderPreview {
  /** False outside the builder (panels then behave as before). */
  active: boolean;
  /** Replace one part of the draft (undefined removes it). */
  setDraft: (patch: PreviewDraft) => void;
  focus: (section: PreviewSection | null) => void;
  /** Page shown in the preview, e.g. "/" or "/privacy". */
  setPath: (path: string) => void;
  /** Reload the preview so it fetches what was just saved. */
  reload: () => void;
  /** Last section clicked in the preview (a new object each click). */
  selected: { section: PreviewSection } | null;
}

const noop = () => undefined;
const PreviewContext = createContext<BuilderPreview>({ active: false, setDraft: noop, focus: noop, setPath: noop, reload: noop, selected: null });
export const useBuilderPreview = () => useContext(PreviewContext);

/**
 * Panel helper: sends `value` as the draft `key` while the panel is open, highlights `section`
 * while one of its fields has focus, and scrolls to the form card of a section clicked in the preview.
 * Cards mark themselves with data-preview-card="<section>".
 */
export function usePreviewSync<K extends keyof PreviewDraft>(key: K, value: PreviewDraft[K] | null | undefined) {
  const preview = useBuilderPreview();
  const { setDraft } = preview;
  useEffect(() => {
    if (!preview.active) return;
    setDraft({ [key]: value ?? undefined } as PreviewDraft);
  }, [preview.active, key, value]);
  useEffect(() => () => setDraft({ [key]: undefined } as PreviewDraft), [key]);
  useEffect(() => {
    if (!preview.selected) return;
    const card = document.querySelector<HTMLElement>(`[data-preview-card="${preview.selected.section}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "start" });
    card.classList.remove("np-wb-flash");
    void card.offsetWidth; // restart the animation
    card.classList.add("np-wb-flash");
  }, [preview.selected]);
}

/** onFocus/onClick props for a form card: highlights its section in the preview. */
export function previewCardProps(preview: BuilderPreview, section: PreviewSection) {
  return {
    "data-preview-card": section,
    onFocusCapture: () => preview.focus(section),
    onMouseDown: () => preview.focus(section)
  };
}

type Device = "desktop" | "tablet" | "mobile";
const DEVICES: Array<[Device, number, string, React.ReactNode]> = [
  ["desktop", 1280, "คอมพิวเตอร์", <Monitor size={15} />],
  ["tablet", 820, "แท็บเล็ต", <Tablet size={15} />],
  ["mobile", 390, "มือถือ", <Smartphone size={15} />]
];
const DEVICE_KEY = "netprime.builder.previewDevice";
const HIDDEN_KEY = "netprime.builder.previewHidden";
const readPref = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const writePref = (key: string, value: string | null) => { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* storage unavailable */ } };

/**
 * Split layout: the panel on the left, the live preview on the right (stacked on narrow screens).
 * `elsewhere` names the tab that edits a section clicked in the preview when it is not the open tab;
 * the preview then offers a button to go there instead of switching (unsaved edits would be lost).
 */
export const PreviewLayout: React.FC<{
  children: React.ReactNode; resetKey: string;
  elsewhere?: (section: PreviewSection) => { label: string; go: () => void } | null;
}> = ({ children, resetKey, elsewhere }) => {
  const [draft, setDraftState] = useState<PreviewDraft>({});
  const [focused, setFocused] = useState<PreviewSection | null>(null);
  const [path, setPathState] = useState("/");
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<{ section: PreviewSection } | null>(null);
  const [hidden, setHidden] = useState(readPref(HIDDEN_KEY) === "1");
  const [offer, setOffer] = useState<{ label: string; go: () => void } | null>(null);

  const setDraft = useCallback((patch: PreviewDraft) => setDraftState(prev => {
    const next = { ...prev, ...patch };
    for (const k of Object.keys(next) as Array<keyof PreviewDraft>) if (next[k] === undefined) delete next[k];
    return next;
  }), []);
  const focus = useCallback((section: PreviewSection | null) => setFocused(section), []);
  const setPath = useCallback((p: string) => setPathState(p), []);
  const reload = useCallback(() => setReloadKey(k => k + 1), []);

  // A new tab starts from the published site.
  useEffect(() => { setFocused(null); setPathState("/"); setReloadKey(k => k + 1); setOffer(null); }, [resetKey]);

  const handleSelect = useCallback((section: PreviewSection) => {
    setFocused(section);
    setSelected({ section });
    setOffer(elsewhere?.(section) ?? null);
  }, [elsewhere]);

  const value: BuilderPreview = { active: !hidden, setDraft, focus, setPath, reload, selected };
  const toggle = () => { const next = !hidden; setHidden(next); writePref(HIDDEN_KEY, next ? "1" : null); };

  return (
    <PreviewContext.Provider value={value}>
      <div className={hidden ? "np-wb-split is-hidden" : "np-wb-split"}>
        <div className="np-wb-form">{children}</div>
        {hidden
          ? <button type="button" className="tech-button-outline np-wb-show" onClick={toggle}><Monitor size={15} /> แสดงตัวอย่าง</button>
          : <SitePreview draft={draft} focused={focused} path={path} reloadKey={reloadKey} onSelect={handleSelect} onHide={toggle}
              notice={offer && (
                <div className="np-wb-offer" role="status">
                  ส่วนนี้แก้ได้ในแท็บ "{offer.label}"
                  <button type="button" className="tech-button-outline" onClick={() => { setOffer(null); offer.go(); }}>ไปที่แท็บนี้</button>
                  <button type="button" className="np-wb-icon" aria-label="ปิด" onClick={() => setOffer(null)}>×</button>
                </div>
              )} />}
      </div>
    </PreviewContext.Provider>
  );
};

const SitePreview: React.FC<{
  draft: PreviewDraft; focused: PreviewSection | null; path: string; reloadKey: number;
  onSelect: (section: PreviewSection) => void; onHide: () => void; notice?: React.ReactNode;
}> = ({ draft, focused, path, reloadKey, onSelect, onHide, notice }) => {
  const [device, setDevice] = useState<Device>((readPref(DEVICE_KEY) as Device) || "desktop");
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const ready = useRef(false);
  const latest = useRef({ draft, focused });
  latest.current = { draft, focused };

  const send = (message: PreviewMessage) => frame.current?.contentWindow?.postMessage(message, window.location.origin);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => setBoxWidth(entries[0].contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      const message = event.data as PreviewMessage;
      if (message?.type === "np-preview:ready") {
        ready.current = true;
        send({ type: "np-preview:draft", draft: latest.current.draft });
        send({ type: "np-preview:focus", section: latest.current.focused });
      } else if (message?.type === "np-preview:select") {
        onSelect(message.section);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onSelect]);

  // Typing updates the preview shortly after each change.
  useEffect(() => {
    if (!ready.current) return;
    const timer = window.setTimeout(() => send({ type: "np-preview:draft", draft }), 120);
    return () => window.clearTimeout(timer);
  }, [draft]);
  useEffect(() => { if (ready.current) send({ type: "np-preview:focus", section: focused }); }, [focused]);
  useEffect(() => { ready.current = false; }, [path, reloadKey]);

  const width = DEVICES.find(d => d[0] === device)![1];
  const scale = boxWidth ? Math.min(1, boxWidth / width) : 1;
  const chooseDevice = (d: Device) => { setDevice(d); writePref(DEVICE_KEY, d); };

  return (
    <div className="np-wb-preview">
      <div className="np-wb-preview-bar">
        <strong>ตัวอย่างสด</strong>
        <span className="np-wb-preview-note">ยังไม่บันทึกจนกว่าจะกดบันทึก · คลิกส่วนไหนเพื่อแก้ส่วนนั้น</span>
        <span style={{ flex: 1 }} />
        <div role="radiogroup" aria-label="ขนาดจอ" style={{ display: "flex", gap: 4 }}>
          {DEVICES.map(([key, , label, icon]) => (
            <button key={key} type="button" role="radio" aria-checked={device === key} aria-label={label} title={label}
              className={device === key ? "np-wb-icon is-on" : "np-wb-icon"} onClick={() => chooseDevice(key)}>{icon}</button>
          ))}
        </div>
        <button type="button" className="np-wb-icon" aria-label="โหลดตัวอย่างใหม่" title="โหลดตัวอย่างใหม่" onClick={() => { if (frame.current) frame.current.src = frame.current.src; }}><RefreshCw size={15} /></button>
        <button type="button" className="np-wb-icon" aria-label="ซ่อนตัวอย่าง" title="ซ่อนตัวอย่าง" onClick={onHide}><EyeOff size={15} /></button>
      </div>
      {notice}
      <div ref={box} className="np-wb-preview-box">
        <div style={{ width: width * scale, height: "100%", margin: "0 auto", overflow: "hidden" }}>
          <iframe
            key={`${path}#${reloadKey}`}
            ref={frame}
            title="ตัวอย่างหน้าเว็บ"
            src={`${path}${path.includes("?") ? "&" : "?"}np-preview=1`}
            style={{ width, height: `${100 / scale}%`, border: 0, transform: `scale(${scale})`, transformOrigin: "0 0", background: "#fff", display: "block" }}
          />
        </div>
      </div>
    </div>
  );
};
