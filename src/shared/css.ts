import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BLUR_REGIONS, regionAlphas, type GlassRegion } from "./glass.ts";
import type { Mode, ResolvedLook, ResolvedWallpaper } from "./look.ts";
import { linearLuminance, oklabToLinear, toLinear } from "./palette.ts";

// The contract with ZCode, taken from its source (packages/ui/src/styles.css,
// packages/ui/src/DesktopWindowFrame.tsx, packages/desktop/src/renderer/index.html):
//  - design tokens are `--color-*` custom properties on <html>, switched by `.dark`,
//    `.theme-zai-dark` and `.theme-zai-light`;
//  - `[data-desktop-window-frame]` (inside #root) is the outermost painted surface, backed by
//    `--color-background-win-alt` on Windows; the main pane is `bg-background`;
//  - the startup screen is `#loading > .startup-logo-shell > svg.startup-logo`, `#root` fades in
//    once `body.zcode-startup-ready` is set. ZCode sets it when React has rendered and the logo
//    shell's animationend has come, which it only listens for once its bundle runs, with a 1s
//    fallback; under reduced motion it shows the shell still and waits for React alone.
// Popovers, menus and dialogs portal to <body>, outside #root, so they keep opaque colors.
// Selectors carry an id so they outrank ZCode's own rules regardless of sheet order.

/** The surface tokens made translucent, by the region that paints them (see shared/glass.ts).
 *  input-focused is what the prompt composer switches to while it has focus. */
const SURFACES: ReadonlyArray<readonly [token: string, region: GlassRegion]> = [
  ["background-win-alt", "frame"],
  ["background-alt", "frame"],
  ["sidebar", "frame"],
  ["background", "main"],
  ["panel", "main"],
  ["header", "main"],
  ["tab", "main"],
  ["tab-active", "main"],
  ["terminal-bg", "main"],
  ["card", "card"],
  ["secondary", "card"],
  ["input", "input"],
  ["input-focused", "input"],
];

/** Tailwind background utilities of each region's surfaces, which take its backdrop blur. */
const BLURRED_SURFACES: Record<GlassRegion, readonly string[]> = {
  frame: [],
  main: [".bg-background", ".bg-panel"],
  card: [".bg-card"],
  input: [".bg-input"],
};

/** Color token names: "sidebar" or "--color-sidebar". Mirrors colorTokens in theme.schema.json. */
const COLOR_TOKEN = /^(--color-)?[a-z0-9][a-z0-9-]*$/;

/** The grammar of a value, by where it is used. "image" adds gradients to "color", "vars" is the
 *  escape hatch and may also quote font stacks and reference other properties. */
export type CssValueKind = "color" | "image" | "position" | "vars";

const MATH_FUNCTIONS = ["calc", "min", "max", "clamp"];
const COLOR_FUNCTIONS = ["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix", "light-dark"];
const GRADIENT_FUNCTIONS = [
  "linear-gradient",
  "radial-gradient",
  "conic-gradient",
  "repeating-linear-gradient",
  "repeating-radial-gradient",
  "repeating-conic-gradient",
];

/** Functions a value may call, by kind. Nothing that can load a resource (url, image, image-set,
 *  …) is on any list; the only url()s in the sheet are the local files cssUrl() builds below. */
const VALUE_FUNCTIONS: Record<CssValueKind, ReadonlySet<string>> = {
  color: new Set([...MATH_FUNCTIONS, ...COLOR_FUNCTIONS]),
  image: new Set([...MATH_FUNCTIONS, ...COLOR_FUNCTIONS, ...GRADIENT_FUNCTIONS]),
  position: new Set(MATH_FUNCTIONS),
  vars: new Set([...MATH_FUNCTIONS, ...COLOR_FUNCTIONS, ...GRADIENT_FUNCTIONS, "var"]),
};

/**
 * Theme and config values end up verbatim inside declarations of the generated sheet, so each field
 * accepts a grammar instead of being screened against a blacklist: no character that could escape a
 * declaration, encode a CSS escape or start an at-rule, quotes only where vars need them, and every
 * function call must be on the field's list. schema/theme.schema.json mirrors these rules; the test
 * suite asserts the two agree.
 */
