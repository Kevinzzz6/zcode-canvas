#!/usr/bin/env node
// Regenerate the artwork of the built-in `yorha` theme, drawn after the NieR:Automata system
// settings screen:
//   themes/yorha/wallpaper-<mode>.svg  vignetted paper, fine grid, 45° rules, arcs, dot bands,
//                                      and a faint YoRHa lockup
//   themes/yorha/logo.svg              the YoRHa lockup for the boot screen
//
//   node scripts/build-yorha.mjs [--no-emblem]
//
// The lockup embeds the YoRHa emblem from themes/yorha/emblem.svg, which is fan use of
// NieR:Automata artwork and not MIT (see NOTICE.md). An SVG loaded as an image cannot reference
// other files, so the emblem is copied into each output; --no-emblem regenerates every file
// without it, leaving only the wordmark and slogan.
//
// The output is committed; this only needs to run again to change the art.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "themes", "yorha");
const withEmblem = !process.argv.includes("--no-emblem");

// 1920x1080 keeps the bands inside the crop of a maximised 16:10 or 16:9 window under `cover`.
const W = 1920;
const H = 1080;

// Paper is bright in the middle and falls off towards the edges, as on the settings screen
// (measured #eee9c1 centre, #bdb89b corners). Ink alphas are tuned for glass.opacity 0.4.
const MODES = {
  light: {
    centre: "#eee9c1",
    mid: "#e3ddb6",
    edge: "#bdb89b",
    ink: "#403d35",
    grid: 0.05,
    rule: 0.16,
    band: 0.85,
    mark: 0.065,
  },
  dark: {
    centre: "#26231d",
    mid: "#1c1a15",
    edge: "#100e0b",
    ink: "#d8d2b4",
    grid: 0.035,
    rule: 0.1,
    band: 0.55,
    mark: 0.055,
  },
};

const f = (n) => Number(n.toFixed(3));

// Line, then a 11x5 block every 77px hanging under it, with a three-dot triangle between blocks.
function band(y, m) {
  const parts = [`<path d="M0 ${y}H${W}" stroke="${m.ink}" stroke-opacity="${m.band}" stroke-width="1.5"/>`];
  const blocks = [];
  const dots = [];
  for (let x = 30; x < W; x += 77) {
    blocks.push(`M${x} ${y}h11v5h-11z`);
    const d = x + 36;
    dots.push(`M${d} ${y + 11}m-2.6 0a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0-5.2 0`);
    dots.push(`M${d + 15} ${y + 11}m-2.6 0a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0-5.2 0`);
    dots.push(`M${d + 7.5} ${y + 22}m-2.6 0a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0-5.2 0`);
  }
  parts.push(`<path d="${blocks.join("")}" fill="${m.ink}" fill-opacity="${m.band}"/>`);
  parts.push(`<path d="${dots.join("")}" fill="${m.ink}" fill-opacity="${f(m.band * 0.9)}"/>`);
  return parts.join("\n");
}

// Long 45° rules in loose families, like the construction lines behind the settings list.
const RULES = [-260, -140, 880, 1060, 1110, 1500, 1680];
function rules(m) {
  const d = RULES.map((x) => `M${x} 0l${H + 200} ${H + 200}`).join("");
  return `<path d="${d}" fill="none" stroke="${m.ink}" stroke-opacity="${m.rule}" stroke-width="1"/>`;
}

// Two big arc pairs: one sweeping from the top edge down to the left edge, one rising in the
// lower right. Circles are clipped by the canvas, so only the arcs show.
function arcs(m) {
  const c = (cx, cy, r, o) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${m.ink}" stroke-opacity="${f(m.rule * o)}" stroke-width="1"/>`;
  return [c(-40, -20, 640, 1), c(-40, -20, 660, 0.6), c(1950, 1180, 620, 1), c(1950, 1180, 646, 0.7), c(1180, 1480, 980, 0.5)].join("\n");
}

// The lockup, in units where the wordmark cap height is 100 and its width 522: emblem on top,
// wordmark 36 below it, slogan stretched to the wordmark's width. Proportions are measured
// from the in-game boot screen.
const LOCKUP = { w: 522, h: 644 };
const EMBLEM = { w: 1497, h: 1751, width: 367 };
const emblemPath = readFileSync(join(dir, "emblem.svg"), "utf8").match(/ d="([^"]+)"/)[1];

