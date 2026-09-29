// Smart Palette: seed colors picked from a wallpaper, and a full ZCode token set generated from one
// seed. Pure math, no node or DOM imports: the main process resolves palettes, the sandboxed preload
// bundles the same code to extract seeds and draw variant swatches.
//
// Everything is computed in OKLCH, so "same lightness" means the same perceived lightness for every
// hue, and every token that carries text is checked against the surfaces it sits on.

export type PaletteMode = "dark" | "light";
export type PaletteVariant = "natural" | "vivid" | "soft" | "oled" | "contrast";

export const PALETTE_VARIANTS: readonly PaletteVariant[] = ["natural", "vivid", "soft", "oled", "contrast"];

export interface PaletteSpec {
  /** The color the palette is built around, `#rrggbb`. Only its hue and chroma are used. */
  seed: string;
  variant?: PaletteVariant;
  /** Average wallpaper color, `#rrggbb`. With it, text is also checked against what shows through translucent surfaces. */
  backdrop?: string | null;
}

/** What shows through the main surface in one mode, for the readability check. */
export interface PaletteBackdrop {
  /** Average wallpaper color after the wallpaper's own brightness and dim overlay, `#rrggbb`. */
  color: string;
  /** Alpha of the window frame and of the main surface on top of it, 0..1. */
  frameAlpha: number;
  mainAlpha: number;
}

export interface PaletteReadability {
  /** Lowest contrast of body text against the main surface, wallpaper included. */
  contrast: number;
  /** false when body text fell below WCAG AA (4.5:1; 7:1 for the contrast variant) even after
   *  adjusting it. Generation aims higher; this only flags what is actually hard to read. */
  ok: boolean;
}

export interface GeneratedPalette {
  colors: Record<PaletteMode, Record<string, string>>;
  readability: Record<PaletteMode, PaletteReadability | null>;
}

type Rgb = [number, number, number];
type Lch = { l: number; c: number; h: number };

const HEX = /^#[0-9a-f]{6}$/i;

