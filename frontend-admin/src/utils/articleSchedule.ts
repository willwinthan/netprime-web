/**
 * Article publish times are Asia/Bangkok wall-clock "YYYY-MM-DD HH:MM:SS" (backend handlers/site.ts,
 * ARTICLE_LIVE). A published article whose time is still ahead is scheduled: the public site hides
 * it until then.
 */
const normalize = (value: string) => {
  const [date, time = "00:00"] = value.trim().replace("T", " ").split(" ");
  return `${date} ${time.length === 5 ? `${time}:00` : time}`;
};

/** Thai time now, in the stored format. */
export const bangkokNow = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

/** Stored value → <input type="datetime-local"> value. */
export const toDateTimeInput = (value: string | null | undefined) => value ? normalize(value).slice(0, 16).replace(" ", "T") : "";

/** True when the time (stored or from the input) is still in the future. */
export const isFuture = (value: string | null | undefined) => !!value && normalize(value) > bangkokNow();

export const isScheduled = (status: string, publishedAt: string | null | undefined) => status === "published" && isFuture(publishedAt);

/** "12 พ.ย. 2569 09:00" in Thai time. */
export function formatSchedule(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(`${normalize(value).replace(" ", "T")}+07:00`);
  return isNaN(date.getTime()) ? value : date.toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" });
}
