import React, { useCallback, useEffect, useRef, useState } from "react";
import { HelpCircle } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { mutedText, rowFlex, smallButton } from "./types";

interface VideoQuestion {
  id: string;
  timestamp_seconds: number;
  type: "single" | "multiple" | "true_false";
  prompt: string;
  must_answer: boolean;
  options: string[];
  /** Present only once the question is final (correct, or every try used); the key is never sent before. */
  answered: { response: number | number[]; is_correct: boolean; correct: number[]; explanation: string | null } | null;
  tries_left?: number;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** One question card: answer, then show feedback. */
const QuestionCard: React.FC<{ q: VideoQuestion; onAnswered: (q: VideoQuestion) => void; onContinue?: () => void; dark?: boolean }> = ({ q, onAnswered, onContinue, dark }) => {
  const api = useApi();
  const [picked, setPicked] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const color = dark ? "#fff" : "var(--text-primary)";

  const answer = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ correct: boolean; final: boolean; tries_left: number; correct_answer?: number[]; explanation?: string | null }>(`/student/video-questions/${q.id}/answer`,
        { response: q.type === "multiple" ? picked : picked[0] });
      if (!res.final) {
        // Wrong, with a try left: no answer key yet.
        setPicked([]);
        setError(`ยังไม่ถูก ลองอีกครั้ง (เหลืออีก ${res.tries_left} ครั้ง)`);
        return;
      }
      onAnswered({ ...q, tries_left: 0, answered: { response: picked, is_correct: res.correct, correct: res.correct_answer ?? [], explanation: res.explanation ?? null } });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (i: number) => setPicked(q.type === "multiple" ? (picked.includes(i) ? picked.filter(x => x !== i) : [...picked, i]) : [i]);
  return (
    <div style={{ color }}>
      <div style={{ ...rowFlex, marginBottom: "8px" }}>
        <HelpCircle size={16} /> <strong>คำถามระหว่างเรียน</strong> <span style={{ ...mutedText, color: dark ? "#cbd5e1" : undefined }}>นาทีที่ {fmt(q.timestamp_seconds)}</span>
      </div>
      <p style={{ marginBottom: "10px", whiteSpace: "pre-wrap" }}>{q.prompt}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "10px" }}>
        {q.options.map((o, i) => {
          const isRight = q.answered?.correct.includes(i);
          return (
            <label key={i} style={{ display: "flex", gap: "8px", alignItems: "center", cursor: q.answered ? "default" : "pointer", fontWeight: q.answered && isRight ? 700 : 400 }}>
              <input type={q.type === "multiple" ? "checkbox" : "radio"} name={`vq-${q.id}`} disabled={!!q.answered}
                checked={q.answered ? ([] as number[]).concat(q.answered.response as any).includes(i) : picked.includes(i)} onChange={() => toggle(i)} />
              {o} {q.answered && isRight ? "✓" : ""}
            </label>
          );
        })}
      </div>
      {error && <p style={{ color: "var(--danger)", fontSize: "13px" }}>{error}</p>}
      {q.answered ? (
        <div>
          <p style={{ color: q.answered.is_correct ? "var(--accent)" : "var(--warning)", fontWeight: 600 }}>{q.answered.is_correct ? "ถูกต้อง!" : "ยังไม่ถูก ลองทบทวนเนื้อหาอีกครั้ง"}</p>
          {q.answered.explanation && <p style={{ fontSize: "13px", marginTop: "4px" }}>{q.answered.explanation}</p>}
          {onContinue && <button className="tech-button-primary" style={{ ...smallButton, marginTop: "10px" }} onClick={onContinue}>ดูต่อ</button>}
        </div>
      ) : (
        <div style={rowFlex}>
          <button className="tech-button-primary" style={smallButton} disabled={!picked.length || busy} onClick={answer}>{busy ? "กำลังตรวจ..." : "ส่งคำตอบ"}</button>
          {onContinue && !q.must_answer && <button className="tech-button-outline" style={{ ...smallButton, color }} onClick={onContinue}>ข้าม</button>}
          {q.must_answer && <span style={{ fontSize: "12px", color: dark ? "#cbd5e1" : "var(--text-muted)" }}>ต้องตอบก่อนดูต่อ</span>}
        </div>
      )}
    </div>
  );
};

