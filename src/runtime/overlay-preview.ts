import type { ResolvedLook, ResolvedWallpaper, WallpaperFit } from "../shared/look.ts";

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

export interface Size { width: number; height: number }

/**
 * Whether moving the position can change the picture along each axis, for this window. `null` when
 * the image size is unknown. A zoom anchors at the position, so any position moves it then.
 */
export function positionSlack(fit: WallpaperFit, scale: number, blur: number, image: Size | null, viewport: Size): { x: boolean; y: boolean } | null {
  if (Math.abs(scale - 1) >= .005 || fit === "tile") return { x: true, y: true };
  if (fit === "fill") return { x: false, y: false };
  if (!image || !(image.width > 0) || !(image.height > 0)) return null;
  // The layer bleeds 2×blur past each window edge, so a blurred image is laid out in a larger box.
  const box = { width: viewport.width + 4 * blur, height: viewport.height + 4 * blur };
  const k = fit === "cover" ? Math.max(box.width / image.width, box.height / image.height)
    : fit === "contain" ? Math.min(box.width / image.width, box.height / image.height) : 1;
  return { x: Math.abs(image.width * k - box.width) > .5, y: Math.abs(image.height * k - box.height) > .5 };
}

export interface DiagnosisInput {
  wallpaper: ResolvedWallpaper | null;
  transparency: number;
  fit: WallpaperFit;
  scale: number;
  blur: number;
  image: Size | null;
  viewport: Size;
}

export interface Diagnosis {
  /** Controls that cannot have any effect in the current state, with the reason. */
  disabled: Partial<Record<Knob, string>>;
  /** Short hints shown right next to the controls they explain; null shows nothing extra. */
  hints: { primary: string | null; wallpaper: string | null; material: string | null };
}

/** Explain why a control would look broken: what hides its effect, and what to change instead. */
export function diagnose({ wallpaper, transparency, fit, scale, blur, image, viewport }: DiagnosisInput): Diagnosis {
  const disabled: Diagnosis["disabled"] = {};
  const hints: Diagnosis["hints"] = { primary: null, wallpaper: null, material: null };
  const opaque = transparency <= 0;
  if (opaque) {
    disabled.glassBlur = "界面不透明时，模糊没有可透出的内容";
    hints.primary = wallpaper ? "界面当前不透明，壁纸被遮住。调高「界面透明」即可显示。" : "界面当前不透明，调高「界面透明」后界面模糊才生效。";
    hints.material = "界面不透明时看不到原生材质。";
  } else if (wallpaper) hints.material = "壁纸会盖住原生材质，清除壁纸后可见。";
  if (!wallpaper) {
    for (const key of Object.keys(knobs) as Knob[]) if (knobs[key].group === "wallpaper" || key === "brightness") disabled[key] = "还没有壁纸";
    hints.wallpaper = "先在上方选择一张壁纸，再调整这些选项。";
    return { disabled, hints };
  }
  if (opaque) hints.wallpaper = "壁纸正被不透明的界面遮住，调整结果暂时看不到。";
  const slack = positionSlack(fit, scale, blur, image, viewport);
  if (fit === "fill" && slack && !slack.x && !slack.y) {
    disabled.positionX = disabled.positionY = "拉伸铺满时位置不起作用";
    hints.wallpaper ??= "拉伸铺满时位置不起作用，放大图片后可调整。";
  } else if (slack && !slack.x && !slack.y) hints.wallpaper ??= "当前窗口下图片正好铺满，位置不会变化；放大图片后可移动取景。";
  else if (slack && !slack.x) hints.wallpaper ??= "当前窗口下图片左右没有余量，水平位置不会变化。";
  else if (slack && !slack.y) hints.wallpaper ??= "当前窗口下图片上下没有余量，垂直位置不会变化。";
  return { disabled, hints };
}
