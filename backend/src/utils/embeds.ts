/**
 * Embed lessons: only https links to known providers are accepted, and the learner player
 * only ever receives the iframe src computed here (never the raw stored URL).
 */

export const EMBED_PROVIDERS = "YouTube, Vimeo, Google Slides/Docs/Forms, Canva, Figma, Miro, Loom, Notion (*.notion.site)";

const hostIs = (host: string, domain: string) => host === domain || host.endsWith("." + domain);

/** Returns the iframe src for an allowlisted URL, or null when the URL may not be embedded. */
export function embedSrc(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  // YouTube (watch, share, shorts, embed) → privacy-enhanced player
  if (host === "youtu.be" || hostIs(host, "youtube.com") || hostIs(host, "youtube-nocookie.com")) {
    const id = host === "youtu.be" ? path.slice(1).split("/")[0]
      : url.searchParams.get("v") || path.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1] || "";
    return /^[\w-]{6,20}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (host === "vimeo.com" || host === "www.vimeo.com" || host === "player.vimeo.com") {
    const id = path.match(/^\/(?:video\/)?(\d{5,12})(?:\/([\da-f]+))?/);
    if (!id) return null;
    const hash = id[2] || url.searchParams.get("h");
    return `https://player.vimeo.com/video/${id[1]}${hash && /^[\da-f]+$/.test(hash) ? `?h=${hash}` : ""}`;
  }
  if (host === "docs.google.com") {
    const doc = path.match(/^\/(presentation|document|forms|spreadsheets)\/d\/(e\/)?([\w-]{10,})/);
    if (!doc) return null;
    const [, kind, published, id] = doc;
    const base = `https://docs.google.com/${kind}/d/${published || ""}${id}`;
    if (kind === "presentation") return `${base}/embed`;
    if (kind === "forms") return `${base}/viewform?embedded=true`;
    return `${base}/${published ? "pub?embedded=true" : "preview"}`;
  }
  if (hostIs(host, "canva.com")) {
    const design = path.match(/^\/design\/([\w-]+)\/([\w-]+)/);
    return design ? `https://www.canva.com/design/${design[1]}/${design[2]}/view?embed` : null;
  }
  if (hostIs(host, "figma.com")) {
    if (!/^\/(file|design|proto|board|slides)\//.test(path)) return null;
    return `https://www.figma.com/embed?embed_host=netprime&url=${encodeURIComponent(`https://www.figma.com${path}`)}`;
  }
  if (hostIs(host, "miro.com")) {
    const board = path.match(/^\/app\/(?:board|live-embed)\/([\w=-]+)/);
    return board ? `https://miro.com/app/live-embed/${board[1]}/` : null;
  }
  if (hostIs(host, "loom.com")) {
    const video = path.match(/^\/(?:share|embed)\/([\da-f]{16,})/);
    return video ? `https://www.loom.com/embed/${video[1]}` : null;
  }
  if (hostIs(host, "notion.site") && host !== "notion.site") {
    return `https://${host}${path}${url.search}`;
  }
  return null;
}
