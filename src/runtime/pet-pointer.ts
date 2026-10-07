// Desktop mode's click-through decision, in the spirit of petween-desktop's pointer-through logic.
// Pure, no electron imports: pet-desktop.ts feeds it the cursor and applies the result.
//
// The window has three native states:
//   through      setIgnoreMouseEvents(true): clicks pass, the page sees nothing, no hook installed.
//   forward      setIgnoreMouseEvents(true, { forward: true }): clicks still pass, but the page gets
//                mouse moves so it can tell picture from transparency. Forwarding is a system-wide
//                low-level mouse hook (WH_MOUSE_LL): left on, it makes the cursor flicker in other
//                windows and can silently stop (electron#33281), so it is only on near the pet.
//   interactive  setIgnoreMouseEvents(false): the pet takes the click.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PointerMode = "through" | "forward" | "interactive";

/** The page's verdict on the last mouse move it saw, in window (client) coordinates. */
export interface PointerReport {
  /** The picture's own pixels or an open speech bubble are under (x, y). */
  hit: boolean;
  x: number;
  y: number;
  /** The picture's box; the "near" band is measured from it. */
  body: Rect | null;
}

export interface PointerInputs {
  /** Screen coordinates (DIP); null when unknown. */
  cursor: Point | null;
  /** The window's content bounds on screen. */
  window: Rect;
  report: PointerReport | null;
  dragging: boolean;
}

export interface PointerState {
  mode: PointerMode;
  near: boolean;
}

export const POINTER_TIMING = {
  /** Main-process cursor poll: the fallback when the page hears nothing. */
  pollMs: 250,
  /** Native state is set again this often, and after drags, display changes and resume. */
  reissueMs: 5000,
  /** A drag the page never ended (renderer gone) stops holding the window after this long. */
  dragHoldMs: 10_000,
};

/** Forwarding starts within this distance of the picture and stops beyond the larger one. */
export const NEAR_ENTER = 96;
export const NEAR_EXIT = 128;
/** A report still describes the cursor while the cursor is within this many px of it. */
const SAME_POINT = 3;

const within = (point: Point, rect: Rect, margin: number) =>
  point.x >= rect.x - margin && point.x <= rect.x + rect.width + margin && point.y >= rect.y - margin && point.y <= rect.y + rect.height + margin;

export function decidePointer(inputs: PointerInputs, previous: PointerState): PointerState {
  const { cursor, window, report } = inputs;
  // A drag moves the window with the cursor, so the cursor stays on it (give or take a frame of
  // lag). Once it is well off the window the drag has stalled (the page hung mid-drag): let go
  // rather than keep a whole window of clicks until dragHoldMs runs out.
  if (inputs.dragging && (!cursor || within(cursor, window, NEAR_EXIT))) return { mode: "interactive", near: true };
  if (!cursor) return { mode: "through", near: false };
  const body = report?.body ? { ...report.body, x: report.body.x + window.x, y: report.body.y + window.y } : window;
  const near = within(cursor, body, previous.near ? NEAR_EXIT : NEAR_ENTER);
  // Only a report made at the cursor's current spot counts: once the cursor has moved without a
  // new report (forwarding stalled, the pointer left the window), the pet lets go.
  const onPet = !!report?.hit && within(cursor, window, 0) &&
    Math.abs(cursor.x - window.x - report.x) <= SAME_POINT && Math.abs(cursor.y - window.y - report.y) <= SAME_POINT;
  return { mode: onPet ? "interactive" : near ? "forward" : "through", near: near || onPet };
}

/**
 * The window point the page should hit-test on the next poll, or null. Needed while the cursor is
 * over the window with no report for where it is now: it got there faster than forwarding was
 * switched on and then stopped, or forwarding stalled. Without it she would stay click-through
 * under a resting cursor until it moved again.
 */
export function probePoint(inputs: PointerInputs, state: PointerState): Point | null {
  const { cursor, window, report } = inputs;
  if (inputs.dragging || !state.near || !cursor || !within(cursor, window, 0)) return null;
  const x = cursor.x - window.x, y = cursor.y - window.y;
  if (report && Math.abs(x - report.x) <= SAME_POINT && Math.abs(y - report.y) <= SAME_POINT) return null;
  return { x, y };
}

/** A page's report, checked field by field; null for anything malformed. */
export function parsePointerReport(raw: unknown): PointerReport | null {
  if (!raw || typeof raw !== "object") return null;
  const { hit, x, y, body } = raw as Record<string, unknown>;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  if (typeof hit !== "boolean" || !finite(x) || !finite(y)) return null;
  let rect: Rect | null = null;
  if (body && typeof body === "object") {
    const r = body as Record<string, unknown>;
    if (finite(r.x) && finite(r.y) && finite(r.width) && finite(r.height) && r.width >= 0 && r.height >= 0) rect = { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  return { hit, x, y, body: rect };
}
