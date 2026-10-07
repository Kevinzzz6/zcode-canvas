import { mainCappedByFrame, type GlassRegion } from "../shared/glass.ts";
import type { ResolvedLook, ResolvedWallpaper, WallpaperFit } from "../shared/look.ts";
import type { DesktopPetAvailability } from "../shared/pet.ts";
import { positionAxes } from "../shared/position.ts";

/**
 * The pet's desktop-mode switch: usable only where desktop mode exists (or is forced for testing),
 * and the note under it says why not, or what the current mode means. Anything but a known value
 * (a main process from before desktop mode) counts as unavailable.
 */
export function petPlacementNote(availability: DesktopPetAvailability | undefined, desktop: boolean): { available: boolean; hint: string } {
  if (availability !== "supported" && availability !== "forced") {
    return { available: false, hint: "桌面模式目前只支持 Windows 和 macOS：Linux（Wayland）下应用不能自己摆放窗口，也做不到只让透明处穿透点击。" };
  }
  const mode = desktop
    ? "全局一只，住在屏幕上，ZCode 最小化或被挡住时也在。拖动可换位置，靠近屏幕边缘会吸附。她不会出现在截图和录屏里。"
    : "每个 ZCode 窗口里一只。拖动可换位置，靠近窗口边缘会吸附。";
  return { available: true, hint: availability === "forced" ? `测试开关 ZCODE_CANVAS_PET_DESKTOP=force 已打开，这个平台上的桌面模式尚未验证。${mode}` : mode };
}

/** UI control metadata. API names and ranges are validated again by the main process. */
export const knobs = {
  transparency: { label: "界面透明", min: 0, max: 100, step: 1, unit: "%", fallback: 0, group: "primary" },
  glassBlur: { label: "界面模糊", min: 0, max: 100, step: 1, unit: "px", fallback: 0, group: "primary", curve: "ease" },
  brightness: { label: "图片亮度", min: 0, max: 2, step: .01, unit: "%", fallback: 1, group: "primary" },
  blur: { label: "图片模糊", min: 0, max: 200, step: 1, unit: "px", fallback: 0, group: "wallpaper", curve: "ease" },
  saturate: { label: "饱和度", min: 0, max: 4, step: .01, unit: "%", fallback: 1, group: "wallpaper" },
  contrast: { label: "对比度", min: 0, max: 2, step: .01, unit: "%", fallback: 1, group: "wallpaper" },
  grayscale: { label: "灰度", min: 0, max: 1, step: .01, unit: "%", fallback: 0, group: "wallpaper" },
  scale: { label: "缩放", min: .1, max: 4, step: .01, unit: "%", fallback: 1, group: "wallpaper", curve: "zoom" },
  positionX: { label: "水平位置", min: 0, max: 100, step: 1, unit: "%", fallback: 50, group: "wallpaper" },
  positionY: { label: "垂直位置", min: 0, max: 100, step: 1, unit: "%", fallback: 50, group: "wallpaper" },
  radius: { label: "圆角", min: 0, max: 4, step: .05, unit: "×", fallback: 1, group: "theme" },
  frameTransparency: { label: "侧栏", min: 0, max: 100, step: 1, unit: "%", fallback: 0, group: "region", region: "frame" },
  mainTransparency: { label: "主区域", min: 0, max: 100, step: 1, unit: "%", fallback: 0, group: "region", region: "main" },
  cardTransparency: { label: "卡片", min: 0, max: 100, step: 1, unit: "%", fallback: 0, group: "region", region: "card" },
  inputTransparency: { label: "输入框", min: 0, max: 100, step: 1, unit: "%", fallback: 0, group: "region", region: "input" },
  mainBlur: { label: "主区模糊", min: 0, max: 100, step: 1, unit: "px", fallback: 0, group: "region", region: "main", curve: "ease" },
  cardBlur: { label: "卡片模糊", min: 0, max: 100, step: 1, unit: "px", fallback: 0, group: "region", region: "card", curve: "ease" },
  inputBlur: { label: "输入模糊", min: 0, max: 100, step: 1, unit: "px", fallback: 0, group: "region", region: "input", curve: "ease" },
} as const;

export type Knob = keyof typeof knobs;

/** Controls shown as "how transparent", 0..100 %, and stored inverted as opacity 0..1. */
export function isTransparency(key: Knob): boolean {
  return key === "transparency" || key.endsWith("Transparency");
}

/** The glass region a per-region control belongs to. */
export function regionOf(key: Knob): GlassRegion | null {
  const spec = knobs[key];
  return "region" in spec ? spec.region : null;
}

/** How long a region stays outlined after its control is let go, so the result can be seen. */
export const HIGHLIGHT_LINGER = 1000;

/**
 * Which region to outline while its controls are in use: pressed, then hovered, then just changed
 * (for HIGHLIGHT_LINGER), then keyboard-focused. `show` runs only when the answer changes.
 */
