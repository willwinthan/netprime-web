import React, { useCallback, useEffect, useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Empty, ErrorBox, Field, Modal, grid2 } from "../site-admin/ui";
import { QuestionForm, QuestionPayload, answerSummary } from "./QuestionBankPage";
import { LessonRef, TYPE_LABEL, cardStyle, mutedText, rowFlex, smallButton } from "./types";

interface VideoQuestion {
  id: string; lesson_id: string; timestamp_seconds: number; type: "single" | "multiple" | "true_false"; prompt: string;
  options: string[]; correct: number[]; explanation: string | null; must_answer: boolean; answer_count: number; correct_count: number;
}

const toClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
/** "m:ss", "h:mm:ss" or plain seconds → seconds. */
function parseClock(value: string): number {
  const parts = value.trim().split(":").map(Number);
  if (parts.some(n => !Number.isFinite(n) || n < 0)) return NaN;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

/** Questions that pause a video lesson at a timestamp (played by InteractiveVideo). */
export const VideoQuestionsEditor: React.FC<{ lessons: LessonRef[] }> = ({ lessons }) => {
  const api = useApi();
  const [lessonId, setLessonId] = useState(lessons[0]?.id ?? "");
  const [items, setItems] = useState<VideoQuestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<VideoQuestion | "new" | null>(null);
  const [clock, setClock] = useState("0:30");
  const [mustAnswer, setMustAnswer] = useState(false);

  useEffect(() => { if (!lessonId && lessons[0]) setLessonId(lessons[0].id); }, [lessons, lessonId]);

  const load = useCallback(() => {
    if (!lessonId) return;
    api.request<{ questions: VideoQuestion[] }>(`/instructor/lessons/${lessonId}/video-questions`).then(res => setItems(res.questions)).catch(err => setError(err.message));
  }, [api.request, lessonId]);
  useEffect(() => { load(); }, [load]);

  const open = (q: VideoQuestion | "new") => {
    setEditing(q);
    setClock(q === "new" ? "0:30" : toClock(q.timestamp_seconds));
    setMustAnswer(q === "new" ? false : q.must_answer);
  };

  const save = async (payload: QuestionPayload) => {
    const seconds = parseClock(clock);
    if (!Number.isFinite(seconds)) throw new Error("รูปแบบเวลาไม่ถูกต้อง (เช่น 1:30)");
    const body = { ...payload, timestamp_seconds: seconds, must_answer: mustAnswer };
    if (editing && editing !== "new") await api.patch(`/instructor/video-questions/${editing.id}`, body);
    else await api.post(`/instructor/lessons/${lessonId}/video-questions`, body);
    setEditing(null);
    load();
  };

  const remove = async (q: VideoQuestion) => {
    if (!confirm("ลบคำถามนี้?")) return;
    try {
      await api.request(`/instructor/video-questions/${q.id}`, { method: "DELETE" });
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (!lessons.length) return <Empty text="ยังไม่มีบทเรียน" />;
  return (
    <div>
      <div style={{ ...rowFlex, justifyContent: "space-between", marginBottom: "16px" }}>
        <select className="form-input" style={{ width: "auto" }} value={lessonId} onChange={e => setLessonId(e.target.value)} aria-label="บทเรียน">
          {lessons.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
        </select>
        <button className="tech-button-primary" style={smallButton} onClick={() => open("new")}><Plus size={14} /> เพิ่มคำถามในวิดีโอ</button>
      </div>
      <p style={{ ...mutedText, marginBottom: "12px" }}>วิดีโอจะหยุดและถามเมื่อถึงเวลาที่กำหนด (ใช้ได้กับวิดีโอที่อัปโหลดเข้าระบบ สำหรับวิดีโอฝังจาก YouTube/Vimeo คำถามจะแสดงใต้วิดีโอ)</p>
      <ErrorBox message={error} />
      {items.length === 0 ? <Empty text="บทเรียนนี้ยังไม่มีคำถามในวิดีโอ" /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {items.map(q => (
            <div key={q.id} style={cardStyle}>
              <div style={{ ...rowFlex, justifyContent: "space-between", flexWrap: "nowrap" }}>
                <div>
                  <div style={rowFlex}>
                    <strong>{toClock(q.timestamp_seconds)}</strong>
                    <span style={mutedText}>{TYPE_LABEL[q.type]}{q.must_answer ? " • ต้องตอบก่อนดูต่อ" : ""}</span>
                    <span style={mutedText}>ตอบแล้ว {q.answer_count} คน • ถูก {q.correct_count}</span>
                  </div>
                  <div style={{ marginTop: "4px" }}>{q.prompt}</div>
                  <div style={mutedText}>เฉลย: {answerSummary(q)}</div>
                </div>
                <div style={{ ...rowFlex, flexWrap: "nowrap" }}>
                  <button className="tech-button-outline" style={smallButton} onClick={() => open(q)} aria-label="แก้ไข"><Pencil size={14} /></button>
                  <button className="tech-button-outline" style={{ ...smallButton, color: "var(--danger)" }} onClick={() => remove(q)} aria-label="ลบ"><Trash2 size={14} /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <Modal title={editing === "new" ? "เพิ่มคำถามในวิดีโอ" : "แก้ไขคำถามในวิดีโอ"} onClose={() => setEditing(null)} width={680}>
          <QuestionForm initial={editing === "new" ? null : editing} allowed={["single", "multiple", "true_false"]} showMeta={false}
            onSubmit={save} onCancel={() => setEditing(null)}
            extra={
              <div style={grid2}>
                <Field label="เวลาในวิดีโอ (นาที:วินาที)"><input className="form-input" value={clock} onChange={e => setClock(e.target.value)} placeholder="1:30" /></Field>
                <label style={{ ...rowFlex, alignSelf: "end" }}><input type="checkbox" checked={mustAnswer} onChange={e => setMustAnswer(e.target.checked)} /> ต้องตอบก่อนดูต่อ</label>
              </div>
            } />
        </Modal>
      )}
    </div>
  );
};

export default VideoQuestionsEditor;
