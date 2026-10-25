import React, { useEffect, useState } from "react";
import { API_BASE_URL } from "../../hooks/useApi";
import "./course.css";

export interface CourseCategory { id: string; name: string; slug: string; description: string | null; sort_order: number; course_count: number }

let categoriesPromise: Promise<CourseCategory[]> | null = null;
/** Public category list (cached for the page); GET /api/course-categories. */
export function loadCourseCategories(force = false): Promise<CourseCategory[]> {
  if (force || !categoriesPromise) {
    categoriesPromise = fetch(`${API_BASE_URL}/course-categories`)
      .then(res => (res.ok ? res.json() : { categories: [] }))
      .then(data => data.categories ?? [])
      .catch(() => { categoriesPromise = null; return []; });
  }
  return categoriesPromise;
}

/**
 * Category chips for course catalogs (learner dashboard, public site). `value` is a category id
 * ("" = all). Hidden when no category has published courses.
 */
export const CategoryFilter: React.FC<{ value: string; onChange: (categoryId: string) => void }> = ({ value, onChange }) => {
  const [categories, setCategories] = useState<CourseCategory[]>([]);
  useEffect(() => { loadCourseCategories().then(setCategories); }, []);
  const visible = categories.filter(c => c.course_count > 0 || c.id === value);
  if (!visible.length) return null;
  return (
    <div className="np-category-chips" role="group" aria-label="กรองตามหมวดหมู่">
      <button type="button" className="np-category-chip" aria-pressed={value === ""} onClick={() => onChange("")}>ทั้งหมด</button>
      {visible.map(c => (
        <button key={c.id} type="button" className="np-category-chip" aria-pressed={value === c.id} onClick={() => onChange(c.id)}>
          {c.name} <span style={{ opacity: 0.7 }}>({c.course_count})</span>
        </button>
      ))}
    </div>
  );
};

/** Same filter styled for the public site (.ps chips). */
export const PublicCategoryChips: React.FC<{ value: string; onChange: (categoryId: string) => void; label: string; allLabel: string }> = ({ value, onChange, label, allLabel }) => {
  const [categories, setCategories] = useState<CourseCategory[]>([]);
  useEffect(() => { loadCourseCategories().then(setCategories); }, []);
  const visible = categories.filter(c => c.course_count > 0 || c.id === value);
  if (!visible.length) return null;
  return (
    <div className="ps-chips" role="group" aria-label={label}>
      <button type="button" className="ps-chip" aria-pressed={value === ""} onClick={() => onChange("")}>{allLabel}</button>
      {visible.map(c => <button key={c.id} type="button" className="ps-chip" aria-pressed={value === c.id} onClick={() => onChange(c.id)}>{c.name}</button>)}
    </div>
  );
};
