import type { ResolvedLook, ResolvedWallpaper } from "../shared/look.ts";

/** UI control metadata. API names and ranges are validated again by the main process. */
export const knobs = {
  transparency: { label: "界面透明", min: 0, max: 100, step: 1, unit: "%", fallback: 0, group: "primary" },
  glassBlur: { label: "界面模糊", min: 0, max: 100, step: 1, unit: "px", fallback: 0, group: "primary" },
  brightness: { label: "图片亮度", min: 0, max: 2, step: .01, unit: "%", fallback: 1, group: "primary" },
  blur: { label: "图片模糊", min: 0, max: 200, step: 1, unit: "px", fallback: 0, group: "wallpaper" },
  saturate: { label: "饱和度", min: 0, max: 4, step: .01, unit: "%", fallback: 1, group: "wallpaper" },
  contrast: { label: "对比度", min: 0, max: 2, step: .01, unit: "%", fallback: 1, group: "wallpaper" },
  grayscale: { label: "灰度", min: 0, max: 1, step: .01, unit: "%", fallback: 0, group: "wallpaper" },
  scale: { label: "缩放", min: .1, max: 4, step: .01, unit: "%", fallback: 1, group: "wallpaper" },
  positionX: { label: "水平位置", min: 0, max: 100, step: 1, unit: "%", fallback: 50, group: "wallpaper" },
  positionY: { label: "垂直位置", min: 0, max: 100, step: 1, unit: "%", fallback: 50, group: "wallpaper" },
  radius: { label: "圆角", min: 0, max: 4, step: .05, unit: "×", fallback: 1, group: "theme" },
} as const;

export type Knob = keyof typeof knobs;

export function formatKnob(key: Knob, value: number): string {
  if (key === "transparency" || key === "positionX" || key === "positionY") return `${Math.round(value)}%`;
  if (knobs[key].unit === "%") return `${Math.round(value * 100)}%`;
  if (key === "radius") return `${Number(value.toFixed(2))}×`;
  return `${Math.round(value)}${knobs[key].unit}`;
}

export function positionValue(position: string | undefined, axis: 0 | 1): number {
  if (!position || position === "center") return 50;
  const values = position.trim().split(/\s+/);
  const vertical = (part: string) => part === "top" || part === "bottom";
  const reordered = values.length === 2 && vertical(values[0] ?? "") && !vertical(values[1] ?? "")
    ? [values[1], values[0]] : values;
  let part = reordered[axis];
  if (values.length === 1) {
    if (vertical(values[0] ?? "")) part = axis === 0 ? "center" : values[0];
    else if (axis === 1) part = "center";
  }
  if (part === "center" || part === undefined) return 50;
  if (part === "left" || part === "top") return 0;
  if (part === "right" || part === "bottom") return 100;
  const match = /^(\d+(?:\.\d+)?)%$/.exec(part ?? "");
  return match ? Math.max(0, Math.min(100, Number(match[1]))) : 50;
}

export function knobValue(look: ResolvedLook, wallpaper: ResolvedWallpaper | null, key: Knob): number {
  if (key === "transparency") return Math.round((1 - look.glass.opacity) * 100);
  if (key === "glassBlur") return look.glass.blur;
  if (key === "radius") return look.radius ?? knobs.radius.fallback;
  if (key === "positionX") return positionValue(wallpaper?.position, 0);
  if (key === "positionY") return positionValue(wallpaper?.position, 1);
  return wallpaper?.[key] ?? knobs[key].fallback;
}
