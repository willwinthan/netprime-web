import test from "node:test";
import assert from "node:assert/strict";
import {
  COVER_H, COVER_LIMITS, COVER_PALETTES, COVER_TEMPLATES, COVER_W, STOCK_COVERS, clipText, findPalette, findTemplate,
  fitImage, fitTitle, hashString, normalizeCoverSpec, seededRandom, suggestStockCover, wrapText
} from "../frontend-admin/src/components/instructor/coverLayout.ts";

const mono = (s) => s.length * 10;

test("registry: unique ids, hex colours, fallbacks", () => {
  for (const list of [COVER_TEMPLATES, COVER_PALETTES, STOCK_COVERS]) assert.equal(new Set(list.map(x => x.id)).size, list.length);
  for (const p of COVER_PALETTES) for (const k of ["dark", "mid", "accent", "accent2"]) assert.match(p[k], /^#[0-9a-f]{6}$/i);
  assert.equal(findPalette("nope").id, COVER_PALETTES[0].id);
  assert.equal(findTemplate("nope").id, COVER_TEMPLATES[0].id);
  for (const s of STOCK_COVERS) assert.match(s.url, /^https:\/\/images\.unsplash\.com\//);
});

test("normalizeCoverSpec trims, clamps and falls back", () => {
  const s = normalizeCoverSpec({ title: "  a   b  ", subtitle: "x".repeat(200), badge: "y".repeat(99), showBrand: false });
  assert.equal(s.title, "a b");
  assert.equal(Array.from(s.subtitle).length, COVER_LIMITS.subtitle);
  assert.equal(Array.from(s.badge).length, COVER_LIMITS.badge);
  assert.equal(s.showBrand, false);
  assert.equal(normalizeCoverSpec({ title: "   " }, "คอร์ส CCNA").title, "คอร์ส CCNA");
  assert.equal(normalizeCoverSpec({}).title, "ชื่อคอร์ส");
  assert.equal(normalizeCoverSpec({}).showBrand, true);
});

test("clipText does not split Thai combining marks", () => {
  const out = clipText("กิ่งก้านสาขา", 3);
  assert.equal(out, "กิ่งก้");
  assert.ok(!/^[\u0e30-\u0e4e]/.test(clipText("กิ่งก้านสาขา", 2).slice(-1)));
  assert.equal(clipText("abc", 5), "abc");
});

test("wrapText wraps, breaks long words and truncates with ellipsis", () => {
  assert.deepEqual(wrapText("aaa bbb ccc", 70, mono, 3).lines, ["aaa bbb", "ccc"]);
  const long = wrapText("x".repeat(25), 100, mono, 5);
  assert.ok(long.lines.length >= 3 && long.lines.every(l => mono(l) <= 100));
  const cut = wrapText("one two three four five six", 70, mono, 2);
  assert.equal(cut.truncated, true);
  assert.equal(cut.lines.length, 2);
  assert.ok(cut.lines[1].endsWith("…") && mono(cut.lines[1]) <= 70);
  const thai = wrapText("เครือข่ายคอมพิวเตอร์เบื้องต้นสำหรับมือใหม่", 200, mono, 4);
  assert.ok(thai.lines.length > 1 && thai.lines.every(l => mono(l) <= 200));
});

test("fitTitle picks the largest size that fits, shrinks long titles", () => {
  const at = size => s => s.length * size * 0.6;
  const short = fitTitle("CCNA", 700, 400, at);
  assert.equal(short.size, 84);
  const long = fitTitle("Network Automation with Python and Ansible for Enterprise", 700, 400, at);
  assert.ok(long.size < 84 && long.lines.length <= 3);
  const huge = fitTitle("word ".repeat(80), 700, 200, at);
  assert.equal(huge.size, 44);
  assert.equal(huge.truncated, true);
});

test("fitImage crop fills and contain shows everything", () => {
  const wide = fitImage(2000, 500, "crop");
  assert.ok(wide.dw >= COVER_W && wide.dh >= COVER_H - 1e-6);
  assert.ok(Math.abs(wide.dx - (COVER_W - wide.dw) / 2) < 1e-6);
  assert.ok(fitImage(2000, 500, "crop", 0, 0).dx === 0);
  assert.ok(fitImage(2000, 500, "crop", 1, 1).dx + wide.dw === COVER_W);
  const tall = fitImage(500, 2000, "contain");
  assert.ok(tall.dw <= COVER_W && tall.dh <= COVER_H + 1e-6);
  assert.ok(Math.abs(tall.dx + tall.dw / 2 - COVER_W / 2) < 1e-6);
  assert.deepEqual(fitImage(0, 0, "crop"), { dx: 0, dy: 0, dw: COVER_W, dh: COVER_H });
  assert.equal(fitImage(100, 100, "crop", NaN, 2).dy <= 0, true);
});

test("seededRandom is deterministic and in [0,1)", () => {
  const a = seededRandom(hashString("x")), b = seededRandom(hashString("x")), c = seededRandom(hashString("y"));
  const xs = Array.from({ length: 20 }, a);
  assert.deepEqual(xs, Array.from({ length: 20 }, b));
  assert.notDeepEqual(xs, Array.from({ length: 20 }, c));
  assert.ok(xs.every(n => n >= 0 && n < 1));
});

test("suggestStockCover matches keywords, else generic", () => {
  assert.equal(suggestStockCover("Cisco CCNA 200-301").id, "cisco");
  assert.equal(suggestStockCover("AWS Cloud Practitioner").id, "cloud");
  assert.equal(suggestStockCover("Fortinet NSE4").id, "security");
  assert.equal(suggestStockCover("อะไรก็ไม่รู้").id, "network");
});