// Monoline geometric letters on a 100-unit cap height, stroke 12, butt ends clipped flat at the
// cap line and baseline. The small o and the single-storey a sit on a 61-unit x-height.
const WORDMARK = [
  "M3 -10L44.5 50L86 -10M44.5 50V110", // Y
  "M124.5 45a24.5 24.5 0 1 0 0.01 0z", // o
  "M212 0V110M206 6H245a22 22 0 0 1 0 44H212M238 50L276 110", // R
  "M324 0V110M401 0V110M324 50H401", // H
  "M491.5 45a24.5 24.5 0 1 0 0.01 0zM516 39V110", // a
].join("");
const SLOGAN_FONT = "Century Gothic, Futura, Avenir Next, Quicksand, Segoe UI, Helvetica Neue, Arial, sans-serif";

function lockup(id, ink, x, y, scale, opacity) {
  const emblemScale = EMBLEM.width / EMBLEM.w;
  const emblemHeight = EMBLEM.h * emblemScale;
  const top = withEmblem ? emblemHeight + 36 : 0;
  const emblem = withEmblem
    ? `<path transform="translate(${f((LOCKUP.w - EMBLEM.width) / 2)} 0) scale(${f(emblemScale)})" fill-rule="evenodd" d="${emblemPath}"/>\n`
    : "";
  return `<clipPath id="${id}"><rect x="-20" y="0" width="${LOCKUP.w + 40}" height="100"/></clipPath>
<g transform="translate(${x} ${y}) scale(${f(scale)})" fill="${ink}" fill-opacity="${opacity}">
${emblem}<path clip-path="url(#${id})" d="${WORDMARK}" transform="translate(0 ${top})" fill="none" stroke="${ink}" stroke-opacity="${opacity}" stroke-width="12"/>
<text x="30" y="${top + 166}" textLength="492" lengthAdjust="spacing" font-family="${SLOGAN_FONT}" font-size="50">For the Glory of Mankind</text>
</g>`;
}

// Kept inside the area that survives `cover` cropping from 3:2 to 19:10 windows (x 150..1770),
// between 36% and 74% of the height: clear of the Z mark ZCode centres at the top of the new-task
// page and of the composer pinned to the bottom, which covers more of the wallpaper the shorter
// the window.
function watermark(m) {
  const scale = 400 / LOCKUP.h;
  const y = withEmblem ? 390 : 390 + 464 * scale;
  return lockup("wm", m.ink, 1720 - LOCKUP.w * scale, y, scale, m.mark);
}

function wallpaper(m) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">
<defs>
<radialGradient id="paper" cx="0.55" cy="0.45" r="0.78">
<stop offset="0" stop-color="${m.centre}"/>
<stop offset="0.55" stop-color="${m.mid}"/>
<stop offset="1" stop-color="${m.edge}"/>
</radialGradient>
<pattern id="grid" width="6" height="6" patternUnits="userSpaceOnUse">
<path d="M6 0H0V6" fill="none" stroke="${m.ink}" stroke-opacity="${m.grid}" stroke-width="1"/>
</pattern>
</defs>
<rect width="${W}" height="${H}" fill="url(#paper)"/>
<rect width="${W}" height="${H}" fill="url(#grid)"/>
${rules(m)}
${arcs(m)}
${watermark(m)}
${band(64, m)}
${band(H - 58, m)}
</svg>
`;
}

// The boot screen's lockup: dim grey on the dark grid set by startup.background in theme.json,
// as on the in-game loading screen. Square viewBox because the startup box is square.
function logo() {
  const size = 700;
  const h = withEmblem ? LOCKUP.h : LOCKUP.h - 464;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
${lockup("lg", "#4a4943", (size - LOCKUP.w) / 2, (size - h) / 2, 1, 1)}
</svg>
`;
}

mkdirSync(dir, { recursive: true });
for (const [mode, m] of Object.entries(MODES)) writeFileSync(join(dir, `wallpaper-${mode}.svg`), wallpaper(m));
writeFileSync(join(dir, "logo.svg"), logo());
console.log(`wrote ${dir}${withEmblem ? "" : " (without emblem)"}`);