export function isPaletteColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function hexToRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(clamp(c, 0, 1) * 255).toString(16).padStart(2, "0")).join("")}`;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** Björn Ottosson's OKLab, from gamma-encoded sRGB. */
function rgbToLch([r, g, b]: Rgb): Lch {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

/** Gamma-encoded sRGB, possibly out of gamut. */
function lchToRgbRaw({ l, c, h }: Lch): Rgb {
  const angle = (h * Math.PI) / 180;
  const a = c * Math.cos(angle);
  const b = c * Math.sin(angle);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ].map((v) => toGamma(Math.max(0, v))) as Rgb;
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** The color at this lightness and hue, with chroma reduced until it fits sRGB. */
function tone(l: number, c: number, h: number): Rgb {
  const lightness = clamp(l, 0, 1);
  let rgb = lchToRgbRaw({ l: lightness, c, h });
  if (inGamut(rgb)) return rgb;
  let lo = 0;
  let hi = c;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(lchToRgbRaw({ l: lightness, c: mid, h }))) lo = mid;
    else hi = mid;
  }
  rgb = lchToRgbRaw({ l: lightness, c: lo, h });
  return rgb.map((v) => clamp(v, 0, 1)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
  const la = luminance(typeof a === "string" ? hexToRgb(a) : a);
  const lb = luminance(typeof b === "string" ? hexToRgb(b) : b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Alpha compositing as the browser does it for sRGB colors: over, in gamma-encoded space. */
function over(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return top.map((c, i) => c * alpha + bottom[i]! * (1 - alpha)) as Rgb;
}

const rgba = (rgb: Rgb, alpha: number) =>
  `rgba(${rgb.map((c) => Math.round(clamp(c, 0, 1) * 255)).join(", ")}, ${Math.round(alpha * 1000) / 1000})`;

/**
 * Seed colors from a downscaled wallpaper (RGBA bytes, e.g. canvas ImageData). Hues are binned by
 * 10°, weighted by chroma so colorful areas outweigh large gray ones, and peaks at least 30° apart
 * become seeds, strongest first. A gray image yields one near-neutral seed. `average` is the mean
 * color of the image, used for the readability check behind translucent surfaces.
 */
export function extractColors(rgba: ArrayLike<number>, maxSeeds = 5): { seeds: string[]; average: string } | null {
  const bins = Array.from({ length: 36 }, () => ({ w: 0, a: 0, b: 0, c: 0 }));
  const sum: Rgb = [0, 0, 0];
  let count = 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 128) continue;
    const rgb: Rgb = [rgba[i]! / 255, rgba[i + 1]! / 255, rgba[i + 2]! / 255];
    sum[0] += rgb[0]; sum[1] += rgb[1]; sum[2] += rgb[2];
    count++;
    const { l, c, h } = rgbToLch(rgb);
    const angle = (h * Math.PI) / 180;
    sumA += c * Math.cos(angle);
    sumB += c * Math.sin(angle);
    if (c < 0.03 || l < 0.12 || l > 0.97) continue;
    const bin = bins[Math.floor(h / 10) % 36]!;
    bin.w += c;
    bin.a += c * c * Math.cos(angle);
    bin.b += c * c * Math.sin(angle);
    bin.c += c * c;
  }
  if (!count) return null;
  const average = rgbToHex(sum.map((v) => v / count) as Rgb);
  const score = bins.map((_, i) => bins[(i + 35) % 36]!.w * 0.5 + bins[i]!.w + bins[(i + 1) % 36]!.w * 0.5);
  const order = score.map((s, i) => [s, i] as const).filter(([s]) => s > 0).sort((x, y) => y[0] - x[0]);
  const top = order[0]?.[0] ?? 0;
  const seeds: string[] = [];
  const taken: number[] = [];
  // Colorful pixels must make up a noticeable share of the image before hues count at all.
  if (top > count * 0.004) {
    for (const [s, i] of order) {
      if (seeds.length >= maxSeeds || s < top * 0.06) break;
      if (taken.some((t) => Math.min(Math.abs(t - i), 36 - Math.abs(t - i)) < 3)) continue;
      taken.push(i);
      let a = 0, b = 0, w = 0, c = 0;
      for (const j of [i + 35, i, i + 1]) {
        const bin = bins[j % 36]!;
        a += bin.a; b += bin.b; c += bin.c; w += bin.w;
      }
      const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
      seeds.push(rgbToHex(tone(0.65, clamp(c / w, 0.04, 0.2), hue)));
    }
  }
  if (!seeds.length) {
    const hue = ((Math.atan2(sumB, sumA) * 180) / Math.PI + 360) % 360;
    seeds.push(rgbToHex(tone(0.65, Math.min(Math.hypot(sumA, sumB) / count, 0.02), hue)));
  }
  return { seeds, average };
}

interface Tones {
  frame: number; main: number; raised: number; focused: number; high: number; popoverHeader: number;
  fg: number; subtle: number; subtlest: number; brand: number; accentSurface: number;
  border: number; borderHover: number;
}

interface Targets { fg: number; subtle: number; subtlest: number; brand: number }

const TONES: Record<PaletteMode, Record<"base" | "oled" | "contrast", Tones>> = {
  dark: {
    base: { frame: 0.17, main: 0.2, raised: 0.245, focused: 0.225, high: 0.3, popoverHeader: 0.215, fg: 0.93, subtle: 0.74, subtlest: 0.57, brand: 0.78, accentSurface: 0.32, border: 0.12, borderHover: 0.26 },
    oled: { frame: 0, main: 0, raised: 0.17, focused: 0.12, high: 0.23, popoverHeader: 0.14, fg: 0.93, subtle: 0.74, subtlest: 0.57, brand: 0.78, accentSurface: 0.27, border: 0.16, borderHover: 0.3 },
    contrast: { frame: 0.13, main: 0.15, raised: 0.21, focused: 0.18, high: 0.28, popoverHeader: 0.17, fg: 0.99, subtle: 0.86, subtlest: 0.7, brand: 0.86, accentSurface: 0.3, border: 0.3, borderHover: 0.5 },
  },
  light: {
    base: { frame: 0.94, main: 0.975, raised: 0.995, focused: 1, high: 0.915, popoverHeader: 0.965, fg: 0.25, subtle: 0.46, subtlest: 0.62, brand: 0.52, accentSurface: 0.92, border: 0.12, borderHover: 0.26 },
    oled: { frame: 0.94, main: 0.975, raised: 0.995, focused: 1, high: 0.915, popoverHeader: 0.965, fg: 0.25, subtle: 0.46, subtlest: 0.62, brand: 0.52, accentSurface: 0.92, border: 0.12, borderHover: 0.26 },
    contrast: { frame: 0.95, main: 0.99, raised: 1, focused: 1, high: 0.9, popoverHeader: 0.97, fg: 0.14, subtle: 0.3, subtlest: 0.45, brand: 0.42, accentSurface: 0.9, border: 0.32, borderHover: 0.5 },
  },
};

const TARGETS: Record<"base" | "contrast", Targets> = {
  base: { fg: 7, subtle: 4.5, subtlest: 3, brand: 4.5 },
  contrast: { fg: 12, subtle: 7, subtlest: 4.5, brand: 7 },
};

/** Chroma of surfaces and of the accent, from the seed's own chroma. */
function chromas(variant: PaletteVariant, seed: number): { neutral: number; accent: number; status: number } {
  // A near-gray seed gives a monochrome palette instead of an invented hue.
  const gray = seed < 0.02;
  const pick = (neutral: number, accent: number, status: number) => ({ neutral, accent: gray ? seed : accent, status });
  switch (variant) {
    case "vivid": return pick(Math.min(seed * 0.4, 0.04), clamp(seed * 1.3, 0.14, 0.24), 0.18);
    case "soft": return pick(Math.min(seed * 0.15, 0.012), clamp(seed * 0.6, 0.05, 0.09), 0.1);
    case "contrast": return pick(Math.min(seed * 0.15, 0.012), clamp(seed, 0.08, 0.16), 0.16);
    default: return pick(Math.min(seed * 0.25, 0.02), clamp(seed, 0.09, 0.16), 0.15);
  }
}

/**
 * Move a text color's lightness away from its backgrounds until it reaches `target` against every
 * one of them, or the lightness range ends. Returns the color and the contrast it reached.
 */
function readable(l: number, c: number, h: number, backgrounds: Rgb[], target: number, mode: PaletteMode): { rgb: Rgb; contrast: number } {
  const step = mode === "dark" ? 0.01 : -0.01;
  let lightness = l;
  for (;;) {
    const rgb = tone(lightness, c, h);
    const contrast = Math.min(...backgrounds.map((bg) => contrastRatio(rgb, bg)));
    const next = lightness + step;
    if (contrast >= target || next > 1 || next < 0) return { rgb, contrast };
    lightness = next;
  }
}

/** Black-ish or white-ish, whichever reads better on `background`. */
function onColor(background: Rgb, dark: Rgb, light: Rgb): Rgb {
  return contrastRatio(dark, background) >= contrastRatio(light, background) ? dark : light;
}

/**
 * The ZCode color tokens for both modes, built around the seed's hue. Returns null for a seed that
 * is not `#rrggbb`. With `backdrops`, body text is additionally kept readable over what shows
 * through the main surface; `readability` reports the contrast it reached per mode.
 */
