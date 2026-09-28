#!/usr/bin/env node
// Regenerate the artwork of the built-in `endfield` and `endfield-wuling` themes:
//   themes/<id>/wallpaper.svg  contour terrain from the dsh-theme-endfield kernel, frozen at phase 0
//   themes/<id>/logo.svg       the END / FIELD boot wordmark, typeset like that theme's loader plate
//
//   node scripts/build-endfield.mjs [--seed <n>]
//
// The output is committed; this only needs to run again to change the art.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seedIndex = process.argv.indexOf("--seed");
const SEED = seedIndex >= 0 ? Number(process.argv[seedIndex + 1]) >>> 0 : 0x5eed1e1d;

// No ENDFIELD watermark: upstream centres it on the DSH headline, but a wallpaper cannot follow
// the layout and a fixed one collides with the Z mark on ZCode's new-task page.
//
// The kernel sizes its islands off min(w, h); 1600x900 matches the density of the reference
// screenshots on a typical window. Stroke width is pinned in screen px, so scaling stays 1px.
const W = 1600;
const H = 900;

const THEMES = [
  {
    id: "endfield",
    paper: "#101110",
    accent: "#fff500",
    // Upstream's composited-contrast-tuned strokes are for an opaque page; Canvas lays the UI
    // over the wallpaper at glass.opacity, which washes them out, so they are raised to match.
    stroke: { color: "#fff500", opacity: 0.26 },
  },
  {
    id: "endfield-wuling",
    paper: "#e8e8e2",
    accent: "#14d0d0",
    stroke: { color: "#14d0d0", opacity: 0.6 },
  },
];

/** Raw marching-squares polylines ([x0, y0, x1, y1, ...]) from the upstream kernel. */
function extract(seed) {
  const sandbox = { contourSeed: seed, contourLineCv: null, contourStroke: () => "#000", out: null };
  const kernel = readFileSync(join(root, "scripts", "endfield", "contour-kernel.js"), "utf8");
  vm.runInNewContext(`${kernel}\ncontourBuild(${W}, ${H}); contourExtract(0); out = contourPaths;`, sandbox);
  return sandbox.out.map((path) => {
    const points = [];
    for (let k = 0; k < path.length; k += 2) points.push([path[k], path[k + 1]]);
    return points;
  });
}

const isClosed = (p) => (p[0][0] - p[p.length - 1][0]) ** 2 + (p[0][1] - p[p.length - 1][1]) ** 2 < 4;

/** Upstream's three Chaikin passes (contourDrawLines → smoothPath). Closed rings drop the seam point. */
function chaikin(source, closed) {
  let points = closed ? source.slice(0, -1) : source;
  for (let pass = 0; pass < 3; pass++) {
    const next = closed ? [] : [points[0]];
    const limit = closed ? points.length : points.length - 1;
    for (let k = 0; k < limit; k++) {
      const [a, b] = [points[k], points[(k + 1) % points.length]];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) next.push(points[points.length - 1]);
    points = next;
  }
  return points;
}

/**
 * Douglas-Peucker. Upstream never needs this because it redraws every frame; a static SVG of the
 * smoothed paths is ~3 MB, and 0.3 px of deviation is invisible under a 1 px stroke.
 */
function simplify(points, epsilon = 0.3) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [ax, ay] = points[i];
    const [bx, by] = points[j];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let worst = -1;
    let index = -1;
    for (let k = i + 1; k < j; k++) {
      const dist = Math.abs((bx - ax) * (ay - points[k][1]) - (ax - points[k][0]) * (by - ay)) / len;
      if (dist > worst) [worst, index] = [dist, k];
    }
    if (worst > epsilon) {
      keep[index] = 1;
      stack.push([i, index], [index, j]);
    }
  }
  return points.filter((_, k) => keep[k]);
}