export function isSafeCssValue(value: string, kind: CssValueKind): boolean {
  if (/[\u0000-\u001f\u007f;{}<>@`\\]/.test(value)) return false;
  if (kind !== "vars" && /["']/.test(value)) return false;
  const functions = VALUE_FUNCTIONS[kind];
  for (const call of value.matchAll(/([A-Za-z][\w-]*)?\(/g)) {
    if (!call[1] || !functions.has(call[1])) return false;
  }
  return true;
}

export function tokenProperty(key: string): string {
  return key.startsWith("--") ? key : `--color-${key}`;
}

function cssUrl(file: string): string {
  let url = pathToFileURL(file).href;
  try {
    // Cache-bust so replacing the file on disk shows up on hot reload.
    url += `?v=${Math.round(statSync(file).mtimeMs)}`;
  } catch {
    // Missing file: keep the URL; the renderer just shows no image.
  }
  return `url("${url.replace(/"/g, "%22")}")`;
}

/** Percent, rounded to one decimal as the sheet writes it. */
const percent = (alpha: number) => Math.round(alpha * 1000) / 10;

/** Arguments of a CSS color function: "rgb(1 2 3 / 0.5)" and "rgb(1,2,3,0.5)" both → 4 parts. */
function callArgs(color: string, fn: string): string[] | null {
  const match = color.match(new RegExp(`^${fn}\\(([^)]*)\\)$`, "i"));
  if (!match) return null;
  // The slash form puts the alpha after "/", the comma form keeps it as a 4th argument; callers
  // read the first three parts either way.
  return match[1]!.split("/")[0]!.trim().split(/[\s,]+/).filter(Boolean);
}

const numberOrPercent = (part: string, percentScale: number): number | null => {
  const match = part.match(/^([+-]?\d*\.?\d+)(%)?$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? (match[2] ? value * percentScale : value) : null;
};

/** Hue in turns; accepts bare numbers, deg, grad, rad and turn. */
function hueInTurns(part: string): number | null {
  const match = part.match(/^([+-]?\d*\.?\d+)(deg|grad|rad|turn)?$/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  switch (match[2]?.toLowerCase()) {
    case "grad":
      return value / 400;
    case "rad":
      return value / (2 * Math.PI);
    case "turn":
      return value;
    default:
      return value / 360;
  }
}

/** Lightness argument of oklch()/oklab(): 0..1 as a number, 0..100 as a percentage. */
function okLightness(part: string): number | null {
  return numberOrPercent(part, 0.01);
}

/** The color as linear sRGB channels (0..1), or null for syntaxes this cannot resolve. */
function accentLinear(color: string): [number, number, number] | null {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const hex = color.match(/^#([0-9a-f]+)$/i);
  if (hex) {
    const digits = hex[1]!;
    const pairs =
      digits.length === 3 || digits.length === 4
        ? [...digits.slice(0, 3)].map((c) => c + c)
        : digits.length === 6 || digits.length === 8
          ? [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)]
          : null;
    if (!pairs) return null;
    return pairs.map((p) => toLinear(parseInt(p, 16) / 255)) as [number, number, number];
  }
  const rgbArgs = callArgs(color, "rgba?");
  if (rgbArgs && rgbArgs.length >= 3) {
    // rgb() channels are 0..255 as numbers or 0..100 as percentages.
    const channel = (part: string): number | null => {
      const match = part.match(/^([+-]?\d*\.?\d+)(%)?$/);
      if (!match || !Number.isFinite(Number(match[1]))) return null;
      return match[2] ? Number(match[1]) / 100 : Number(match[1]) / 255;
    };
    const channels = rgbArgs.slice(0, 3).map(channel);
    if (channels.every((c): c is number => c != null))
      return channels.map((c) => toLinear(clamp01(c))) as [number, number, number];
  }
  const hslArgs = callArgs(color, "hsla?");
  if (hslArgs && hslArgs.length >= 3) {
    const hue = hueInTurns(hslArgs[0]!);
    const saturation = numberOrPercent(hslArgs[1]!, 0.01);
    const lightness = numberOrPercent(hslArgs[2]!, 0.01);
    if (hue == null || saturation == null || lightness == null) return null;
    const h = hue * 360;
    const channel = (n: number) => {
      const k = (((h / 30 + n) % 12) + 12) % 12;
      return clamp01(lightness - saturation * Math.min(lightness, 1 - lightness) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
    };
    // CSS Color 4 evaluates the channel function at n = 0 (red), 8 (green), 4 (blue).
    return [0, 8, 4].map((n) => toLinear(channel(n))) as [number, number, number];
  }
  // Clamped like a browser clamps out-of-gamut colors.
  const oklab = (lightness: number, a: number, b: number) => oklabToLinear(lightness, a, b).map(clamp01) as [number, number, number];
  const oklabArgs = callArgs(color, "oklab");
  if (oklabArgs && oklabArgs.length >= 3) {
    const lightness = okLightness(oklabArgs[0]!);
    const a = numberOrPercent(oklabArgs[1]!, 0.004);
    const b = numberOrPercent(oklabArgs[2]!, 0.004);
    if (lightness == null || a == null || b == null) return null;
    return oklab(lightness, a, b);
  }
  const oklchArgs = callArgs(color, "oklch");
  if (oklchArgs && oklchArgs.length >= 3) {
    const lightness = okLightness(oklchArgs[0]!);
    // Chroma in % is relative to the reference range 0..0.4.
    const chroma = numberOrPercent(oklchArgs[1]!, 0.004);
    const hue = hueInTurns(oklchArgs[2]!);
    if (lightness == null || chroma == null || hue == null) return null;
    const angle = hue * 2 * Math.PI;
    return oklab(lightness, chroma * Math.cos(angle), chroma * Math.sin(angle));
  }
  return null;
}

/**
 * Best-effort readable foreground for an accent: black or white, whichever WCAG contrast is higher
 * (the crossover is L = √0.0525 − 0.05 ≈ 0.179). hex, rgb(), hsl(), oklch() and oklab() resolve;
 * syntaxes that cannot be computed statically (lab(), color-mix(), light-dark(), …) fall back to
 * white, which suits the saturated mid/dark accents such values usually describe.
 */
export function contrastForeground(color: string): string {
  const linear = accentLinear(color.trim());
  if (!linear) return "#ffffff";
  return linearLuminance(linear) > Math.sqrt(0.0525) - 0.05 ? "#000000" : "#ffffff";
}

const MODE_SELECTOR: Record<Mode, string> = {
  dark: "html:root.dark",
  light: "html:root:not(.dark)",
};

/** Tailwind v4's default radius scale in rem; ZCode's `rounded-*` utilities read these variables. */
const RADII: ReadonlyArray<readonly [name: string, rem: number]> = [
  ["xs", 0.125],
  ["sm", 0.25],
  ["md", 0.375],
  ["lg", 0.5],
  ["xl", 0.75],
  ["2xl", 1],
  ["3xl", 1.5],
  ["4xl", 2],
];

export const ACCENT_TOKENS = ["primary", "brand", "ring", "primary-foreground"] as const;

function block(selector: string, declarations: string[]): string {
  return declarations.length ? `${selector} {\n  ${declarations.join(";\n  ")};\n}` : "";
}

/** A rule that moves things, kept out of the way when the system asks for reduced motion. */
function unlessReducedMotion(rule: string): string {
  return rule ? `@media (prefers-reduced-motion: no-preference) {\n${rule.replace(/^/gm, "  ")}\n}` : "";
}

export interface CssResult {
  css: string;
  warnings: string[];
}

/** Wallpaper layers under `root` (`html` for both modes, or one mode's selector); `mode` null = both. */
function wallpaperRules(
  wallpaper: ResolvedWallpaper,
  root: string,
  mode: Mode | null,
  safe: (label: string, value: string, kind: CssValueKind) => boolean,
): string[] {
  const label = mode ? `wallpaper.${mode}` : "wallpaper";
  if (!safe(`${label}.position`, wallpaper.position, "position")) return [];
  const rules: string[] = [];
  const url = cssUrl(wallpaper.image);
  const size = { cover: "cover", contain: "contain", fill: "100% 100%", tile: "auto", center: "auto" }[wallpaper.fit];
  const repeat = wallpaper.fit === "tile" ? "repeat" : "no-repeat";
  const bleed = wallpaper.blur ? `${-wallpaper.blur * 2}px` : "0";
  const n = (value: number) => Math.round(value * 1000) / 1000;
  // Zoom is a transform anchored at the focal position, so the subject stays put while scaling —
  // and it composes with every fit, including tile. Filters ride along on the same layer.
  const filters = [
    wallpaper.blur ? `blur(${wallpaper.blur}px)` : "",
    wallpaper.saturate !== 1 ? `saturate(${n(wallpaper.saturate)})` : "",
    wallpaper.brightness !== 1 ? `brightness(${n(wallpaper.brightness)})` : "",
    wallpaper.contrast !== 1 ? `contrast(${n(wallpaper.contrast)})` : "",
    wallpaper.grayscale > 0 ? `grayscale(${n(wallpaper.grayscale)})` : "",
  ].filter(Boolean);
  const layer = ["content: \"\"", "position: fixed", "z-index: -1", "pointer-events: none"];
  rules.push(
    block(`${root} body::before`, [
      ...layer,
      `inset: ${bleed}`,
      `background: ${url} ${wallpaper.position} / ${size} ${repeat}`,
      ...(wallpaper.scale !== 1 ? [`transform: scale(${n(wallpaper.scale)})`, `transform-origin: ${wallpaper.position}`] : []),
      ...(filters.length ? [`filter: ${filters.join(" ")}`] : []),
    ]),
  );
  if (wallpaper.fit === "contain" || wallpaper.fit === "center") {
    // Letterbox bars are filled with a blurred, zoomed copy of the same image.
    rules.push(block(`${root}::before`, [...layer, "inset: -60px", `background: ${url} center / cover no-repeat`, "filter: blur(40px)"]));
  }
  if (wallpaper.dim > 0) {
    const pct = Math.round(wallpaper.dim * 1000) / 10;
    const overlay = wallpaper.overlay && safe(`${label}.overlay`, wallpaper.overlay, "color") ? wallpaper.overlay : null;
    rules.push(block(`${root} body::after`, [...layer, "inset: 0", "transition: opacity 0.3s ease"]));
    // ZCode sets its theme classes only after the first paint, so the mode is unknown on the
    // startup screen; the overlay stays hidden until the UI fades in.
    rules.push(block("body:not(.zcode-startup-ready)::after", ["opacity: 0"]));
    for (const m of mode ? [mode] : (["dark", "light"] as const)) {
      const color = overlay ?? (m === "dark" ? "#000000" : "#ffffff");
      rules.push(block(`${MODE_SELECTOR[m]} body::after`, [`background: color-mix(in srgb, ${color} ${pct}%, transparent)`]));
    }
  }
  return rules;
}

export function buildCss(look: ResolvedLook): CssResult {
  const warnings: string[] = [];
  const rules: string[] = [];
  const safe = (label: string, value: string, kind: CssValueKind): boolean => {
    if (isSafeCssValue(value, kind)) return true;
    warnings.push(`ignored unsafe value for ${label}`);
    return false;
  };

  for (const mode of ["dark", "light"] as const) {
    const declarations: string[] = [];
    const colors = look.colors[mode];
    for (const [key, value] of Object.entries(colors)) {
      // Keys reach the sheet too, so they are as much a security boundary as values; JSON.stringify
      // keeps a hostile key from smuggling control characters into the warning.
      if (!COLOR_TOKEN.test(key)) {
        warnings.push(`ignored colors.${mode}.${JSON.stringify(key)}: not a color token, move it to vars`);
        continue;
      }
      if (safe(`colors.${mode}.${key}`, value, "color")) declarations.push(`${tokenProperty(key)}: ${value}`);
    }
    const accent = look.accent[mode];
    if (accent && safe(`accent.${mode}`, accent, "color")) {
      // Tokens the theme sets explicitly in `colors` win over the ones derived from the accent.
      const derived: Record<(typeof ACCENT_TOKENS)[number], string> = {
        primary: accent,
        brand: accent,
        ring: accent,
        "primary-foreground": contrastForeground(accent),
      };
      for (const token of ACCENT_TOKENS) {
        if (!(token in colors) && !(`--color-${token}` in colors)) declarations.push(`--color-${token}: ${derived[token]}`);
      }
    }
    for (const [key, value] of Object.entries(look.vars[mode])) {
      if (!/^--[\w-]+$/.test(key)) warnings.push(`ignored vars.${mode}.${JSON.stringify(key)}: custom property names start with --`);
      else if (safe(`vars.${mode}.${key}`, value, "vars")) declarations.push(`${key}: ${value}`);
    }
    rules.push(block(MODE_SELECTOR[mode], declarations));
  }

  if (look.radius !== null && look.radius !== 1) {
    const scale = look.radius;
    rules.push(block("html:root", RADII.map(([name, rem]) => `--radius-${name}: ${scale === 0 ? "0" : `${Math.round(rem * scale * 1000) / 1000}rem`}`)));
  }

  const { regions } = look.glass;
  const alphas = regionAlphas(regions);
  const translucent = SURFACES.filter(([, region]) => percent(alphas[region]) < 100);
  if (translucent.length) {
    // A custom property cannot reference itself, so the original value is captured one level up
    // (body inherits it from <html>) and re-declared translucent on #root.
    rules.push(block("body", translucent.map(([token]) => `--zc-src-${token}: var(--color-${token})`)));
    rules.push(
      block(
        "#root",
        translucent.map(
          ([token, region]) => `--color-${token}: color-mix(in srgb, var(--zc-src-${token}) ${percent(alphas[region])}%, transparent)`,
        ),
      ),
    );
    // Regions sharing a radius share one rule, so the untuned case stays a single declaration.
    const byBlur = new Map<number, string[]>();
    for (const region of BLUR_REGIONS) {
      const { opacity, blur } = regions[region];
      if (opacity >= 1 || blur <= 0) continue;
      byBlur.set(blur, [...(byBlur.get(blur) ?? []), ...BLURRED_SURFACES[region]]);
    }
    for (const [blur, selectors] of byBlur) {
      rules.push(block(selectors.map((s) => `#root ${s}`).join(",\n"), [`backdrop-filter: blur(${blur}px)`]));
    }
  }

  const { dark, light } = look.wallpaper;
  if (dark || light) {
    const shared = JSON.stringify(dark) === JSON.stringify(light);
    if (shared) rules.push(...wallpaperRules(dark!, "html", null, safe));
    else {
      for (const mode of ["dark", "light"] as const) {
        const wallpaper = look.wallpaper[mode];
        if (wallpaper) rules.push(...wallpaperRules(wallpaper, MODE_SELECTOR[mode], mode, safe));
      }
      // The mode is unknown until ZCode sets its theme classes after the first paint, so neither
      // wallpaper is shown behind the startup screen rather than risk flashing the wrong one.
      rules.push(
        block("body::before, html::before", ["transition: opacity 0.3s ease"]),
        block("body:not(.zcode-startup-ready)::before, html:has(> body:not(.zcode-startup-ready))::before", ["opacity: 0"]),
      );
    }
  }

  const startup = look.startup;
  if (startup.background && safe("startup.background", startup.background, "image")) {
    rules.push(block("body #loading", [`background: ${startup.background}`]));
  }
  if (startup.logo) {
    rules.push(
      block("#loading .startup-logo-shell", [
        `width: ${startup.logoSize}px`,
        `height: ${startup.logoSize}px`,
        `background: ${cssUrl(startup.logo)} center / contain no-repeat`,
        "box-shadow: none",
        "border-radius: 0",
      ]),
      block("#loading .startup-logo-shell::before, #loading .startup-logo", ["display: none"]),
    );
  } else if (startup.logoSize !== 96) {
    rules.push(block("#loading .startup-logo-shell", [`width: ${startup.logoSize}px`, `height: ${startup.logoSize}px`]));
  }
  // Every startup animation must end, and not before ZCode listens: until its animationend comes,
  // ZCode keeps the startup screen up.
  if (startup.animation === "fade") {
    rules.push(
      "@keyframes zc-startup-fade { from { opacity: 0 } to { opacity: 1 } }",
      unlessReducedMotion(block("#loading .startup-logo-shell", ["transform: none", "animation: zc-startup-fade 0.6s ease forwards"])),
    );
  } else if (startup.animation === "none") {
    // Still, but on ZCode's own animation timing: `animation: none`, or an animation that ends
    // early, leaves the screen waiting for the 1s fallback.
    rules.push(
      "@keyframes zc-startup-none { to { opacity: 1 } }",
      block("#loading .startup-logo-shell", ["transform: none", "opacity: 1", "animation-name: zc-startup-none"]),
    );
  }

  const css = rules.filter(Boolean).join("\n\n");
  return { css: css ? `/* ZCode Canvas */\n${css}\n` : "", warnings };
}
