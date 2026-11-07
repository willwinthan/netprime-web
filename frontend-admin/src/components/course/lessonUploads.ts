import { API_BASE_URL } from "../../hooks/useApi";

/** Workers reject request bodies above 100 MB; bigger videos upload straight to Cloudflare Stream. */
const WORKER_UPLOAD_LIMIT = 100 * 1024 * 1024;
/** tus chunk size for Stream direct uploads (multiple of 256 KiB, at least 5 MiB). */
const STREAM_CHUNK = 50 * 1024 * 1024;

export type VideoProvider = "cloudflare" | "youtube" | "vimeo";

export const VIDEO_SOURCE_LABEL: Record<VideoProvider, string> = {
  cloudflare: "อัปโหลดไฟล์เข้าระบบ",
  youtube: "YouTube",
  vimeo: "Vimeo"
};

/**
 * Accepts a pasted YouTube / Vimeo link (or a bare ID) for the video field and returns the ID the API
 * stores plus the provider the link belongs to, so instructors never have to find a video ID themselves.
 */
export function parseVideoLink(input: string): { id: string; provider?: "youtube" | "vimeo" } {
  const value = input.trim();
  let url: URL;
  try { url = new URL(value); } catch { return { id: value }; }
  const host = url.hostname.replace(/^(www|m)\./, "");
  if (host === "youtu.be") return { id: url.pathname.slice(1).split("/")[0], provider: "youtube" };
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const v = url.searchParams.get("v");
    if (v) return { id: v, provider: "youtube" };
    const m = url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]+)/);
    if (m) return { id: m[1], provider: "youtube" };
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const m = url.pathname.match(/(\d{6,})/);
    if (m) return { id: m[1], provider: "vimeo" };
  }
  return { id: value };
}

interface Api {
  token: string | null;
  post: <T>(endpoint: string, body: unknown) => Promise<T>;
}

async function readError(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => ({}));
  return data.error || fallback;
}

/**
 * Uploads a lesson video or handout and returns what the lesson stores: an R2 key (files up to 100 MB
 * go through the Worker, which picks the key) or, for bigger videos, a Cloudflare Stream video UID.
 */
export async function uploadLessonFile(api: Api, file: File, type: "handout" | "video", onProgress?: (percent: number | null) => void): Promise<string> {
  if (type === "video" && file.size > WORKER_UPLOAD_LIMIT) return uploadToStream(api, file, onProgress);
  const ticket = await api.post<{ key: string; uploadUrl: string; contentType: string }>("/instructor/upload/presign", {
    filename: file.name, type, size: file.size, mimeType: file.type
  });
  const response = await fetch(`${API_BASE_URL}${ticket.uploadUrl}`, {
    method: "PUT", body: file,
    headers: { "Content-Type": ticket.contentType, ...(api.token ? { Authorization: `Bearer ${api.token}` } : {}) }
  });
  if (!response.ok) throw new Error(await readError(response, "อัปโหลดไฟล์ไม่สำเร็จ"));
  return ticket.key;
}

async function uploadToStream(api: Api, file: File, onProgress?: (percent: number | null) => void): Promise<string> {
  const { uploadURL, uid } = await api.post<{ uploadURL: string; uid: string }>("/instructor/stream/direct-upload", { size: file.size, filename: file.name });
  let offset = 0;
  onProgress?.(0);
  try {
    while (offset < file.size) {
      const chunk = file.slice(offset, offset + STREAM_CHUNK);
      const res = await fetch(uploadURL, {
        method: "PATCH",
        headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" },
        body: chunk
      });
      if (!res.ok) throw new Error(`อัปโหลดวิดีโอไม่สำเร็จ (Stream ตอบกลับ ${res.status})`);
      offset = Number(res.headers.get("Upload-Offset")) || offset + chunk.size;
      onProgress?.(Math.round((offset / file.size) * 100));
    }
  } finally {
    onProgress?.(null);
  }
  return uid;
}
