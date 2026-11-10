/**
 * Course cover: canvas drawing for the ready-made templates, and for fitting an instructor's own photo
 * to the 16:9 cover. All drawing uses the logical 1280x720 space of coverLayout.ts; previews scale the
 * context. The layout maths (wrapping, fitting) is in coverLayout.ts, which has the unit tests.
 */
import {
  COVER_H, COVER_W, findPalette, findTemplate, fitImage, fitTitle, hashString, normalizeCoverSpec, seededRandom
} from "./coverLayout";
import type { CoverMode, CoverPalette, CoverSpec } from "./coverLayout";

type Ctx = CanvasRenderingContext2D;
type Rand = () => number;

const FONT = '"Anuphan", "Inter", system-ui, -apple-system, sans-serif';
const MONO = 'ui-monospace, "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace';

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const alpha = (hex: string, a: number) => { const [r, g, b] = rgb(hex); return `rgba(${r},${g},${b},${a})`; };
/** Readable text colour on top of `hex`. */
const onColor = (hex: string) => { const [r, g, b] = rgb(hex); return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#111827" : "#ffffff"; };

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function gradientBg(ctx: Ctx, p: CoverPalette, vertical = false) {
  const g = vertical ? ctx.createLinearGradient(0, 0, 0, COVER_H) : ctx.createLinearGradient(0, 0, COVER_W, COVER_H);
  g.addColorStop(0, p.mid);
  g.addColorStop(1, p.dark);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, COVER_W, COVER_H);
}

