/** Shapes returned by backend/src/handlers/commerce.ts. */
export type ProductKind = "course" | "bundle" | "membership";

export interface ProductCourseRef { course_id: string; title: string; price: number; sort_order: number }

export interface Product {
  id: string; kind: ProductKind; title: string; description: string | null; price: number; status: "draft" | "published" | "archived";
  course_id: string | null; access_days: number | null; all_courses: boolean; is_path: boolean; path_certificate: boolean;
  max_installments: number; installment_interval_days: number; installment_access: "first" | "full"; overdue_grace_days: number;
  cover_image_url: string | null; courses: ProductCourseRef[]; course_count: number; separate_price: number; savings: number;
  sold?: number;
  // /student/products
  membership?: { product_id: string; status: string; expires_at: string } | null;
  owned_courses?: number;
  open_order?: { id: string; status: string; reference: string } | null;
}

export const PRODUCT_KIND: Record<ProductKind, string> = { course: "คอร์สเดี่ยว (ผ่อนได้)", bundle: "ชุดคอร์ส / เส้นทาง", membership: "สมาชิกรายช่วง" };
export const PRODUCT_STATUS: Record<Product["status"], { label: string; color: string; bg: string }> = {
  draft: { label: "ร่าง", color: "var(--text-secondary)", bg: "rgba(100,116,139,0.12)" },
  published: { label: "เปิดขาย", color: "var(--accent)", bg: "var(--accent-glow)" },
  archived: { label: "เลิกขาย", color: "var(--warning)", bg: "rgba(245,158,11,0.12)" }
};

export interface Quote {
  id: string; quote_no: string; partner_id: string; company_name: string; tax_id: string | null; title: string;
  contact_name: string | null; contact_email: string | null; buyer_address: string | null; buyer_branch: string | null;
  seats: number; price: number; valid_until: string; status: "draft" | "sent" | "accepted" | "expired" | "cancelled";
  note: string | null; order_id: string | null; order_status: string | null; order_reference: string | null;
  created_by_name: string | null; created_at: string; courses: { course_id: string; title: string; price: number }[];
}

export const QUOTE_STATUS: Record<Quote["status"], { label: string; color: string; bg: string }> = {
  draft: { label: "ร่าง", color: "var(--text-secondary)", bg: "rgba(100,116,139,0.12)" },
  sent: { label: "ส่งแล้ว", color: "var(--primary)", bg: "var(--primary-glow)" },
  accepted: { label: "ตอบรับแล้ว", color: "var(--accent)", bg: "var(--accent-glow)" },
  expired: { label: "หมดอายุ", color: "var(--warning)", bg: "rgba(245,158,11,0.12)" },
  cancelled: { label: "ยกเลิก", color: "var(--danger)", bg: "rgba(239,68,68,0.1)" }
};

export interface CourseOption { id: string; title: string; price: number }