export function createRegionHighlight(show: (region: GlassRegion | null) => void) {
  let pressed: GlassRegion | null = null;
  let hovered: GlassRegion | null = null;
  let focused: GlassRegion | null = null;
  let lingering: GlassRegion | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let shown: GlassRegion | null = null;
  const sync = () => {
    const next = pressed ?? hovered ?? lingering ?? focused;
    if (next !== shown) { shown = next; show(next); }
  };
  const linger = (region: GlassRegion) => {
    clearTimeout(timer);
    lingering = region;
    timer = setTimeout(() => { lingering = null; sync(); }, HIGHLIGHT_LINGER);
  };
  return {
    press(region: GlassRegion) { pressed = region; sync(); },
    release() { if (pressed) linger(pressed); pressed = null; sync(); },
    /** A value changed without a press (keyboard step, typed number). */
    nudge(region: GlassRegion) { linger(region); sync(); },
    hover(region: GlassRegion, on: boolean) { if (on) hovered = region; else if (hovered === region) hovered = null; sync(); },
    focus(region: GlassRegion, on: boolean) { if (on) focused = region; else if (focused === region) focused = null; sync(); },
    clear() { clearTimeout(timer); pressed = hovered = focused = lingering = null; sync(); },
  };
}

/** Name of the control in panel requests; transparency is stored inverted as glass opacity. */
export function inputKey(key: Knob): string {
  if (key === "transparency") return "glassOpacity";
  return isTransparency(key) ? key.replace("Transparency", "Opacity") : key;
}

/** Curved sliders run over 0..SLIDER_SPAN; linear ones use the value's own range. */
export const SLIDER_SPAN = 1000;
// Zoom: the first quarter of the track shrinks (0.1–1×), the rest zooms in (1–4×) on a curve,
// so the common 100–200% range gets almost half of the track.
const ZOOM_KNEE = .25;

function curveOf(key: Knob): "ease" | "zoom" | undefined {
  const spec = knobs[key];
  return "curve" in spec ? spec.curve : undefined;
}

function clampKnob(key: Knob, value: number): number {
  const { min, max } = knobs[key];
  return Math.min(max, Math.max(min, value));
}

/** Round to the control's step without float noise (0.07 stays 0.07). */
export function roundKnob(key: Knob, value: number): number {
  const { step } = knobs[key];
  return clampKnob(key, Number((Math.round(value / step) * step).toFixed(4)));
}

/** Slider position for a value. Blur uses a square curve so small radii get most of the track. */
export function toSlider(key: Knob, value: number): number {
  const { min, max } = knobs[key];
  const curve = curveOf(key);
  const v = clampKnob(key, value);
  if (curve === "ease") return Math.sqrt((v - min) / (max - min)) * SLIDER_SPAN;
  if (curve === "zoom") {
    const t = v <= 1 ? ZOOM_KNEE * (v - min) / (1 - min) : ZOOM_KNEE + (1 - ZOOM_KNEE) * Math.sqrt((v - 1) / (max - 1));
    return t * SLIDER_SPAN;
  }
  return v;
}

export function fromSlider(key: Knob, position: number): number {
  const { min, max } = knobs[key];
  const curve = curveOf(key);
  if (!curve) return roundKnob(key, position);
  const t = Math.min(1, Math.max(0, position / SLIDER_SPAN));
  if (curve === "ease") return roundKnob(key, min + (max - min) * t * t);
  const value = t <= ZOOM_KNEE ? min + (1 - min) * t / ZOOM_KNEE : 1 + (max - 1) * ((t - ZOOM_KNEE) / (1 - ZOOM_KNEE)) ** 2;
  return roundKnob(key, value);
}

/** Share of the track (0..1) at which a value sits, for fills and the default tick. */
export function trackFraction(key: Knob, value: number): number {
  const { min, max } = knobs[key];
  return curveOf(key) ? toSlider(key, value) / SLIDER_SPAN : (clampKnob(key, value) - min) / (max - min);
}

/** Ratios (1 = 100%) are shown and typed as percentages; everything else in its own unit. */
function displayFactor(key: Knob): number {
  return knobs[key].unit === "%" && !isTransparency(key) && key !== "positionX" && key !== "positionY" ? 100 : 1;
}

export function displayNumber(key: Knob, value: number): number {
  return Number((value * displayFactor(key)).toFixed(2));
}

/** Parse what the user typed ("100", "100%", "18px", "1.5×"); out-of-range values are clamped. */
export function parseKnobInput(key: Knob, text: string): { value: number; clamped: boolean } | null {
  const match = /^\s*(-?\d+(?:[.,]\d+)?)\s*(%|px|×|x)?\s*$/i.exec(text);
  if (!match) return null;
  const raw = Number(match[1]!.replace(",", ".")) / displayFactor(key);
  if (!Number.isFinite(raw)) return null;
  const value = roundKnob(key, raw);
  return { value, clamped: Math.abs(value - raw) > knobs[key].step / 2 };
}

/** Keyboard step in the value's own unit, so curved sliders still move by 1px / 1%. */
export function stepKnob(key: Knob, value: number, direction: number, large: boolean): number {
  return roundKnob(key, value + direction * knobs[key].step * (large ? 10 : 1));
}