/** Fade from the background colour on the left so text stays readable over patterns. */
function textScrim(ctx: Ctx, color: string, width: number, from = 0.88) {
  const g = ctx.createLinearGradient(0, 0, width, 0);
  g.addColorStop(0, alpha(color, from));
  g.addColorStop(0.7, alpha(color, from * 0.55));
  g.addColorStop(1, alpha(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, COVER_H);
}

interface TextBox { x: number; y: number; w: number; h: number; align: "left" | "center" }
interface TextColors { title: string; sub: string; badgeBg: string; badgeText: string }
interface TextOpts { prompt?: string; promptColor?: string; subtitlePrefix?: string; cursorColor?: string }

/** Badge, title (auto-sized, wrapped) and subtitle, vertically centred in `box`. */
function drawTextBlock(ctx: Ctx, spec: CoverSpec, box: TextBox, colors: TextColors, opts: TextOpts = {}) {
  const badgeH = spec.badge ? 46 : 0;
  const badgeGap = spec.badge ? 28 : 0;
  const subH = spec.subtitle ? 40 : 0;
  const subGap = spec.subtitle ? 26 : 0;
  const promptW = opts.prompt ? 58 : 0;
  const innerW = box.w - promptW;
  const fit = fitTitle(spec.title, innerW, box.h - badgeH - badgeGap - subH - subGap, size => {
    ctx.font = `800 ${size}px ${FONT}`;
    return s => ctx.measureText(s).width;
  });
  const titleH = fit.lines.length * fit.size * fit.lineHeight;
  let y = box.y + (box.h - (badgeH + badgeGap + titleH + subGap + subH)) / 2;
  const centered = box.align === "center";
  const left = box.x + promptW;
  const anchorX = centered ? box.x + box.w / 2 : left;

  ctx.textBaseline = "middle";
  if (spec.badge) {
    ctx.font = `700 24px ${FONT}`;
    ctx.textAlign = "left";
    const bw = ctx.measureText(spec.badge).width + 44;
    const bx = centered ? anchorX - bw / 2 : box.x;
    roundRect(ctx, bx, y, bw, badgeH, badgeH / 2);
    ctx.fillStyle = colors.badgeBg;
    ctx.fill();
    ctx.fillStyle = colors.badgeText;
    ctx.fillText(spec.badge, bx + 22, y + badgeH / 2 + 1);
    y += badgeH + badgeGap;
  }

  ctx.font = `800 ${fit.size}px ${FONT}`;
  ctx.textAlign = centered ? "center" : "left";
  ctx.fillStyle = colors.title;
  const step = fit.size * fit.lineHeight;
  fit.lines.forEach((line, i) => ctx.fillText(line, anchorX, y + i * step + step / 2));
  if (opts.prompt) {
    ctx.font = `700 ${fit.size}px ${MONO}`;
    ctx.textAlign = "left";
    ctx.fillStyle = opts.promptColor ?? colors.badgeBg;
    ctx.fillText(opts.prompt, box.x, y + step / 2);
  }
  if (opts.cursorColor) {
    ctx.font = `800 ${fit.size}px ${FONT}`;
    const lastW = ctx.measureText(fit.lines[fit.lines.length - 1] ?? "").width;
    const cy = y + (fit.lines.length - 1) * step;
    ctx.fillStyle = opts.cursorColor;
    ctx.fillRect(left + lastW + 14, cy + step * 0.18, Math.max(16, fit.size * 0.42), step * 0.64);
  }
  y += titleH + subGap;

  if (spec.subtitle) {
    ctx.font = `500 30px ${FONT}`;
    ctx.textAlign = centered ? "center" : "left";
    ctx.fillStyle = colors.sub;
    ctx.fillText(`${opts.subtitlePrefix ?? ""}${spec.subtitle}`, anchorX, y + subH / 2);
  }
  ctx.textAlign = "left";
}

function drawBrand(ctx: Ctx, color: string, x: number, y: number, align: "left" | "right") {
  ctx.font = `800 30px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText("netprime", x, y);
  ctx.textAlign = "left";
}

const lightColors = (p: CoverPalette): TextColors => ({ title: "#ffffff", sub: alpha("#ffffff", 0.78), badgeBg: p.accent, badgeText: onColor(p.accent) });

type TemplateDrawer = (ctx: Ctx, spec: CoverSpec, p: CoverPalette, rand: Rand) => void;

const circuit: TemplateDrawer = (ctx, spec, p, rand) => {
  gradientBg(ctx, p);
  ctx.strokeStyle = alpha(p.accent, 0.07);
  ctx.lineWidth = 1;
  for (let x = 0; x <= COVER_W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, COVER_H); ctx.stroke(); }
  for (let y = 0; y <= COVER_H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(COVER_W, y); ctx.stroke(); }
  for (let i = 0; i < 16; i++) {
    let x = 560 + Math.floor(rand() * 18) * 40;
    let y = Math.floor(rand() * 18) * 40;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const turns = 3 + Math.floor(rand() * 3);
    for (let t = 0; t < turns; t++) {
      const len = (1 + Math.floor(rand() * 4)) * 40;
      if (t % 2 === 0) x += rand() < 0.35 ? -len : len; else y += rand() < 0.5 ? -len : len;
      x = Math.min(COVER_W - 20, Math.max(420, x));
      y = Math.min(COVER_H - 20, Math.max(20, y));
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = alpha(p.accent, 0.42);
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = p.accent2;
    ctx.fill();
  }
  textScrim(ctx, p.dark, 920);
  ctx.fillStyle = p.accent;
  ctx.fillRect(64, 150, 10, 420);
  drawTextBlock(ctx, spec, { x: 110, y: 90, w: 760, h: 520, align: "left" }, lightColors(p));
  if (spec.showBrand) drawBrand(ctx, alpha("#ffffff", 0.7), 1216, 664, "right");
};

const nodes: TemplateDrawer = (ctx, spec, p, rand) => {
  gradientBg(ctx, p);
  const pts = Array.from({ length: 46 }, () => ({ x: 380 + rand() * 900, y: rand() * COVER_H, r: 3 + rand() * 6 }));
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d < 230) {
        ctx.strokeStyle = alpha(p.accent, (1 - d / 230) * 0.55);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[j].x, pts[j].y);
        ctx.stroke();
      }
    }
  }
  for (const n of pts) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r + 6, 0, Math.PI * 2);
    ctx.fillStyle = alpha(p.accent, 0.16);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = p.accent2;
    ctx.fill();
  }
  textScrim(ctx, p.dark, 900, 0.82);
  drawTextBlock(ctx, spec, { x: 100, y: 90, w: 740, h: 540, align: "left" }, lightColors(p));
  if (spec.showBrand) drawBrand(ctx, alpha("#ffffff", 0.7), 100, 664, "left");
};

const terminal: TemplateDrawer = (ctx, spec, p) => {
  ctx.fillStyle = p.dark;
  ctx.fillRect(0, 0, COVER_W, COVER_H);
  const glow = ctx.createRadialGradient(COVER_W, 0, 0, COVER_W, 0, 700);
  glow.addColorStop(0, alpha(p.accent, 0.28));
  glow.addColorStop(1, alpha(p.accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, COVER_W, COVER_H);
  roundRect(ctx, 60, 56, 1160, 608, 24);
  ctx.fillStyle = alpha(p.mid, 0.92);
  ctx.fill();
  ctx.strokeStyle = alpha(p.accent, 0.4);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.save();
  roundRect(ctx, 60, 56, 1160, 608, 24);
  ctx.clip();
  ctx.fillStyle = alpha("#ffffff", 0.06);
  ctx.fillRect(60, 56, 1160, 66);
  ctx.restore();
  ["#ff5f56", "#ffbd2e", "#27c93f"].forEach((c, i) => { ctx.beginPath(); ctx.arc(104 + i * 34, 89, 9, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill(); });
  ctx.font = `500 22px ${MONO}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillStyle = alpha("#ffffff", 0.45);
  ctx.fillText("~/netprime/courses", COVER_W / 2, 90);
  ctx.textAlign = "left";
  drawTextBlock(ctx, spec, { x: 112, y: 150, w: 1060, h: 440, align: "left" }, lightColors(p), {
    prompt: "$", promptColor: p.accent, subtitlePrefix: "# ", cursorColor: p.accent
  });
  if (spec.showBrand) drawBrand(ctx, alpha("#ffffff", 0.6), 1172, 628, "right");
};

const wave: TemplateDrawer = (ctx, spec, p) => {
  gradientBg(ctx, p, true);
  const layers = [{ base: 500, amp: 44, period: 190, phase: 0.4 }, { base: 560, amp: 38, period: 150, phase: 2.1 }, { base: 620, amp: 30, period: 120, phase: 4.2 }];
  layers.forEach((l, k) => {
    ctx.beginPath();
    ctx.moveTo(0, COVER_H);
    for (let x = 0; x <= COVER_W; x += 8) ctx.lineTo(x, l.base + l.amp * Math.sin(x / l.period + l.phase));
    ctx.lineTo(COVER_W, COVER_H);
    ctx.closePath();
    ctx.fillStyle = alpha(p.accent, 0.16 + k * 0.12);
    ctx.fill();
    if (k === 0) {
      ctx.beginPath();
      for (let x = 0; x <= COVER_W; x += 8) { const y = l.base + l.amp * Math.sin(x / l.period + l.phase); if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.strokeStyle = alpha(p.accent2, 0.7);
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  });
  drawTextBlock(ctx, spec, { x: 100, y: 70, w: 880, h: 420, align: "left" }, lightColors(p));
  if (spec.showBrand) drawBrand(ctx, alpha("#ffffff", 0.85), 1180, 666, "right");
};

const block: TemplateDrawer = (ctx, spec, p) => {
  ctx.fillStyle = p.dark;
  ctx.fillRect(0, 0, COVER_W, COVER_H);
  ctx.save();
  ctx.translate(1010, 340);
  ctx.rotate((12 * Math.PI) / 180);
  roundRect(ctx, -210, -210, 420, 420, 56);
  ctx.fillStyle = p.accent;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(860, 540, 150, 0, Math.PI * 2);
  ctx.fillStyle = alpha(p.accent2, 0.92);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(1150, 120, 68, 0, Math.PI * 2);
  ctx.strokeStyle = p.accent2;
  ctx.lineWidth = 16;
  ctx.stroke();
  ctx.fillStyle = alpha("#ffffff", 0.14);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { ctx.beginPath(); ctx.arc(980 + i * 34, 520 + j * 34, 5, 0, Math.PI * 2); ctx.fill(); }
  drawTextBlock(ctx, spec, { x: 90, y: 90, w: 740, h: 540, align: "left" }, lightColors(p));
  if (spec.showBrand) drawBrand(ctx, alpha("#ffffff", 0.7), 90, 664, "left");
};

const split: TemplateDrawer = (ctx, spec, p) => {
  const right = ctx.createLinearGradient(640, 0, COVER_W, COVER_H);
  right.addColorStop(0, p.accent);
  right.addColorStop(1, p.accent2);
  ctx.fillStyle = right;
  ctx.fillRect(0, 0, COVER_W, COVER_H);
  ctx.strokeStyle = alpha("#ffffff", 0.22);
  ctx.lineWidth = 3;
  for (let r = 90; r <= 330; r += 60) { ctx.beginPath(); ctx.arc(1060, 360, r, 0, Math.PI * 2); ctx.stroke(); }
  ctx.fillStyle = alpha("#ffffff", 0.35);
  ctx.beginPath();
  ctx.arc(1060, 360, 14, 0, Math.PI * 2);
  ctx.fill();
  const left = ctx.createLinearGradient(0, 0, 820, COVER_H);
  left.addColorStop(0, p.mid);
  left.addColorStop(1, p.dark);
  ctx.fillStyle = left;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(840, 0);
  ctx.lineTo(660, COVER_H);
  ctx.lineTo(0, COVER_H);
  ctx.closePath();
  ctx.fill();
  drawTextBlock(ctx, spec, { x: 90, y: 90, w: 600, h: 540, align: "left" }, lightColors(p));
  if (spec.showBrand) drawBrand(ctx, onColor(p.accent2) === "#ffffff" ? alpha("#ffffff", 0.9) : alpha("#111827", 0.75), 1216, 664, "right");
};

const spotlight: TemplateDrawer = (ctx, spec, p, rand) => {
  ctx.fillStyle = p.dark;
  ctx.fillRect(0, 0, COVER_W, COVER_H);
  const glow = ctx.createRadialGradient(COVER_W / 2, COVER_H / 2, 0, COVER_W / 2, COVER_H / 2, 620);
  glow.addColorStop(0, alpha(p.accent, 0.55));
  glow.addColorStop(0.55, alpha(p.accent, 0.14));
  glow.addColorStop(1, alpha(p.accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, COVER_W, COVER_H);
  for (let i = 0; i < 46; i++) {
    ctx.beginPath();
    ctx.arc(rand() * COVER_W, rand() * COVER_H, 1 + rand() * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = alpha("#ffffff", 0.2 + rand() * 0.45);
    ctx.fill();
  }
  ctx.strokeStyle = alpha(p.accent2, 0.35);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(COVER_W / 2, COVER_H / 2, 330, 0, Math.PI * 2);
  ctx.stroke();
  drawTextBlock(ctx, spec, { x: 160, y: 110, w: 960, h: 500, align: "center" }, lightColors(p));
  if (spec.showBrand) drawBrand(ctx, alpha("#ffffff", 0.65), COVER_W / 2 + 60, 668, "right");
};

const minimal: TemplateDrawer = (ctx, spec, p) => {
  const accent = p.id === "slate" ? "#334155" : p.accent;
  const accent2 = p.id === "slate" ? "#64748b" : p.accent2;
  const bg = ctx.createLinearGradient(0, 0, COVER_W, COVER_H);
  bg.addColorStop(0, "#ffffff");
  bg.addColorStop(1, "#f1f5f9");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, COVER_W, COVER_H);
  ctx.beginPath();
  ctx.arc(1110, 190, 270, 0, Math.PI * 2);
  ctx.fillStyle = alpha(accent, 0.1);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(1010, 570, 190, 0, Math.PI * 2);
  ctx.fillStyle = alpha(accent2, 0.18);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(1180, 560, 70, 0, Math.PI * 2);
  ctx.strokeStyle = alpha(accent, 0.45);
  ctx.lineWidth = 10;
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, COVER_W, 18);
  ctx.fillRect(100, 150, 90, 8);
  drawTextBlock(ctx, spec, { x: 100, y: 120, w: 780, h: 500, align: "left" }, {
    title: "#0f172a", sub: "#475569", badgeBg: accent, badgeText: onColor(accent)
  });
  if (spec.showBrand) drawBrand(ctx, "#64748b", 100, 668, "left");
};

const DRAWERS: Record<string, TemplateDrawer> = { circuit, nodes, terminal, wave, block, split, spotlight, minimal };

/**
 * Draw a template onto `ctx` (logical 1280x720; scale the context for a smaller preview).
 * The same inputs always give the same picture.
 */
export function drawCoverTemplate(ctx: Ctx, templateId: string, paletteId: string, input: Partial<CoverSpec>, fallbackTitle?: string) {
  const spec = normalizeCoverSpec(input, fallbackTitle);
  const palette = findPalette(paletteId);
  const info = findTemplate(templateId);
  const rand = seededRandom(hashString(`${info.id}|${spec.title}`));
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, COVER_W, COVER_H);
  ctx.clip();
  (DRAWERS[info.id] ?? circuit)(ctx, spec, palette, rand);
  ctx.restore();
}

export type PhotoSource = CanvasImageSource & { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };

const sourceSize = (src: PhotoSource): [number, number] => [src.naturalWidth || (src.width as number) || 0, src.naturalHeight || (src.height as number) || 0];

/**
 * Put an instructor's photo on the cover. "crop" fills the frame; "contain" shows the whole picture over
 * a blurred, darkened copy of itself (a tiny canvas stretched up, which blurs without ctx.filter, so it
 * also works in Safari).
 */
export function drawPhotoCover(ctx: Ctx, src: PhotoSource, mode: CoverMode, focusX = 0.5, focusY = 0.5) {
  const [sw, sh] = sourceSize(src);
  ctx.save();
  ctx.fillStyle = "#0f1115";
  ctx.fillRect(0, 0, COVER_W, COVER_H);
  ctx.imageSmoothingQuality = "high";
  if (mode === "contain") {
    const tiny = document.createElement("canvas");
    tiny.width = 32;
    tiny.height = 18;
    const t = tiny.getContext("2d");
    if (t) {
      const r = fitImage(sw, sh, "crop", focusX, focusY, 32, 18);
      t.imageSmoothingQuality = "high";
      t.drawImage(src, r.dx, r.dy, r.dw, r.dh);
      ctx.drawImage(tiny, 0, 0, COVER_W, COVER_H);
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fillRect(0, 0, COVER_W, COVER_H);
    }
    const r = fitImage(sw, sh, "contain");
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 40;
    ctx.drawImage(src, r.dx, r.dy, r.dw, r.dh);
  } else {
    const r = fitImage(sw, sh, "crop", focusX, focusY);
    ctx.drawImage(src, r.dx, r.dy, r.dw, r.dh);
  }
  ctx.restore();
}

/** Wait for the site font so the first render does not fall back to a system font. */
export async function ensureCoverFonts(): Promise<void> {
  try {
    await Promise.all(["800 64px Anuphan", "700 24px Anuphan", "500 30px Anuphan"].map(f => document.fonts.load(f, "ก")));
  } catch {
    /* the system font is an acceptable fallback */
  }
}

export function makeCoverCanvas(scale = 1): { canvas: HTMLCanvasElement; ctx: Ctx } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(COVER_W * scale);
  canvas.height = Math.round(COVER_H * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("เบราว์เซอร์นี้สร้างรูปปกไม่ได้");
  ctx.scale(scale, scale);
  return { canvas, ctx };
}

const toBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error("สร้างไฟล์รูปไม่สำเร็จ"))), "image/jpeg", 0.9));

/** Full-size JPEG of a template, ready for POST /instructor/images. */
export async function renderTemplateBlob(templateId: string, paletteId: string, spec: Partial<CoverSpec>, fallbackTitle?: string): Promise<Blob> {
  await ensureCoverFonts();
  const { canvas, ctx } = makeCoverCanvas(1);
  drawCoverTemplate(ctx, templateId, paletteId, spec, fallbackTitle);
  return toBlob(canvas);
}

/** Full-size JPEG of an instructor's photo fitted to 16:9. */
export async function renderPhotoBlob(src: PhotoSource, mode: CoverMode, focusX: number, focusY: number): Promise<Blob> {
  const { canvas, ctx } = makeCoverCanvas(1);
  drawPhotoCover(ctx, src, mode, focusX, focusY);
  return toBlob(canvas);
}

/** Decode a chosen file. Rejects when the browser cannot read it as a picture. */
export function loadImageFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("เปิดไฟล์รูปนี้ไม่ได้ ลองไฟล์ PNG หรือ JPG")); };
    img.src = url;
  });
}