export function generatePalette(spec: PaletteSpec, backdrops: Partial<Record<PaletteMode, PaletteBackdrop | null>> = {}): GeneratedPalette | null {
  if (!spec || !isPaletteColor(spec.seed)) return null;
  const variant = PALETTE_VARIANTS.includes(spec.variant as PaletteVariant) ? (spec.variant as PaletteVariant) : "natural";
  const seed = rgbToLch(hexToRgb(spec.seed));
  const hue = seed.h;
  const { neutral, accent, status } = chromas(variant, seed.c);
  const colors = { dark: {}, light: {} } as GeneratedPalette["colors"];
  const readability: GeneratedPalette["readability"] = { dark: null, light: null };

  for (const mode of ["dark", "light"] as const) {
    const t = TONES[mode][variant === "oled" ? "oled" : variant === "contrast" ? "contrast" : "base"];
    const targets = TARGETS[variant === "contrast" ? "contrast" : "base"];
    const surface = (l: number) => tone(l, l <= 0 || l >= 1 ? 0 : neutral, hue);
    const frame = surface(t.frame);
    const main = surface(t.main);
    const raised = surface(t.raised);
    const focused = surface(t.focused);
    const high = surface(t.high);
    const popoverHeader = surface(t.popoverHeader);

    const solid = [main, raised, frame, high];
    const backdrop = backdrops[mode];
    const seen: Rgb[] = [];
    if (backdrop && isPaletteColor(backdrop.color)) {
      const wall = hexToRgb(backdrop.color);
      const underMain = over(frame, clamp(backdrop.frameAlpha, 0, 1), wall);
      seen.push(over(main, clamp(backdrop.mainAlpha, 0, 1), underMain), over(frame, clamp(backdrop.frameAlpha, 0, 1), wall));
    }
    const behindText = [...solid, ...seen];
    // Filled badges and primary buttons carry this ink as text: dark ink in dark mode, light in light.
    const darkInk = surface(TONES.dark.base.frame);
    const lightInk = surface(0.985);
    const ink = mode === "dark" ? darkInk : lightInk;
    const fg = readable(t.fg, neutral * 0.5, hue, behindText, targets.fg, mode);
    const subtle = readable(t.subtle, neutral * 0.8, hue, [main, raised, ...seen], targets.subtle, mode);
    const subtlest = readable(t.subtlest, neutral, hue, [main, ...seen], targets.subtlest, mode);
    const brand = readable(t.brand, accent, hue, [main, raised], targets.brand, mode);
    const primary = readable(t.brand, accent, hue, [main, raised, ink], Math.max(targets.brand, 4.5), mode);
    if (seen.length) readability[mode] = { contrast: Math.round(fg.contrast * 100) / 100, ok: fg.contrast >= targets.subtle };

    const text = fg.rgb;
    // Moving away from the ink also moves away from the main surface, which has the ink's lightness.
    const statusTone = (h: number) => readable(mode === "dark" ? 0.72 : 0.55, status, h, [ink, main], 4.5, mode).rgb;
    const success = statusTone(150);
    const warning = statusTone(85);
    const destructive = statusTone(27);
    const hex = rgbToHex;

    colors[mode] = {
      "background-win-alt": hex(frame),
      "background-alt": hex(frame),
      sidebar: hex(frame),
      background: hex(main),
      panel: hex(main),
      header: hex(main),
      tab: hex(main),
      "tab-active": hex(raised),
      "terminal-bg": hex(main),
      card: hex(raised),
      input: hex(raised),
      "input-focused": hex(focused),
      popover: hex(raised),
      "popover-header": hex(popoverHeader),
      menu: hex(raised),
      toast: hex(raised),
      secondary: hex(high),
      "card-selected": hex(high),
      tag: hex(high),
      tooltip: hex(high),
      "menu-hover": hex(high),
      border: rgba(text, t.border),
      "border-hover": rgba(text, t.borderHover),
      hover: rgba(text, 0.06),
      surface: rgba(text, 0.05),
      "surface-hover": rgba(text, 0.1),
      selected: rgba(brand.rgb, 0.16),
      foreground: hex(text),
      "foreground-subtle": hex(subtle.rgb),
      "foreground-subtlest": hex(subtlest.rgb),
      "foreground-inverse": hex(main),
      "terminal-fg": hex(text),
      primary: hex(primary.rgb),
      "primary-foreground": hex(onColor(primary.rgb, darkInk, lightInk)),
      brand: hex(brand.rgb),
      ring: hex(brand.rgb),
      "input-border-focused": hex(brand.rgb),
      accent: hex(tone(t.accentSurface, accent * 0.45, hue)),
      "terminal-cursor": hex(brand.rgb),
      "terminal-cursor-accent": hex(main),
      "terminal-selection": rgba(brand.rgb, 0.28),
      "find-highlight": rgba(brand.rgb, 0.25),
      "find-highlight-active": hex(brand.rgb),
      "interaction-ask-surface": rgba(brand.rgb, 0.1),
      "interaction-ask-foreground": hex(brand.rgb),
      success: hex(success),
      "success-foreground": hex(onColor(success, darkInk, lightInk)),
      warning: hex(warning),
      "warning-foreground": hex(onColor(warning, darkInk, lightInk)),
      destructive: hex(destructive),
      "destructive-foreground": hex(onColor(destructive, darkInk, lightInk)),
    };
  }
  return { colors, readability };
}

/**
 * What the wallpaper looks like under its own filters: CSS brightness() scales the channels, the dim
 * overlay is mixed on top. `overlay` falls back to the mode's default (black / white) unless it is hex.
 */
export function filteredBackdrop(average: string, brightness: number, dim: number, overlay: string | null, mode: PaletteMode): string {
  const base = hexToRgb(average).map((c) => clamp(c * brightness, 0, 1)) as Rgb;
  const shade = overlay && isPaletteColor(overlay) ? hexToRgb(overlay) : ((mode === "dark" ? [0, 0, 0] : [1, 1, 1]) as Rgb);
  return rgbToHex(over(shade, clamp(dim, 0, 1), base));
}
