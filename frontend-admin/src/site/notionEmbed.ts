/**
 * Notion pages published to the web (Share → Publish) live on <workspace>.notion.site and can be
 * embedded through the /ebd/<page id> path. Only those URLs are embedded; anything else stays a link.
 * Mirrors notionEmbedUrl in backend/src/utils/notion.ts.
 */
export function notionEmbedUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" || !url.hostname.endsWith(".notion.site")) return null;
    const segment = url.pathname.split("/").filter(Boolean).pop() || "";
    const dashed = segment.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    const compact = segment.match(/(?:^|-)([0-9a-f]{32})$/i);
    const id = (dashed ? dashed[1].replace(/-/g, "") : compact?.[1])?.toLowerCase();
    return id ? `https://${url.hostname}/ebd/${id}` : null;
  } catch {
    return null;
  }
}
