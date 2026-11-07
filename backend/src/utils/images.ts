import type { Env } from "../middleware/rbac";

/** Image types accepted for uploaded site images; SVG is refused (it can carry scripts). */
export const IMAGE_TYPES: Record<string, { ext: string; magic: number[] }> = {
  "image/png": { ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  "image/jpeg": { ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  "image/gif": { ext: "gif", magic: [0x47, 0x49, 0x46, 0x38] },
  "image/webp": { ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] }
};

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Checks an uploaded image (type, size, magic bytes) and stores it in R2 under site/. It is then served
 * publicly by GET /api/public/images/:name. Returns the stored name, or an error message for the user.
 */
export async function saveSiteImage(env: Env["Bindings"], file: unknown): Promise<{ name: string } | { error: string }> {
  if (!(file instanceof File)) return { error: "กรุณาเลือกไฟล์รูปภาพ" };
  const type = IMAGE_TYPES[file.type];
  if (!type) return { error: "รองรับเฉพาะไฟล์ PNG, JPG, WEBP หรือ GIF" };
  if (file.size > MAX_IMAGE_BYTES) return { error: "ไฟล์รูปต้องไม่เกิน 5 MB" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!type.magic.every((byte, i) => bytes[i] === byte)) return { error: "ไฟล์ไม่ใช่รูปภาพตามชนิดที่ระบุ" };
  const name = `${crypto.randomUUID().replace(/-/g, "")}.${type.ext}`;
  await env.ASSETS.put(`site/${name}`, bytes, { httpMetadata: { contentType: file.type } });
  return { name };
}

/** Public URL of an image stored by saveSiteImage, on the API origin that handled the request. */
export const siteImageUrl = (requestUrl: string, name: string) => `${new URL(requestUrl).origin}/api/public/images/${name}`;