export function knobRangeText(key: Knob): string {
  const { min, max } = knobs[key];
  return `${formatKnob(key, min)}–${formatKnob(key, max)}`;
}

export function formatKnob(key: Knob, value: number): string {
  if (isTransparency(key) || key === "positionX" || key === "positionY") return `${Math.round(value)}%`;
  if (knobs[key].unit === "%") return `${Math.round(value * 100)}%`;
  if (key === "radius") return `${Number(value.toFixed(2))}×`;
  return `${Math.round(value)}${knobs[key].unit}`;
}

/** The slider value for one axis; a position the sliders cannot represent shows as centered. */
export function positionValue(position: string | undefined, axis: 0 | 1): number {
  return positionAxes(position)?.[axis] ?? 50;
}

export function knobValue(look: ResolvedLook, wallpaper: ResolvedWallpaper | null, key: Knob): number {
  if (key === "transparency") return Math.round((1 - look.glass.opacity) * 100);
  if (key === "glassBlur") return look.glass.blur;
  const region = regionOf(key);
  if (region) return isTransparency(key) ? Math.round((1 - look.glass.regions[region].opacity) * 100) : look.glass.regions[region].blur;
  if (key === "radius") return look.radius ?? knobs.radius.fallback;
  if (key === "positionX") return positionValue(wallpaper?.position, 0);
  if (key === "positionY") return positionValue(wallpaper?.position, 1);
  return wallpaper?.[key as "blur" | "saturate" | "contrast" | "grayscale" | "scale" | "brightness"] ?? knobs[key].fallback;
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
  /** Transparency (0..100) per region; omitted means every region follows `transparency`. */
  regions?: Record<GlassRegion, number>;
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
  hints: { primary: string | null; wallpaper: string | null; material: string | null; region: string | null };
}

/** Explain why a control would look broken: what hides its effect, and what to change instead. */
export function diagnose({ wallpaper, transparency, regions: given, fit, scale, blur, image, viewport }: DiagnosisInput): Diagnosis {
  const disabled: Diagnosis["disabled"] = {};
  const hints: Diagnosis["hints"] = { primary: null, wallpaper: null, material: null, region: null };
  const regions = given ?? { frame: transparency, main: transparency, card: transparency, input: transparency };
  const opaque = Object.values(regions).every((value) => value <= 0);
  // The frame paints the whole window (the sidebar is the frame showing), so nothing behind it can
  // show while it is opaque: not the wallpaper, not the material.
  const frameOpaque = regions.frame <= 0;
  if (opaque) {
    disabled.glassBlur = "界面不透明时，模糊没有可透出的内容";
    hints.primary = wallpaper ? "界面当前不透明，壁纸被遮住。调高「界面透明」即可显示。" : "界面当前不透明，调高「界面透明」后界面模糊才生效。";
    hints.material = "界面不透明时看不到原生材质。";
  } else if (frameOpaque) {
    hints.primary = wallpaper ? "侧栏不透明，壁纸被遮住。在「分区玻璃」调高侧栏透明即可显示。" : null;
    hints.material = "侧栏不透明时看不到原生材质。";
    hints.region = "侧栏是整个窗口的底层：它不透明时，其他区域只能透出侧栏的颜色。";
  } else if (wallpaper) hints.material = "壁纸会盖住原生材质，清除壁纸后可见。";
  for (const key of ["mainBlur", "cardBlur", "inputBlur"] as const) {
    if (regions[regionOf(key)!] <= 0) disabled[key] = "这个区域不透明时，模糊没有可透出的内容";
  }
  if (!hints.region && mainCappedByFrame({
    frame: { opacity: 1 - regions.frame / 100, blur: 0 }, main: { opacity: 1 - regions.main / 100, blur: 0 },
    card: { opacity: 1, blur: 0 }, input: { opacity: 1, blur: 0 },
  })) hints.region = "主区域叠在侧栏之上，看起来最多和侧栏一样透明；想更通透，先调高侧栏透明。";
  if (!wallpaper) {
    for (const key of Object.keys(knobs) as Knob[]) if (knobs[key].group === "wallpaper" || key === "brightness") disabled[key] = "还没有壁纸";
    hints.wallpaper = "先在上方选择一张壁纸，再调整这些选项。";
    return { disabled, hints };
  }
  if (frameOpaque) hints.wallpaper = "壁纸正被不透明的界面遮住，调整结果暂时看不到。";
  const slack = positionSlack(fit, scale, blur, image, viewport);
  if (fit === "fill" && slack && !slack.x && !slack.y) {
    disabled.positionX = disabled.positionY = "拉伸铺满时位置不起作用";
    hints.wallpaper ??= "拉伸铺满时位置不起作用，放大图片后可调整。";
  } else if (slack && !slack.x && !slack.y) hints.wallpaper ??= "当前窗口下图片正好铺满，位置不会变化；放大图片后可移动取景。";
  else if (slack && !slack.x) hints.wallpaper ??= "当前窗口下图片左右没有余量，水平位置不会变化。";
  else if (slack && !slack.y) hints.wallpaper ??= "当前窗口下图片上下没有余量，垂直位置不会变化。";
  return { disabled, hints };
}
