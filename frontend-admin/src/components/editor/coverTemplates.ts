// Article cover templates: drawn on a canvas in the browser (no server rendering), title centred.
// Size matches social share images (1200×630); blog cards crop a little top and bottom, so the
// title stays inside the middle of the picture.

export const COVER_WIDTH = 1200;
export const COVER_HEIGHT = 630;

export interface CoverOptions {
  title: string;
  /** Small label above the title, e.g. the article category. */
  label?: string;
  /** Show "NetPrime" at the bottom. */
  brand?: boolean;
  /** The writer's own background photo; the template's colour is laid over it so the title stays readable. */
  photo?: HTMLImageElement | null;
}

interface Template {
  id: string;
  name: string;
  /** Background when no photo is used. */
  background: (ctx: CanvasRenderingContext2D) => void;
  /** Laid over the writer's photo. */
  overlay: string;
  title: string;
  label: string;
  /** Decoration drawn under the title block (accent bars and such). */
  accent?: (ctx: CanvasRenderingContext2D, titleBottom: number) => void;
}

const NAVY = "#182443";
const NAVY_DEEP = "#0e1730";
const ORANGE = "#e56b25";
const ORANGE_DEEP = "#c2541a";
const CREAM = "#fcefe7";

/** Same pattern every time for the same seed, so previews do not jump while typing. */
function seeded(seed: number) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

function dots(ctx: CanvasRenderingContext2D, color: string, gap = 36, radius = 2) {
  ctx.fillStyle = color;
  for (let x = gap / 2; x < COVER_WIDTH; x += gap) for (let y = gap / 2; y < COVER_HEIGHT; y += gap) {
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
  }
}

function linear(ctx: CanvasRenderingContext2D, from: string, to: string) {
  const g = ctx.createLinearGradient(0, 0, COVER_WIDTH, COVER_HEIGHT);
  g.addColorStop(0, from); g.addColorStop(1, to);
  ctx.fillStyle = g; ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
}

export const COVER_TEMPLATES: Template[] = [
  {
    id: "sunrise", name: "ส้มไล่เฉด",
    background: ctx => {
      linear(ctx, "#f08a3c", ORANGE_DEEP);
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath(); ctx.arc(1080, 80, 260, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(120, 600, 200, 0, Math.PI * 2); ctx.fill();
    },
    overlay: "rgba(194,84,26,0.72)", title: "#ffffff", label: "rgba(255,255,255,0.85)"
  },
  {
    id: "navy", name: "กรมท่า",
    background: ctx => { ctx.fillStyle = NAVY; ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT); dots(ctx, "rgba(255,255,255,0.08)"); },
    overlay: "rgba(24,36,67,0.78)", title: "#ffffff", label: ORANGE,
    accent: (ctx, bottom) => { ctx.fillStyle = ORANGE; ctx.fillRect(COVER_WIDTH / 2 - 48, bottom + 28, 96, 8); }
  },
  {
    id: "network", name: "เครือข่าย",
    background: ctx => {
      linear(ctx, NAVY_DEEP, "#1f3466");
      const rand = seeded(7);
      const nodes = Array.from({ length: 34 }, () => [rand() * COVER_WIDTH, rand() * COVER_HEIGHT] as const);
      ctx.strokeStyle = "rgba(229,107,37,0.22)"; ctx.lineWidth = 1.5;
      for (const [x1, y1] of nodes) for (const [x2, y2] of nodes) {
        if (Math.hypot(x1 - x2, y1 - y2) < 190) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
      }
      for (const [x, y] of nodes) { ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); }
    },
    overlay: "rgba(14,23,48,0.75)", title: "#ffffff", label: "#f5a26b"
  },
  {
    id: "light", name: "สว่าง",
    background: ctx => {
      ctx.fillStyle = CREAM; ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
      ctx.fillStyle = ORANGE;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(220, 0); ctx.lineTo(0, 220); ctx.fill();
      ctx.fillStyle = NAVY;
      ctx.beginPath(); ctx.moveTo(COVER_WIDTH, COVER_HEIGHT); ctx.lineTo(COVER_WIDTH - 220, COVER_HEIGHT); ctx.lineTo(COVER_WIDTH, COVER_HEIGHT - 220); ctx.fill();
    },
    overlay: "rgba(252,239,231,0.82)", title: NAVY, label: ORANGE_DEEP
  },
  {
    id: "code", name: "โค้ด",
    background: ctx => {
      ctx.fillStyle = "#11151f"; ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
      ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.lineWidth = 1;
      for (let x = 0; x < COVER_WIDTH; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, COVER_HEIGHT); ctx.stroke(); }
      for (let y = 0; y < COVER_HEIGHT; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(COVER_WIDTH, y); ctx.stroke(); }
      ctx.font = "600 30px 'JetBrains Mono', ui-monospace, Menlo, monospace";
      ctx.fillStyle = "rgba(229,107,37,0.9)"; ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText("$ netprime learn", 56, 48);
      ctx.fillStyle = "rgba(255,255,255,0.18)"; ctx.textAlign = "right"; ctx.textBaseline = "bottom";
      ctx.fillText("</>", COVER_WIDTH - 56, COVER_HEIGHT - 44);
    },
    overlay: "rgba(17,21,31,0.8)", title: "#ffffff", label: "#7ee2a8"
  },
  {
    id: "split", name: "สองโทน",
    background: ctx => {
      ctx.fillStyle = NAVY; ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
      // Deep orange keeps white text readable where the title crosses into it.
      ctx.fillStyle = ORANGE_DEEP;
      ctx.beginPath(); ctx.moveTo(COVER_WIDTH * 0.7, 0); ctx.lineTo(COVER_WIDTH, 0); ctx.lineTo(COVER_WIDTH, COVER_HEIGHT); ctx.lineTo(COVER_WIDTH * 0.52, COVER_HEIGHT); ctx.fill();
    },
    overlay: "rgba(24,36,67,0.7)", title: "#ffffff", label: "#ffd2b5",
    accent: (ctx, bottom) => { ctx.fillStyle = "#ffffff"; ctx.fillRect(COVER_WIDTH / 2 - 60, bottom + 28, 120, 4); }
  }
];

