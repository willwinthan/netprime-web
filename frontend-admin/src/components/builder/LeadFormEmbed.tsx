import React, { useSyncExternalStore } from "react";

/**
 * Slot for lead forms built by the marketing module. The page builder stores only a form id;
 * how the form renders belongs to marketing, which registers its component once at module load:
 *
 *   import { registerLeadFormRenderer } from "../components/builder/LeadFormEmbed";
 *   registerLeadFormRenderer(({ formId }) => <LeadForm formId={formId} />);
 *
 * Until something is registered the public page renders nothing (no-op default) and the
 * console preview shows a labelled placeholder.
 */
export type LeadFormRenderer = React.ComponentType<{ formId: string }>;

let renderer: LeadFormRenderer | null = null;
const listeners = new Set<() => void>();

export function registerLeadFormRenderer(component: LeadFormRenderer | null) {
  renderer = component;
  listeners.forEach(l => l());
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const LeadFormEmbed: React.FC<{ formId: string; preview?: boolean }> = ({ formId, preview }) => {
  const Registered = useSyncExternalStore(subscribe, () => renderer);
  if (Registered && formId) return <Registered formId={formId} />;
  if (!preview) return null;
  return (
    <div className="ps-pb-placeholder" role="note">
      ฟอร์มเก็บ lead {formId ? <code>{formId}</code> : "(ยังไม่ได้ระบุรหัสฟอร์ม)"} — แสดงบนหน้าเว็บเมื่อเปิดใช้ระบบฟอร์มของเมนูการตลาด
    </div>
  );
};
