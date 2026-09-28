import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Mode, ResolvedLook, ResolvedWallpaper } from "./look.ts";

// The contract with ZCode, taken from its source (packages/ui/src/styles.css,
// packages/ui/src/DesktopWindowFrame.tsx, packages/desktop/src/renderer/index.html):
//  - design tokens are `--color-*` custom properties on <html>, switched by `.dark`,
//    `.theme-zai-dark` and `.theme-zai-light`;
//  - `[data-desktop-window-frame]` (inside #root) is the outermost painted surface, backed by
//    `--color-background-win-alt` on Windows; the main pane is `bg-background`;
//  - the startup screen is `#loading > .startup-logo-shell > svg.startup-logo`, `#root` fades in
//    once `body.zcode-startup-ready` is set.
// Popovers, menus and dialogs portal to <body>, outside #root, so they keep opaque colors.
// Selectors carry an id so they outrank ZCode's own rules regardless of sheet order.

type Tier = "base" | "content" | "raised";

const SURFACES: ReadonlyArray<readonly [token: string, tier: Tier]> = [
  ["background-win-alt", "base"],
  ["background-alt", "base"],
  ["sidebar", "base"],
  ["background", "content"],
  ["panel", "content"],
  ["header", "content"],
  ["tab", "content"],
  ["tab-active", "content"],
  ["terminal-bg", "content"],
  ["card", "raised"],
  ["input", "raised"],
  ["secondary", "raised"],
];

const BLURRED_SURFACES = [".bg-background", ".bg-panel", ".bg-card", ".bg-input"];

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

/**
 * Percent alpha per tier. Content surfaces sit on top of the translucent frame, so their own alpha is
 * derived such that frame + content together match `opacity`; the frame (and sidebar) stay clearer.
 */
function alphaFor(tier: Tier, opacity: number): number {
  const base = opacity * 0.7;
  const alpha = {
    base,
    content: 1 - (1 - opacity) / (1 - base),
    raised: 1 - (1 - opacity) * 0.5,
  }[tier];
  return Math.round(alpha * 1000) / 10;
}

/** Best-effort readable foreground for a hex/rgb accent; other syntaxes fall back to white. */
export function contrastForeground(color: string): string {
  let rgb: number[] | null = null;
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex?.[1]) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else {
    const fn = color.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
    if (fn) rgb = fn.slice(1, 4).map(Number);
  }
  if (!rgb) return "#ffffff";
  const [r = 0, g = 0, b = 0] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? "#000000" : "#ffffff";
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

const ACCENT_TOKENS = ["primary", "brand", "ring", "primary-foreground"] as const;

function block(selector: string, declarations: string[]): string {
  return declarations.length ? `${selector} {\n  ${declarations.join(";\n  ")};\n}` : "";
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
  const layer = ["content: \"\"", "position: fixed", "z-index: -1", "pointer-events: none"];
  rules.push(
    block(`${root} body::before`, [
      ...layer,
      `inset: ${bleed}`,
      `background: ${url} ${wallpaper.position} / ${size} ${repeat}`,
      ...(wallpaper.blur ? [`filter: blur(${wallpaper.blur}px)`] : []),
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

  const { opacity, blur } = look.glass;
  if (opacity < 1) {
    // A custom property cannot reference itself, so the original value is captured one level up
    // (body inherits it from <html>) and re-declared translucent on #root.
    rules.push(block("body", SURFACES.map(([token]) => `--zc-src-${token}: var(--color-${token})`)));
    rules.push(
      block(
        "#root",
        SURFACES.map(
          ([token, tier]) =>
            `--color-${token}: color-mix(in srgb, var(--zc-src-${token}) ${alphaFor(tier, opacity)}%, transparent)`,
        ),
      ),
    );
    if (blur > 0) {
      rules.push(block(BLURRED_SURFACES.map((s) => `#root ${s}`).join(",\n"), [`backdrop-filter: blur(${blur}px)`]));
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
  if (startup.animation === "fade") {
    rules.push(
      "@keyframes zc-startup-fade { from { opacity: 0 } to { opacity: 1 } }",
      block("#loading .startup-logo-shell", ["transform: none", "animation: zc-startup-fade 0.6s ease forwards"]),
    );
  } else if (startup.animation === "none") {
    rules.push(block("#loading .startup-logo-shell", ["transform: none", "opacity: 1", "animation: none"]));
  }

  const css = rules.filter(Boolean).join("\n\n");
  return { css: css ? `/* ZCode Canvas */\n${css}\n` : "", warnings };
}
