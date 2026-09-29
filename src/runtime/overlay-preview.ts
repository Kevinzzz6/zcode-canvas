import type { ResolvedLook, ResolvedWallpaper } from "../shared/look.ts";

export type Knob = "dim" | "blur" | "scale" | "saturate" | "brightness" | "contrast" | "grayscale";
export const knobs: Record<Knob, { label: string; min: number; max: number; step: number; unit: string; fallback: number }> = {
  dim: { label: "压暗", min: 0, max: 1, step: .01, unit: "%", fallback: .35 },
  blur: { label: "模糊", min: 0, max: 200, step: 1, unit: "px", fallback: 0 },
  scale: { label: "缩放", min: .1, max: 4, step: .01, unit: "%", fallback: 1 },
  saturate: { label: "饱和度", min: 0, max: 4, step: .01, unit: "%", fallback: 1 },
  brightness: { label: "亮度", min: 0, max: 2, step: .01, unit: "%", fallback: 1 },
  contrast: { label: "对比度", min: 0, max: 2, step: .01, unit: "%", fallback: 1 },
  grayscale: { label: "灰度", min: 0, max: 1, step: .01, unit: "%", fallback: 0 },
};

/** Only Canvas's existing wallpaper layers are touched; no IDE node lookup or mutation. */
export function previewCss(look: ResolvedLook, patch: Partial<Record<Knob, number>>): string {
  return (["dark", "light"] as const).map((mode) => {
    const base = look.wallpaper[mode];
    if (!base) return "";
    const w = { ...base };
    for (const key of Object.keys(knobs) as Knob[]) {
      const value = patch[key] ?? w[key];
      const spec = knobs[key];
      w[key] = Number.isFinite(value) ? Math.min(spec.max, Math.max(spec.min, value)) : spec.fallback;
    }
    const root = mode === "dark" ? "html:root.dark" : "html:root:not(.dark)";
    const fallback = mode === "dark" ? "#000000" : "#ffffff";
    // CSS.supports rejects declaration breakouts; never interpolate unvalidated theme strings.
    const overlay = w.overlay && typeof CSS !== "undefined" && CSS.supports("color", w.overlay) ? w.overlay : fallback;
    return `${root} body::before{inset:${-w.blur * 2}px!important;transform:scale(${w.scale})!important;filter:blur(${w.blur}px) saturate(${w.saturate}) brightness(${w.brightness}) contrast(${w.contrast}) grayscale(${w.grayscale})!important}
${root} body::after{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:color-mix(in srgb,${overlay} ${w.dim * 100}%,transparent)!important}`;
  }).join("\n");
}

export function knobValue(wallpaper: ResolvedWallpaper | null, key: Knob): number {
  return wallpaper?.[key] ?? knobs[key].fallback;
}
