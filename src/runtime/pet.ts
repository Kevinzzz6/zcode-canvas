// The desktop pet inside ZCode's main window: where her box sits, drag-and-snap to the window's
// edges, and the position kept in localStorage. What she looks like and how she reacts is
// pet-display.ts, shared with desktop mode (pet-desktop-page.ts); in desktop mode this one stays
// hidden. Isolated, owned DOM only (closed Shadow DOM); it never queries or observes ZCode's DOM.
import { petBase } from "../shared/pet.ts";
import { createPetDisplay, type PetDisplay, type PetView } from "./pet-display.ts";

export type { PetView } from "./pet-display.ts";

interface PetApi {
  log(message: string): void;
}

const PREF_KEY = "zcode-canvas:pet:v1";
/** Keeps the pet off ZCode's title bar and window buttons. */
const TOP_MARGIN = 32;

/** Position as fractions of the free space on each axis; 0 / 1 are the snapped edges. */
interface PetPosition {
  x: number;
  y: number;
}

const DEFAULT_POSITION: PetPosition = { x: 1, y: 1 };

/**
 * Where a dropped box ends up: each axis snaps to its edge when the box's center is in the outer
 * quarter of the window, independently, so corners combine (the fox widget's quarter snap).
 */
export function snapPosition(left: number, top: number, base: number, width: number, height: number): PetPosition {
  const free = (span: number) => Math.max(0, span - base);
  const fraction = (offset: number, span: number) => (free(span) ? Math.min(1, Math.max(0, offset / free(span))) : 1);
  const axis = (offset: number, span: number, center: number) => (center < span / 4 ? 0 : center > (span * 3) / 4 ? 1 : fraction(offset, span));
  return {
    x: axis(left, width, left + base / 2),
    y: axis(top - TOP_MARGIN, height - TOP_MARGIN, top - TOP_MARGIN + base / 2),
  };
}

function readPosition(raw: string | null): PetPosition {
  try {
    const saved = JSON.parse(raw ?? "null") as Partial<PetPosition> | null;
    const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
    return saved && valid(saved.x) && valid(saved.y) ? { x: saved.x, y: saved.y } : { ...DEFAULT_POSITION };
  } catch {
    return { ...DEFAULT_POSITION };
  }
}

export function mountPet(api: PetApi): { update(view: PetView): void } {
  let view: PetView | null = null;
  let display: PetDisplay | null = null;
  let position = readPosition(safeGet());
  let box = { left: 0, top: 0, base: 0 };
  let from = { left: 0, top: 0 };
  const removers: Array<() => void> = [];
  const report = (where: string) => (error: unknown) => api.log(`pet ${where}: ${String(error)}`);
  const guard = <A extends unknown[]>(where: string, action: (...args: A) => void) => (...args: A) => {
    try { action(...args); } catch (error) { report(where)(error); }
  };

  function safeGet(): string | null {
    try { return localStorage.getItem(PREF_KEY); } catch { return null; }
  }
  function savePosition() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(position)); } catch (error) { report("position")(error); }
  }

  function layout() {
    if (!display || !view) return;
    const base = petBase(innerWidth, innerHeight, view.pet.scale);
    const left = Math.max(0, innerWidth - base) * position.x;
    const top = TOP_MARGIN + Math.max(0, innerHeight - TOP_MARGIN - base) * position.y;
    box = { left, top, base };
    display.place(left, top, base);
    display.face(position.x === 0);
  }

  function build(): PetDisplay {
    const host = document.createElement("zcode-canvas-pet");
    // Below the appearance panel (2147483000), above ZCode's own layers.
    host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147482000;";
    document.documentElement.append(host);
    const built = createPetDisplay(host, {
      start: () => { from = { left: box.left, top: box.top }; },
      move: (dx, dy) => {
        const left = Math.min(Math.max(0, innerWidth - box.base), Math.max(0, from.left + dx));
        const top = Math.min(Math.max(TOP_MARGIN, innerHeight - box.base), Math.max(TOP_MARGIN, from.top + dy));
        built.place(left, top, box.base);
        box = { ...box, left, top };
      },
      drop: () => {
        position = snapPosition(box.left, box.top, box.base, innerWidth, innerHeight);
        savePosition();
        layout();
      },
    }, api.log);
    const on = (name: string, action: (event: Event) => void) => {
      const listener = guard(name, action);
      addEventListener(name, listener);
      removers.push(() => removeEventListener(name, listener));
    };
    on("resize", layout);
    on("storage", (event) => {
      if ((event as StorageEvent).key !== PREF_KEY) return;
      position = readPosition((event as StorageEvent).newValue);
      layout();
    });
    on("pagehide", () => {
      for (const remove of removers.splice(0)) remove();
      display?.dispose();
      display = null;
    });
    return built;
  }

  function update(next: PetView) {
    view = next;
    // In desktop mode the one pet lives in Canvas's own window; this one hides like a turned-off pet.
    const here = next.pet.enabled && !next.pet.desktop;
    if (!here && !display) return;
    display ??= build();
    if (display.update(here ? next : { ...next, pet: { ...next.pet, enabled: false } })) layout();
  }

  return { update: guard("update", update) };
}
