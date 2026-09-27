import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Mode, ResolvedLook } from "./look.ts";

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

/** Rejects values that could break out of a declaration or pull in remote resources. */
export function isSafeCssValue(value: string): boolean {
  return !/[;{}<>\n\r]|url\s*\(|@import|expression\s*\(/i.test(value);
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

function block(selector: string, declarations: string[]): string {
  return declarations.length ? `${selector} {\n  ${declarations.join(";\n  ")};\n}` : "";
}

export interface CssResult {
  css: string;
  warnings: string[];
}

export function buildCss(look: ResolvedLook): CssResult {
  const warnings: string[] = [];
  const rules: string[] = [];
  const safe = (label: string, value: string): boolean => {
    if (isSafeCssValue(value)) return true;
    warnings.push(`ignored unsafe value for ${label}`);
    return false;
  };

  for (const mode of ["dark", "light"] as const) {
    const declarations: string[] = [];
    for (const [key, value] of Object.entries(look.colors[mode])) {
      if (safe(`colors.${mode}.${key}`, value)) declarations.push(`${tokenProperty(key)}: ${value}`);
    }
    const accent = look.accent[mode];
    if (accent && safe(`accent.${mode}`, accent)) {
      declarations.push(
        `--color-primary: ${accent}`,
        `--color-brand: ${accent}`,
        `--color-ring: ${accent}`,
      );
      if (!("primary-foreground" in look.colors[mode] || "--color-primary-foreground" in look.colors[mode])) {
        declarations.push(`--color-primary-foreground: ${contrastForeground(accent)}`);
      }
    }
    rules.push(block(MODE_SELECTOR[mode], declarations));
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

  const wallpaper = look.wallpaper;
  if (wallpaper && safe("wallpaper.position", wallpaper.position)) {
    const url = cssUrl(wallpaper.image);
    const size = { cover: "cover", contain: "contain", fill: "100% 100%", tile: "auto", center: "auto" }[wallpaper.fit];
    const repeat = wallpaper.fit === "tile" ? "repeat" : "no-repeat";
    const bleed = wallpaper.blur ? `${-wallpaper.blur * 2}px` : "0";
    const layer = ["content: \"\"", "position: fixed", "z-index: -1", "pointer-events: none"];
    rules.push(
      block("body::before", [
        ...layer,
        `inset: ${bleed}`,
        `background: ${url} ${wallpaper.position} / ${size} ${repeat}`,
        ...(wallpaper.blur ? [`filter: blur(${wallpaper.blur}px)`] : []),
      ]),
    );
    if (wallpaper.fit === "contain" || wallpaper.fit === "center") {
      // Letterbox bars are filled with a blurred, zoomed copy of the same image.
      rules.push(
        block("html::before", [...layer, "inset: -60px", `background: ${url} center / cover no-repeat`, "filter: blur(40px)"]),
      );
    }
    if (wallpaper.dim > 0) {
      const pct = Math.round(wallpaper.dim * 1000) / 10;
      const overlay = wallpaper.overlay && safe("wallpaper.overlay", wallpaper.overlay) ? wallpaper.overlay : null;
      rules.push(block("body::after", [...layer, "inset: 0", "transition: opacity 0.3s ease"]));
      // ZCode sets its theme classes only after the first paint, so the mode is unknown on the
      // startup screen; the overlay stays hidden until the UI fades in.
      rules.push(block("body:not(.zcode-startup-ready)::after", ["opacity: 0"]));
      for (const mode of ["dark", "light"] as const) {
        const color = overlay ?? (mode === "dark" ? "#000000" : "#ffffff");
        rules.push(block(`${MODE_SELECTOR[mode]} body::after`, [`background: color-mix(in srgb, ${color} ${pct}%, transparent)`]));
      }
    }
  }

  const startup = look.startup;
  if (startup.background && safe("startup.background", startup.background)) {
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
