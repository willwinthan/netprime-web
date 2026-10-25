import React, { useEffect, useState } from "react";
import { ClipboardList, Save } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { ErrorBox, Field, grid2 } from "../site-admin/ui";
import { FieldInput, noticeStyle, ProfileField } from "./shared";

/** "ข้อมูลเพิ่มเติม" section of the profile page: the custom fields an admin defined (admin-only fields excluded). */
export const MyProfileFields: React.FC = () => {
  const api = useApi();
  const [fields, setFields] = useState<ProfileField[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => api.get<{ fields: ProfileField[] }>("/me/profile-fields").then(d => {
    setFields(d.fields);
    setDraft(Object.fromEntries(d.fields.map(f => [f.key, f.value ?? ""])));
  }).catch(err => setError(err.message));
  useEffect(() => { if (api.token) load(); }, [api.token]);

  if (!fields || fields.length === 0) return error ? <ErrorBox message={error} /> : null;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setBusy(true);
      setError(null);
      setNotice(null);
      const res = await api.request<{ message: string }>("/me/profile-fields", { method: "PUT", body: JSON.stringify({ values: draft }) });
      setNotice(res.message);
      await load();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <section className="glass-card" style={{ padding: 24 }} aria-labelledby="profile-extra">
      <h2 id="profile-extra" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 17, margin: "0 0 14px" }}><ClipboardList size={18} />ข้อมูลเพิ่มเติม</h2>
      <ErrorBox message={error} />
      {notice && <div role="status" style={noticeStyle}>{notice}</div>}
      <form onSubmit={save} style={grid2}>
        {fields.map(f => (
          <Field key={f.id} label={f.label + (f.required ? " *" : "")}>
            <FieldInput field={f} value={draft[f.key] ?? ""} onChange={v => setDraft(d => ({ ...d, [f.key]: v }))} />
          </Field>
        ))}
        <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end" }}>
          <button type="submit" className="tech-button-primary" disabled={busy}><Save size={16} />{busy ? "กำลังบันทึก…" : "บันทึกข้อมูลเพิ่มเติม"}</button>
        </div>
      </form>
    </section>
  );
};
