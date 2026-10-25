import React, { useEffect, useState } from "react";
import { API_BASE_URL } from "../../hooks/useApi";

export interface CourseRating { average: number | null; count: number }

/** Read-only star row, e.g. ★★★★☆ 4.5 (12 รีวิว). */
export const Stars: React.FC<{ value: number | null; count?: number; size?: number; showCount?: boolean }> = ({ value, count, size = 16, showCount = true }) => {
  const rounded = Math.round(value ?? 0);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: size - 2 }}
      aria-label={value ? `คะแนนเฉลี่ย ${value.toFixed(1)} จาก 5${count !== undefined ? ` จาก ${count} รีวิว` : ""}` : "ยังไม่มีรีวิว"}>
      <span aria-hidden="true" style={{ color: "#d97706", fontSize: size, letterSpacing: 1, whiteSpace: "nowrap" }}>
        {[1, 2, 3, 4, 5].map(i => (i <= rounded ? "★" : "☆")).join("")}
      </span>
      {value ? <strong style={{ color: "inherit" }}>{value.toFixed(1)}</strong> : null}
      {showCount && count !== undefined && <span style={{ opacity: 0.75 }}>({count} รีวิว)</span>}
    </span>
  );
};

/** Clickable 1–5 stars for the review form. */
export const StarInput: React.FC<{ value: number; onChange: (value: number) => void }> = ({ value, onChange }) => (
  <div role="radiogroup" aria-label="ให้คะแนน" style={{ display: "flex", gap: 4 }}>
    {[1, 2, 3, 4, 5].map(i => (
      <button key={i} type="button" role="radio" aria-checked={value === i} aria-label={`${i} ดาว`} onClick={() => onChange(i)}
        style={{ background: "none", border: "none", cursor: "pointer", fontSize: 28, lineHeight: 1, padding: 2, color: i <= value ? "#d97706" : "#cbd5e1" }}>
        ★
      </button>
    ))}
  </div>
);

let ratingsPromise: Promise<Record<string, { average: number; count: number }>> | null = null;
/** Average rating per published course (approved reviews only), fetched once per page load. */
export function useCourseRatings(): Record<string, { average: number; count: number }> {
  const [ratings, setRatings] = useState<Record<string, { average: number; count: number }>>({});
  useEffect(() => {
    ratingsPromise ??= fetch(`${API_BASE_URL}/public/marketing/ratings`)
      .then(res => (res.ok ? res.json() : { ratings: {} }))
      .then(data => data.ratings || {})
      .catch(() => { ratingsPromise = null; return {}; });
    ratingsPromise.then(setRatings);
  }, []);
  return ratings;
}
