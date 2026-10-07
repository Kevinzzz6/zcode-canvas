// The desktop-mode pet page (pet-desktop.html): the shared display filling Canvas's own window.
// The main process places and moves the window and decides when it takes clicks; this page only
// says what is under the cursor (her picture or her bubble, or nothing) and when she is dragged.
import { decodePet } from "../shared/pet.ts";
import { createPetDisplay } from "./pet-display.ts";

/** Exposed by pet-desktop-preload.ts. */
interface PetPageApi {
  get(): Promise<unknown>;
  onUpdate(listener: (payload: unknown) => void): void;
  onFacing(listener: (left: boolean) => void): void;
  onProbe(listener: (x: number, y: number) => void): void;
  pointer(report: unknown): void;
  drag(kind: "start" | "move" | "end"): void;
  log(message: string): void;
}

const api = (window as unknown as { zcodeCanvasPet?: PetPageApi }).zcodeCanvasPet;

if (api) {
  const log = (message: string) => { try { api.log(message); } catch { /* Nowhere left to report. */ } };
  try {
    // The bubble's colors follow ZCode's light or dark theme, which ZCode applies app-wide.
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const theme = () => document.documentElement.classList.toggle("dark", dark.matches);
    theme();
    dark.addEventListener("change", theme);

    const host = document.createElement("zcode-canvas-pet");
    host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;";
    document.body.append(host);
    const display = createPetDisplay(host, {
      start: () => api.drag("start"),
      move: () => api.drag("move"),
      drop: () => api.drag("end"),
    }, log);

    let facing = false;
    let last = { x: -1, y: -1 };
    const report = () => {
      const { x, y } = last;
      const body = display.figureRect();
      api.pointer({ hit: display.hits(x, y) || display.hitsBubble(x, y), x, y, body: { x: body.left, y: body.top, width: body.width, height: body.height } });
    };
    const layout = () => {
      display.place(0, 0, Math.min(innerWidth, innerHeight));
      display.face(facing);
      report();
    };
    const show = (payload: unknown) => {
      const view = decodePet(payload);
      if (view && display.update(view)) layout();
    };
    api.onUpdate((payload) => { try { show(payload); } catch (error) { log(`update: ${String(error)}`); } });
    api.onFacing((left) => { try { facing = left; layout(); } catch (error) { log(`facing: ${String(error)}`); } });
    // The main process asks about the cursor's spot when no move reported it (see pet-pointer.ts).
    api.onProbe((x, y) => {
      try {
        if (display.dragging()) return;
        last = { x, y };
        display.track(x, y);
        report();
      } catch (error) { log(`probe: ${String(error)}`); }
    });
    api.get().then(show).catch((error: unknown) => log(`get: ${String(error)}`));
    addEventListener("resize", () => { try { layout(); } catch (error) { log(`resize: ${String(error)}`); } });
    // Moves arrive while the cursor is near her (forwarded) or over her picture (the window takes
    // the pointer); every one is reported, so the verdict always describes where the cursor is now.
    addEventListener("mousemove", (event) => {
      try {
        if (display.dragging()) return;
        last = { x: event.clientX, y: event.clientY };
        report();
      } catch (error) { log(`pointer: ${String(error)}`); }
    }, { passive: true });
  } catch (error) {
    log(`page: ${String(error)}`);
  }
}
