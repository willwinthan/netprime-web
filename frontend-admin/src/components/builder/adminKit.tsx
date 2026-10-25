import React, { useRef, useState } from "react";
import { ArrowDown, ArrowUp, ImagePlus, Plus, Trash2 } from "lucide-react";
import { API_BASE_URL } from "../../hooks/useApi";
import { Field } from "../site-admin/ui";

/** Shared inputs for the website builder console (Thai UI, same look as the content console). */

export async function uploadBuilderImage(file: File, token: string | null): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${API_BASE_URL}/website/images`, { method: "POST", body: form, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "อัปโหลดรูปไม่สำเร็จ");
  return data.url;
}

export const TextInput: React.FC<{ label: string; value: string | null | undefined; onChange: (v: string) => void; hint?: string; max?: number; multiline?: boolean; span?: boolean; placeholder?: string; required?: boolean }> =
  ({ label, value, onChange, hint, max = 500, multiline, span, placeholder, required }) => (
    <Field label={required ? `${label} *` : label} hint={hint} span={span}>
      {multiline
        ? <textarea className="form-input" rows={4} maxLength={max} value={value ?? ""} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
        : <input className="form-input" maxLength={max} value={value ?? ""} placeholder={placeholder} onChange={e => onChange(e.target.value)} />}
    </Field>
  );

export const SelectInput = <T extends string>({ label, value, options, onChange, span }: { label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void; span?: boolean }) => (
  <Field label={label} span={span}>
    <select className="form-input" value={value} onChange={e => onChange(e.target.value as T)}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  </Field>
);

export const ImageInput: React.FC<{ label: string; value: string | null | undefined; onChange: (v: string) => void; token: string | null; span?: boolean; hint?: string }> =
  ({ label, value, onChange, token, span, hint }) => {
    const input = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const upload = async (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      setError(null);
      try { onChange(await uploadBuilderImage(file, token)); } catch (err: any) { setError(err.message); } finally { setBusy(false); if (input.current) input.current.value = ""; }
    };
    return (
      <Field label={label} span={span} hint={error ?? hint ?? "วางลิงก์ https:// หรืออัปโหลด PNG/JPG/WEBP ไม่เกิน 5 MB"}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input className="form-input" style={{ flex: 1 }} value={value ?? ""} placeholder="https://…" onChange={e => onChange(e.target.value)} />
          <button type="button" className="tech-button-outline" style={{ padding: "8px 10px", whiteSpace: "nowrap" }} disabled={busy} onClick={() => input.current?.click()}>
            <ImagePlus size={15} />{busy ? "กำลังอัปโหลด…" : "อัปโหลด"}
          </button>
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={e => upload(e.target.files?.[0])} />
        </div>
        {value && /^(https?:\/\/|\/)/.test(value) && <img src={value} alt="" style={{ marginTop: 6, maxHeight: 64, maxWidth: 160, objectFit: "contain", borderRadius: 6, border: "1px solid rgba(0,0,0,0.06)" }} />}
      </Field>
    );
  };

/** Small list editor: add / move / remove items, each rendered by `render`. */
export function ListEditor<T>({ items, onChange, render, blank, max, addLabel, itemLabel }: {
  items: T[]; onChange: (items: T[]) => void; render: (item: T, update: (patch: Partial<T>) => void, index: number) => React.ReactNode;
  blank: () => T; max: number; addLabel: string; itemLabel: (index: number) => string;
}) {
  const move = (i: number, d: number) => {
    const next = [...items];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div style={{ display: "grid", gap: 10, gridColumn: "1 / -1" }}>
      {items.map((item, i) => (
        <div key={i} style={{ border: "1px solid rgba(0,0,0,0.07)", borderRadius: 10, padding: 12, background: "rgba(0,0,0,0.015)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <strong style={{ fontSize: 13, color: "var(--text-secondary)" }}>{itemLabel(i)}</strong>
            <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              <IconBtn label="เลื่อนขึ้น" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></IconBtn>
              <IconBtn label="เลื่อนลง" disabled={i === items.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></IconBtn>
              <IconBtn label="ลบ" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 size={14} /></IconBtn>
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px 12px" }}>
            {render(item, patch => onChange(items.map((x, j) => j === i ? { ...x, ...patch } : x)), i)}
          </div>
        </div>
      ))}
      {items.length < max && (
        <button type="button" className="tech-button-outline" style={{ justifySelf: "start", padding: "6px 12px", fontSize: 13 }} onClick={() => onChange([...items, blank()])}>
          <Plus size={14} />{addLabel}
        </button>
      )}
    </div>
  );
}

export const IconBtn: React.FC<{ label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }> = ({ label, onClick, disabled, danger, children }) => (
  <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, border: "1px solid rgba(0,0,0,0.08)", borderRadius: 8, background: "#fff", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1, color: danger ? "var(--danger)" : "var(--text-secondary)" }}>
    {children}
  </button>
);

export const Notice: React.FC<{ tone?: "ok" | "warn"; children: React.ReactNode }> = ({ tone = "ok", children }) => (
  <div role="status" style={{ padding: "10px 14px", borderRadius: 8, fontSize: 14, marginBottom: 12, background: tone === "ok" ? "rgba(16,185,129,0.1)" : "rgba(245,158,11,0.12)", color: tone === "ok" ? "#047857" : "#92400e" }}>{children}</div>
);
