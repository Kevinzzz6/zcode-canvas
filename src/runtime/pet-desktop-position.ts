// Where the desktop-mode pet sits. Pure, no electron imports: pet-desktop.ts hands in the displays'
// work areas. The position is kept as distances from the nearest edges of a work area rather than
// absolute coordinates, so a resolution change, a moved taskbar or an unplugged monitor puts her
// back on screen in the same corner instead of somewhere off it.
import type { Point, Rect } from "./pet-pointer.ts";

export interface DesktopPetPosition {
  h: "left" | "right";
  /** Distance from that horizontal edge of the work area, px. */
  dx: number;
  v: "top" | "bottom";
  dy: number;
  /** The work area it was measured in, to find the same monitor again. */
  area?: Rect;
}

export const DEFAULT_DESKTOP_POSITION: DesktopPetPosition = { h: "right", dx: 0, v: "bottom", dy: 0 };

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const isRect = (r: unknown): r is Rect => {
  const o = r as Record<string, unknown> | null;
  return !!o && typeof o === "object" && finite(o.x) && finite(o.y) && finite(o.width) && finite(o.height) && o.width > 0 && o.height > 0;
};

/** The saved file's content; anything unreadable falls back to the bottom-right corner. */
export function parseDesktopPosition(raw: unknown): DesktopPetPosition {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DESKTOP_POSITION };
  const { h, dx, v, dy, area } = raw as Record<string, unknown>;
  if ((h !== "left" && h !== "right") || (v !== "top" && v !== "bottom") || !finite(dx) || !finite(dy) || dx < 0 || dy < 0) return { ...DEFAULT_DESKTOP_POSITION };
  return { h, dx, v, dy, ...(isRect(area) ? { area: { x: area.x, y: area.y, width: area.width, height: area.height } } : {}) };
}

const center = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const distance = (a: Point, b: Rect) => {
  const dx = Math.max(b.x - a.x, 0, a.x - (b.x + b.width));
  const dy = Math.max(b.y - a.y, 0, a.y - (b.y + b.height));
  return Math.hypot(dx, dy);
};

/** The work area the position belongs to: the same one if it still exists, else the nearest, else the primary. */
export function chooseArea(position: DesktopPetPosition, areas: readonly Rect[], primary: Rect): Rect {
  const saved = position.area;
  if (!saved) return primary;
  const same = areas.find((a) => a.x === saved.x && a.y === saved.y && a.width === saved.width && a.height === saved.height);
  if (same) return same;
  const point = center(saved);
  return [...areas].sort((a, b) => distance(point, a) - distance(point, b))[0] ?? primary;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** The window for a box of `size` in `area`, always fully inside it (or at its top-left if it cannot fit). */
export function boundsFromPosition(position: DesktopPetPosition, area: Rect, size: number): Rect {
  const left = position.h === "left" ? area.x + position.dx : area.x + area.width - size - position.dx;
  const top = position.v === "top" ? area.y + position.dy : area.y + area.height - size - position.dy;
  return {
    x: Math.round(clamp(left, area.x, area.x + area.width - size)),
    y: Math.round(clamp(top, area.y, area.y + area.height - size)),
    width: size,
    height: size,
  };
}

/** Measured from the nearer edge on each axis. */
export function positionFromBounds(bounds: Rect, area: Rect): DesktopPetPosition {
  const left = bounds.x - area.x, right = area.x + area.width - (bounds.x + bounds.width);
  const top = bounds.y - area.y, bottom = area.y + area.height - (bounds.y + bounds.height);
  return {
    h: left < right ? "left" : "right",
    dx: Math.max(0, Math.round(Math.min(left, right))),
    v: top < bottom ? "top" : "bottom",
    dy: Math.max(0, Math.round(Math.min(top, bottom))),
    area: { ...area },
  };
}

/**
 * Where a dropped window ends up: like the in-window pet, each axis snaps to the work area's edge
 * when the box's center is in that edge's outer quarter, independently; otherwise it stays, kept
 * inside the work area.
 */
export function snapToArea(bounds: Rect, area: Rect): Rect {
  const axis = (start: number, size: number, from: number, span: number) => {
    const middle = start + size / 2 - from;
    if (middle < span / 4) return from;
    if (middle > (span * 3) / 4) return from + span - size;
    return clamp(start, from, from + span - size);
  };
  return {
    x: Math.round(axis(bounds.x, bounds.width, area.x, area.width)),
    y: Math.round(axis(bounds.y, bounds.height, area.y, area.height)),
    width: bounds.width,
    height: bounds.height,
  };
}

/** As in the window: against the left edge she turns to face the screen. */
export function facesLeft(position: DesktopPetPosition): boolean {
  return position.h === "left" && position.dx === 0;
}