/** Thai has no spaces between words: break with Intl.Segmenter when the browser has it. */
function words(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (locale: string, opts: { granularity: "word" }) => { segment: (t: string) => Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) return Array.from(new Seg("th", { granularity: "word" }).segment(text), s => s.segment);
  return text.split(/(\s+)/);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of words(text)) {
    const next = line + word;
    if (ctx.measureText(next).width <= maxWidth || !line.trim()) { line = next; continue; }
    lines.push(line.trim());
    line = word.trimStart();
  }
  if (line.trim()) lines.push(line.trim());
  // A single word wider than the line: break it by characters.
  return lines.flatMap(l => {
    if (ctx.measureText(l).width <= maxWidth) return [l];
    const parts: string[] = []; let part = "";
    for (const ch of Array.from(l)) { if (ctx.measureText(part + ch).width > maxWidth && part) { parts.push(part); part = ch; } else part += ch; }
    return part ? [...parts, part] : parts;
  });
}

const FONT = "'Anuphan', 'Noto Sans Thai', sans-serif";

/** Loads the cover font so the first preview is not drawn with a fallback font. */
export async function loadCoverFonts(): Promise<void> {
  try { await Promise.all([document.fonts.load(`700 64px ${FONT}`), document.fonts.load(`600 28px ${FONT}`)]); } catch { /* fall back to system fonts */ }
}

/** Draws one cover at full size onto `canvas`. */
export function drawCover(canvas: HTMLCanvasElement, template: Template, options: CoverOptions) {
  canvas.width = COVER_WIDTH;
  canvas.height = COVER_HEIGHT;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, COVER_WIDTH, COVER_HEIGHT);

  if (options.photo) {
    // object-fit: cover
    const img = options.photo;
    const scale = Math.max(COVER_WIDTH / img.naturalWidth, COVER_HEIGHT / img.naturalHeight);
    const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
    ctx.drawImage(img, (COVER_WIDTH - w) / 2, (COVER_HEIGHT - h) / 2, w, h);
    ctx.fillStyle = template.overlay;
    ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
  } else {
    template.background(ctx);
  }

  const title = options.title.trim() || "หัวข้อบทความ";
  const maxWidth = COVER_WIDTH - 220;
  // Largest size that fits in three lines; anything longer is cut with "…".
  let size = 72, lines: string[] = [];
  for (; size >= 44; size -= 4) {
    ctx.font = `700 ${size}px ${FONT}`;
    lines = wrap(ctx, title, maxWidth);
    if (lines.length <= 3) break;
  }
  // Balance the lines: the narrowest width that keeps the same number of lines, so the last line
  // is not a single short word.
  if (lines.length > 1 && lines.length <= 3) {
    let lo = maxWidth * 0.4, hi = maxWidth;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (wrap(ctx, title, mid).length <= lines.length) hi = mid; else lo = mid;
    }
    lines = wrap(ctx, title, hi);
  }
  if (lines.length > 3) {
    lines = lines.slice(0, 3);
    let last = lines[2];
    while (last && ctx.measureText(last + "…").width > maxWidth) last = Array.from(last).slice(0, -1).join("");
    lines[2] = last + "…";
  }
  const lineHeight = size * 1.35;
  const label = options.label?.trim();
  const labelGap = label ? 64 : 0;
  const blockHeight = labelGap + lines.length * lineHeight;
  let y = (COVER_HEIGHT - blockHeight) / 2 - (options.brand ? 14 : 0);

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  if (label) {
    ctx.font = `600 28px ${FONT}`;
    ctx.fillStyle = template.label;
    ctx.fillText(label.toUpperCase().slice(0, 60), COVER_WIDTH / 2, y);
    y += labelGap;
  }
  ctx.font = `700 ${size}px ${FONT}`;
  ctx.fillStyle = template.title;
  // A soft shadow keeps the title readable over photos.
  if (options.photo) { ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = 12; }
  for (const line of lines) { ctx.fillText(line, COVER_WIDTH / 2, y); y += lineHeight; }
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
  template.accent?.(ctx, y - lineHeight + size);

  if (options.brand) {
    ctx.font = `600 26px ${FONT}`;
    ctx.fillStyle = template.label;
    ctx.textBaseline = "bottom";
    ctx.fillText("NetPrime", COVER_WIDTH / 2, COVER_HEIGHT - 40);
  }
}

/** The finished cover as a JPEG file, ready for the image upload. */
export function coverFile(canvas: HTMLCanvasElement, slug: string): Promise<File> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (!blob) return reject(new Error("สร้างรูปหน้าปกไม่สำเร็จ"));
    resolve(new File([blob], `${slug || "cover"}.jpg`, { type: "image/jpeg" }));
  }, "image/jpeg", 0.9));
}