/**
 * Wraps the lesson video player: pauses the <video> at each question's timestamp and asks it.
 * Questions marked must_answer also stop seeking past them until answered. Embedded players
 * (YouTube/Vimeo/Stream iframe) cannot be controlled, so their questions are listed below the player.
 */
export const InteractiveVideo: React.FC<{ lessonId: string; children: React.ReactNode }> = ({ lessonId, children }) => {
  const api = useApi();
  const container = useRef<HTMLDivElement>(null);
  const [questions, setQuestions] = useState<VideoQuestion[]>([]);
  const [active, setActive] = useState<VideoQuestion | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [fallback, setFallback] = useState(false);
  const shown = useRef(new Set<string>());
  const lastTime = useRef(0);
  const questionsRef = useRef(questions);
  questionsRef.current = questions;

  useEffect(() => {
    setQuestions([]);
    setActive(null);
    setFallback(false);
    shown.current = new Set();
    lastTime.current = 0;
    // Not enrolled / no questions: render the plain player.
    api.request<{ questions: VideoQuestion[] }>(`/student/lessons/${lessonId}/video-questions`).then(res => setQuestions(res.questions)).catch(() => setQuestions([]));
  }, [api.request, lessonId]);

  // The <video> element mounts inside the player after the signed URL loads.
  useEffect(() => {
    if (!questions.length) return;
    let tries = 0;
    const timer = setInterval(() => {
      const el = container.current?.querySelector("video") ?? null;
      if (el) { setVideo(el); setFallback(false); clearInterval(timer); }
      else if (++tries > 12) { setFallback(true); clearInterval(timer); }
    }, 250);
    return () => clearInterval(timer);
  }, [questions.length, lessonId]);

  // Pause through the player's own click handler so its play/pause state stays in sync.
  const pause = useCallback((el: HTMLVideoElement) => { if (!el.paused) { el.click(); if (!el.paused) el.pause(); } }, []);
  const resume = useCallback((el: HTMLVideoElement) => { if (el.paused) { el.click(); if (el.paused) el.play().catch(() => undefined); } }, []);

  useEffect(() => {
    if (!video) return;
    const onTime = () => {
      if (active) return;
      const now = video.currentTime;
      const prev = lastTime.current;
      lastTime.current = now;
      const list = questionsRef.current;
      // Must-answer questions block skipping past them.
      const blocker = list.find(q => q.must_answer && !q.answered && now > q.timestamp_seconds + 0.75);
      if (blocker) {
        video.currentTime = blocker.timestamp_seconds;
        lastTime.current = blocker.timestamp_seconds;
        pause(video);
        setActive(blocker);
        return;
      }
      const due = list.find(q => !shown.current.has(q.id) && !q.answered && prev <= q.timestamp_seconds && now >= q.timestamp_seconds && now - prev < 2);
      if (due) {
        shown.current.add(due.id);
        pause(video);
        setActive(due);
      }
    };
    video.addEventListener("timeupdate", onTime);
    return () => video.removeEventListener("timeupdate", onTime);
  }, [video, active, pause]);

  const answered = (q: VideoQuestion) => {
    setQuestions(prev => prev.map(x => x.id === q.id ? q : x));
    setActive(a => a && a.id === q.id ? q : a);
  };
  const continueVideo = () => {
    setActive(null);
    if (video) resume(video);
  };

  return (
    <div>
      <div ref={container} style={{ position: "relative" }}>
        {children}
        {active && (
          <div role="dialog" aria-label="คำถามระหว่างเรียน" style={{ position: "absolute", inset: 0, background: "rgba(5,7,15,0.88)", display: "flex",
            alignItems: "center", justifyContent: "center", padding: "24px", zIndex: 5, borderRadius: "inherit", overflowY: "auto" }}>
            <div style={{ maxWidth: "560px", width: "100%" }}>
              <QuestionCard key={active.id} q={active} dark onAnswered={answered}
                onContinue={!active.must_answer || active.answered ? continueVideo : undefined} />
            </div>
          </div>
        )}
      </div>
      {fallback && questions.length > 0 && (
        <div className="glass-card" style={{ padding: "16px", marginTop: "12px", display: "flex", flexDirection: "column", gap: "16px" }}>
          <span style={mutedText}>วิดีโอนี้มีคำถามระหว่างเรียน ตอบได้ตามนาทีที่ระบุ</span>
          {questions.map(q => <QuestionCard key={q.id} q={q} onAnswered={answered} />)}
        </div>
      )}
    </div>
  );
};

export default InteractiveVideo;