/** Upstream's capped Catmull-Rom cubic (contourDrawLines → drawSmoothPath), as relative SVG commands. */
function toPathData(points, closed) {
  const f = (n) => {
    const s = String(Math.round(n * 10) / 10);
    return s.startsWith("-0.") ? `-${s.slice(2)}` : s.startsWith("0.") ? s.slice(1) : s;
  };
  const count = points.length;
  const at = (i) => points[closed ? (i + count) % count : Math.max(0, Math.min(count - 1, i))];
  const tangent = (i) => {
    const [c, p, n] = [at(i), at(i - 1), at(i + 1)];
    const inLen = Math.hypot(c[0] - p[0], c[1] - p[1]);
    const outLen = Math.hypot(n[0] - c[0], n[1] - c[1]);
    let tx, ty, cap;
    if (!closed && i === 0) [tx, ty, cap] = [(n[0] - c[0]) * 0.4, (n[1] - c[1]) * 0.4, outLen * 0.55];
    else if (!closed && i === count - 1) [tx, ty, cap] = [(c[0] - p[0]) * 0.4, (c[1] - p[1]) * 0.4, inLen * 0.55];
    else [tx, ty, cap] = [(n[0] - p[0]) * 0.32, (n[1] - p[1]) * 0.32, Math.min(inLen, outLen) * 0.62];
    const len = Math.hypot(tx, ty);
    return len > cap && len > 0 ? [(tx * cap) / len, (ty * cap) / len] : [tx, ty];
  };
  // Relative coordinates are rounded against the rounded pen position so errors do not accumulate.
  const r = (n) => Math.round(n * 10) / 10;
  let [px, py] = [r(points[0][0]), r(points[0][1])];
  let d = `M${f(px)} ${f(py)}c`;
  const segments = closed ? count : count - 1;
  const parts = [];
  for (let k = 0; k < segments; k++) {
    const [s, e] = [at(k), at(k + 1)];
    const [st, et] = [tangent(k), tangent(k + 1)];
    const [x1, y1, x2, y2, x, y] = [s[0] + st[0], s[1] + st[1], e[0] - et[0], e[1] - et[1], e[0], e[1]].map(r);
    parts.push([x1 - px, y1 - py, x2 - px, y2 - py, x - px, y - py].map((v) => r(v)));
    [px, py] = [x, y];
  }
  d += parts
    .map((v) => v.map(f).join(" "))
    .join(" ")
    .replace(/ -/g, "-");
  return closed ? `${d}z` : d;
}

function contourPaths(seed) {
  return extract(seed)
    .filter((p) => p.length > 1)
    .map((raw) => {
      const closed = isClosed(raw);
      const smooth = raw.length < 3 ? raw : chaikin(raw, closed);
      if (!closed) return toPathData(simplify(smooth), false);
      // A ring's endpoints coincide, which gives Douglas-Peucker no baseline: split at the far side.
      let far = 0;
      smooth.forEach((p, k) => {
        if (Math.hypot(p[0] - smooth[0][0], p[1] - smooth[0][1]) > Math.hypot(smooth[far][0] - smooth[0][0], smooth[far][1] - smooth[0][1])) far = k;
      });
      const ring = [...simplify(smooth.slice(0, far + 1)), ...simplify([...smooth.slice(far), smooth[0]]).slice(1, -1)];
      return toPathData(ring, true);
    })
    .join("");
}

function wallpaper(theme, paths) {
  const { paper, stroke } = theme;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">
<rect width="${W}" height="${H}" fill="${paper}"/>
<path fill="none" stroke="${stroke.color}" stroke-opacity="${stroke.opacity}" stroke-width="1" stroke-linejoin="round" vector-effect="non-scaling-stroke" d="${paths}"/>
</svg>
`;
}

// Loader plate typesetting from dsh-theme-endfield client.js, with the wordmark size (--edge-word)
// fixed at 100 units: kicker, END / FIELD, chevrons + sub lines + progress squares, tagline.
function logo(theme) {
  const ink = "#f5f5f0";
  const word = 100;
  const x = 52;
  const squares = Array.from({ length: 6 }, (_, i) => {
    const on = i < 4;
    return `<rect x="${x + i * 15.5}" y="302" width="11.5" height="5" fill="${on ? theme.accent : "#2e302d"}"/>`;
  }).join("");
  const chevron = (y) =>
    `<path d="M${x - 16} ${y}l-5 5 5 5" fill="none" stroke="${theme.accent}" stroke-width="2.8" transform="rotate(-90 ${x - 21} ${y + 5})"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 380">
<g font-family="Arial, Helvetica Neue, sans-serif" fill="${ink}">
<text x="${x}" y="46" font-size="15.5" font-weight="600" letter-spacing="4" fill-opacity="0.95">ZCODE</text>
<text x="${x - 5.5}" y="${60 + word * 0.72}" font-size="${word}" font-weight="900" letter-spacing="1">END</text>
<text x="${x - 5.5}" y="${60 + word * 1.52}" font-size="${word}" font-weight="900" letter-spacing="1">FIELD</text>
${chevron(252)}${chevron(261)}
<text x="${x}" y="263" font-size="13.5" font-weight="500" letter-spacing="1.6" fill="#8a8d88">EDGE INTELLIGENCE THEME</text>
<text x="${x}" y="289" font-size="12.5" font-weight="500" textLength="300" lengthAdjust="spacing" fill="#6a6d64">TERRA RESEARCH COMMISSION / BOOT SEQUENCE</text>
${squares}
<text x="${x}" y="352" font-family="Arial Narrow, Arial, sans-serif" font-size="30" font-weight="500" textLength="318" lengthAdjust="spacingAndGlyphs">OVER THE FRONTIER / INTO THE FRONT</text>
</g>
</svg>
`;
}

const paths = contourPaths(SEED);
for (const theme of THEMES) {
  const dir = join(root, "themes", theme.id);
  writeFileSync(join(dir, "wallpaper.svg"), wallpaper(theme, paths));
  writeFileSync(join(dir, "logo.svg"), logo(theme));
}
console.log(`endfield artwork written (seed ${SEED}, ${Math.round(paths.length / 1024)} KB of path data)`);
