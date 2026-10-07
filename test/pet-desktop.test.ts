import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { desktopPetSupported, decodePet, encodePet, parsePetPatch, resolvePet } from "../src/shared/pet.ts";
import { CHANNEL_PET_DRAG, CHANNEL_PET_FACING, CHANNEL_PET_POINTER } from "../src/shared/protocol.ts";
import { createDesktopPet, DESKTOP_PET_PARTITION, type DesktopPetElectron } from "../src/runtime/pet-desktop.ts";
import { boundsFromPosition, chooseArea, DEFAULT_DESKTOP_POSITION, facesLeft, parseDesktopPosition, positionFromBounds, snapToArea } from "../src/runtime/pet-desktop-position.ts";
import { decidePointer, NEAR_ENTER, NEAR_EXIT, parsePointerReport, POINTER_TIMING, probePoint, type PointerState } from "../src/runtime/pet-pointer.ts";

const AREA = { x: 0, y: 0, width: 2048, height: 1240 };

test("desktop mode is a Windows-only switch, off by default, and survives the payload round trip", () => {
  assert.equal(desktopPetSupported("win32"), true);
  assert.equal(desktopPetSupported("darwin"), false);
  assert.equal(desktopPetSupported("linux"), false);
  assert.equal(resolvePet({ enabled: true }, true, true).desktop, false, "off unless asked for");
  assert.equal(resolvePet({ enabled: true, desktop: true }, true, true).desktop, true);
  assert.equal(resolvePet({ enabled: true, desktop: true }, true, false).desktop, false, "unsupported platforms keep the pet in the windows");
  assert.equal(resolvePet({ enabled: true, desktop: "yes" }, true, true).desktop, false);
  assert.deepEqual(parsePetPatch({ desktop: true }), { desktop: true });
  assert.throws(() => parsePetPatch({ desktop: "true" }));
  const assets = { image: "file:///a.png", sounds: { duck: { press: "file:///1", release: "file:///2" }, fx1: { press: "file:///3", release: "file:///4" } } };
  const pet = resolvePet({ enabled: true, desktop: true }, true, true);
  assert.equal(decodePet(encodePet(pet, "idle", assets))?.pet.desktop, true, "the page sees the main process's decision unchanged");
});

// --- Click-through ---

const win = { x: 1000, y: 600, width: 300, height: 300 };
const body = { x: 120, y: 120, width: 180, height: 180 };
const far: PointerState = { mode: "through", near: false };
const decide = (cursor: { x: number; y: number } | null, previous: PointerState = far, report: Parameters<typeof decidePointer>[0]["report"] = null, dragging = false) =>
  decidePointer({ cursor, window: win, report, dragging }, previous);

test("click-through: plain far away, forwarding only near her, interactive only on her pixels", () => {
  assert.deepEqual(decide({ x: 100, y: 100 }), { mode: "through", near: false }, "far: no hook at all");
  assert.equal(decide(null).mode, "through");
  // Near band measured from the picture's box (window + body), not the whole transparent window.
  const left = win.x + body.x;
  assert.equal(decide({ x: left - NEAR_ENTER + 1, y: 800 }, far, { hit: false, x: 0, y: 0, body }).mode, "forward");
  assert.equal(decide({ x: left - NEAR_ENTER - 2, y: 800 }, far, { hit: false, x: 0, y: 0, body }).mode, "through");
  const report = { hit: true, x: 200, y: 200, body };
  assert.equal(decide({ x: 1200, y: 800 }, far, report).mode, "interactive", "a fresh hit at the cursor");
  assert.equal(decide({ x: 1200, y: 800 }, far, { ...report, hit: false }).mode, "forward", "transparent pixel: clicks pass through");
});

test("click-through: entering and leaving the band use different distances", () => {
  const report = { hit: false, x: 0, y: 0, body };
  const left = win.x + body.x;
  const between = { x: left - (NEAR_ENTER + NEAR_EXIT) / 2, y: 800 };
  assert.equal(decide(between, far, report).mode, "through", "not yet near: entering needs the inner distance");
  assert.equal(decide(between, { mode: "forward", near: true }, report).mode, "forward", "already near: stays until the outer distance");
  assert.equal(decide({ x: left - NEAR_EXIT - 2, y: 800 }, { mode: "forward", near: true }, report).mode, "through");
});

test("click-through: a verdict only counts where it was made; dragging holds the window", () => {
  const report = { hit: true, x: 200, y: 200, body };
  assert.equal(decide({ x: 1202, y: 798 }, far, report).mode, "interactive", "a couple of px of jitter is the same spot");
  assert.equal(decide({ x: 1220, y: 800 }, far, report).mode, "forward", "moved without a new report (forwarding stalled): let go");
  assert.equal(decide({ x: 900, y: 500 }, far, { ...report, x: -100, y: -100 }).mode !== "interactive", true, "outside the window never takes clicks");
  assert.deepEqual(decide({ x: 1100, y: 700 }, far, null, true), { mode: "interactive", near: true }, "mid-drag the window keeps the pointer, report or not");
  assert.equal(decide({ x: win.x - NEAR_EXIT + 5, y: 700 }, far, null, true).mode, "interactive", "a frame of lag behind a fast drag is fine");
  assert.equal(decide({ x: 50, y: 50 }, far, null, true).mode, "through", "a drag whose window stopped following (page hung) lets go");
  assert.ok(POINTER_TIMING.pollMs <= 250 && POINTER_TIMING.reissueMs > 0 && POINTER_TIMING.dragHoldMs > 0);
});

test("click-through: a cursor that came to rest over the window without a report gets probed", () => {
  const inputs = (cursor: { x: number; y: number }, report: Parameters<typeof probePoint>[0]["report"] = null, dragging = false) => ({ cursor, window: win, report, dragging });
  const near: PointerState = { mode: "forward", near: true };
  // Flicked onto her faster than one poll and stopped: no move was ever forwarded at this spot.
  assert.deepEqual(probePoint(inputs({ x: 1200, y: 800 }), near), { x: 200, y: 200 });
  assert.deepEqual(probePoint(inputs({ x: 1200, y: 800 }, { hit: false, x: 20, y: 20, body }), near), { x: 200, y: 200 }, "a report from elsewhere is stale");
  assert.equal(probePoint(inputs({ x: 1201, y: 800 }, { hit: true, x: 200, y: 200, body }), near), null, "already reported here");
  assert.equal(probePoint(inputs({ x: 1200, y: 800 }), far), null, "not near: nothing to ask");
  assert.equal(probePoint(inputs({ x: 950, y: 800 }), near), null, "near but outside the window: the page cannot tell");
  assert.equal(probePoint(inputs({ x: 1200, y: 800 }, null, true), near), null, "not mid-drag");
});

test("pointer reports from the page are checked field by field", () => {
  assert.deepEqual(parsePointerReport({ hit: true, x: 1, y: 2, body: { x: 0, y: 0, width: 5, height: 5 } }), { hit: true, x: 1, y: 2, body: { x: 0, y: 0, width: 5, height: 5 } });
  assert.deepEqual(parsePointerReport({ hit: false, x: 1, y: 2, body: { x: 0, y: 0, width: -5, height: 5 } }), { hit: false, x: 1, y: 2, body: null });
  for (const bad of [null, "x", { hit: "yes", x: 1, y: 2 }, { hit: true, x: Number.NaN, y: 2 }, { hit: true, x: 1 }]) assert.equal(parsePointerReport(bad), null);
});

// --- Position ---

test("the position is kept as distances from the nearest work-area edges", () => {
  assert.deepEqual(positionFromBounds({ x: 20, y: 900, width: 300, height: 300 }, AREA), { h: "left", dx: 20, v: "bottom", dy: 40, area: AREA });
  assert.deepEqual(positionFromBounds({ x: 1700, y: 10, width: 300, height: 300 }, AREA), { h: "right", dx: 48, v: "top", dy: 10, area: AREA });
  const position = positionFromBounds({ x: 1700, y: 10, width: 300, height: 300 }, AREA);
  assert.deepEqual(boundsFromPosition(position, AREA, 300), { x: 1700, y: 10, width: 300, height: 300 }, "round trip");
  // A smaller screen keeps the same corner and distance instead of the same absolute spot.
  const small = { x: 0, y: 0, width: 1280, height: 680 };
  assert.deepEqual(boundsFromPosition(position, small, 300), { x: 932, y: 10, width: 300, height: 300 });
});

test("restoring always lands fully inside a work area, whatever was saved", () => {
  assert.deepEqual(boundsFromPosition({ h: "left", dx: 5000, v: "top", dy: 5000 }, AREA, 300), { x: 1748, y: 940, width: 300, height: 300 });
  assert.deepEqual(boundsFromPosition(DEFAULT_DESKTOP_POSITION, { x: -1920, y: 0, width: 1920, height: 1040 }, 300), { x: -300, y: 740, width: 300, height: 300 });
  assert.deepEqual(boundsFromPosition(DEFAULT_DESKTOP_POSITION, { x: 0, y: 0, width: 200, height: 200 }, 300), { x: 0, y: 0, width: 300, height: 300 }, "too small: top-left, never off the start");
  for (const bad of [null, "x", { h: "up", dx: 0, v: "top", dy: 0 }, { h: "left", dx: -1, v: "top", dy: 0 }, { h: "left", dx: 0, v: "top" }]) assert.deepEqual(parseDesktopPosition(bad), DEFAULT_DESKTOP_POSITION);
  assert.deepEqual(parseDesktopPosition({ h: "left", dx: 3, v: "top", dy: 4, area: { x: 0, y: 0, width: 0, height: 9 } }), { h: "left", dx: 3, v: "top", dy: 4 }, "a broken area is dropped");
});

test("the monitor it was on is found again; an unplugged one falls back to the nearest", () => {
  const primary = { x: 0, y: 0, width: 2048, height: 1240 };
  const right = { x: 2048, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(chooseArea({ ...DEFAULT_DESKTOP_POSITION, area: right }, [primary, right], primary), right);
  assert.deepEqual(chooseArea({ ...DEFAULT_DESKTOP_POSITION, area: { x: 4000, y: 0, width: 1920, height: 1040 } }, [primary, right], primary), right, "nearest to where it was");
  assert.deepEqual(chooseArea({ ...DEFAULT_DESKTOP_POSITION, area: right }, [primary], primary), primary);
  assert.deepEqual(chooseArea(DEFAULT_DESKTOP_POSITION, [primary, right], primary), primary, "no area saved: the primary");
});

test("a drop snaps to work-area edges by quarters and she faces right except against the left edge", () => {
  assert.deepEqual(snapToArea({ x: 100, y: 800, width: 300, height: 300 }, AREA), { x: 0, y: 940, width: 300, height: 300 }, "bottom-left corner");
  assert.deepEqual(snapToArea({ x: 900, y: 400, width: 300, height: 300 }, AREA), { x: 900, y: 400, width: 300, height: 300 }, "free in the middle");
  assert.deepEqual(snapToArea({ x: 900, y: -200, width: 300, height: 300 }, AREA), { x: 900, y: 0, width: 300, height: 300 });
  assert.deepEqual(snapToArea({ x: 2100, y: 400, width: 300, height: 300 }, AREA), { x: 1748, y: 400, width: 300, height: 300 }, "dragged past the edge: pulled back");
  assert.equal(facesLeft(positionFromBounds({ x: 0, y: 940, width: 300, height: 300 }, AREA)), true);
  assert.equal(facesLeft(positionFromBounds({ x: 10, y: 940, width: 300, height: 300 }, AREA)), false);
  assert.equal(facesLeft(DEFAULT_DESKTOP_POSITION), false);
});

// --- Window lifecycle, against a stand-in for electron with its observed behavior ---

class FakeContents extends EventEmitter {
  static alive = new Set<FakeContents>();
  destroyed = false;
  sent: Array<[string, unknown]> = [];
  loaded = "";
  /** Whether the window was already showing when loading began. */
  loadedShown = false;
  openHandler: (() => unknown) | null = null;
  constructor() { super(); FakeContents.alive.add(this); }
  isDestroyed() { return this.destroyed; }
  close() {
    if (FakeContents.failClose) throw new Error("Object has been destroyed");
    this.destroyed = true; FakeContents.alive.delete(this); this.emit("destroyed");
  }
  send(channel: string, payload: unknown) { this.sent.push([channel, payload]); }
  setWindowOpenHandler(handler: () => unknown) { this.openHandler = handler; }
  static failLoad = false;
  static failClose = false;
  loadFile(file: string) {
    this.loaded = file;
    this.loadedShown = FakeWindow.all.at(-1)?.calls.some((call) => call[0] === "showInactive") ?? false;
    return FakeContents.failLoad ? Promise.reject(new Error("ERR_FILE_NOT_FOUND")) : Promise.resolve();
  }
}

class FakeView {
  static all: FakeView[] = [];
  webContents = new FakeContents();
  bounds: unknown = null;
  constructor(public options: { webPreferences: Record<string, unknown> }) { FakeView.all.push(this); }
  setBackgroundColor() {}
  setBounds(bounds: unknown) { this.bounds = bounds; }
}

class FakeWindow extends EventEmitter {
  static all: FakeWindow[] = [];
  destroyed = false;
  calls: unknown[][] = [];
  bounds: { x: number; y: number; width: number; height: number };
  children: FakeView[] = [];
  contentView = { addChildView: (view: FakeView) => { this.children.push(view); } };
  constructor(public options: Record<string, unknown>) {
    super();
    // Windows rounds a fresh frameless window up at fractional scaling.
    this.bounds = { x: options.x as number, y: options.y as number, width: (options.width as number) + 3, height: (options.height as number) + 3 };
    FakeWindow.all.push(this);
  }
  isDestroyed() { return this.destroyed; }
  // As measured: destroying a BaseWindow leaves its view's webContents (and renderer) alive.
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit("closed"); }
  getBounds() { return { ...this.bounds }; }
  getContentBounds() { return { ...this.bounds }; }
  setBounds(bounds: { x: number; y: number; width: number; height: number }) { this.calls.push(["setBounds", bounds]); this.bounds = { ...bounds }; }
  setPosition(...args: unknown[]) { this.calls.push(["setPosition", ...args]); }
  setContentProtection(...args: unknown[]) { this.calls.push(["setContentProtection", ...args]); }
  setIgnoreMouseEvents(...args: unknown[]) { this.calls.push(["setIgnoreMouseEvents", ...args]); }
  showInactive() { this.calls.push(["showInactive"]); }
  setAlwaysOnTop(...args: unknown[]) { this.calls.push(["setAlwaysOnTop", ...args]); }
}

function fakeElectron() {
  FakeWindow.all = [];
  FakeView.all = [];
  const ipc = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  const screenEvents = new Map<string, () => void>();
  let cursor = { x: 10, y: 10 };
  const electron = {
    BaseWindow: FakeWindow,
    WebContentsView: FakeView,
    screen: {
      getCursorScreenPoint: () => ({ ...cursor }),
      getPrimaryDisplay: () => ({ workArea: AREA }),
      getAllDisplays: () => [{ workArea: AREA }],
      getDisplayMatching: () => ({ workArea: AREA }),
      on: (name: string, listener: () => void) => { screenEvents.set(name, listener); },
    },
    ipcMain: { on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => { ipc.set(channel, listener); } },
    powerMonitor: { on: () => {} },
  } as unknown as DesktopPetElectron;
  return { electron, ipc, screenEvents, moveCursor: (x: number, y: number) => { cursor = { x, y }; } };
}

function setup() {
  const fake = fakeElectron();
  const home = mkdtempSync(join(tmpdir(), "zc-desktop-pet-"));
  const logged: string[] = [];
  const positionFile = join(home, "pet-position.json");
  const desktop = createDesktopPet({ electron: fake.electron, page: "C:/runtime/pet-desktop.html", preload: "C:/runtime/pet-desktop-preload.cjs", positionFile, log: (m) => logged.push(m) });
  return { ...fake, desktop, positionFile, logged };
}

const on = resolvePet({ enabled: true, desktop: true }, true, true);

test("the desktop window: BaseWindow, unfocusable, protected from capture, isolated session, never prevents close", () => {
  const { desktop } = setup();
  desktop.sync(on, 1);
  const [win] = FakeWindow.all;
  assert.ok(win);
  assert.equal(FakeWindow.all.length, 1);
  assert.deepEqual({ ...win.options, x: 0, y: 0, width: 0, height: 0 }, {
    frame: false, transparent: true, focusable: false, skipTaskbar: true, resizable: false, maximizable: false, minimizable: false,
    fullscreenable: false, hasShadow: false, show: false, x: 0, y: 0, width: 0, height: 0,
  });
  assert.deepEqual(win.calls.find((call) => call[0] === "setContentProtection"), ["setContentProtection", true]);
  assert.deepEqual(win.calls.find((call) => call[0] === "setIgnoreMouseEvents"), ["setIgnoreMouseEvents", true], "click-through before she is ever shown");
  const size = win.options.width as number;
  assert.deepEqual(win.bounds, { x: AREA.width - size, y: AREA.height - size, width: size, height: size }, "exact size, bottom-right by default");
  const [view] = FakeView.all;
  assert.deepEqual(view!.options.webPreferences, { partition: DESKTOP_PET_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, preload: "C:/runtime/pet-desktop-preload.cjs" });
  assert.equal(DESKTOP_PET_PARTITION.startsWith("persist:"), false, "in-memory session");
  const contents = view!.webContents;
  assert.deepEqual(contents.openHandler?.(), { action: "deny" });
  assert.equal(contents.loaded, "C:/runtime/pet-desktop.html");
  assert.equal(win.listenerCount("close"), 0, "nothing can hold up app.quit()");
  assert.equal(contents.loadedShown, true, "shown before the page loads: a view that starts painting in a hidden BaseWindow never reaches the screen");
  const order = win.calls.map((call) => call[0]);
  assert.ok(order.indexOf("setIgnoreMouseEvents") < order.indexOf("showInactive"), "click-through before it is shown");
  assert.ok(order.indexOf("showInactive") < order.indexOf("setAlwaysOnTop"));
  assert.deepEqual(win.calls.find((call) => call[0] === "setAlwaysOnTop"), ["setAlwaysOnTop", true, "screen-saver"]);
  contents.emit("did-finish-load");
  assert.deepEqual(win.calls.filter((call) => call[0] === "setAlwaysOnTop").length, 2, "set again once the page is there");
  assert.deepEqual(contents.sent.find(([channel]) => channel === CHANNEL_PET_FACING), [CHANNEL_PET_FACING, false]);
  desktop.sync(on, 0);
});

test("the pet goes the moment the last main page does, and comes back with the next one", () => {
  const { desktop } = setup();
  desktop.sync(resolvePet({ enabled: true, desktop: true }, true, false), 1);
  assert.equal(FakeWindow.all.length, 0, "unsupported platform: nothing is created");
  desktop.sync(resolvePet({ enabled: true }, true, true), 1);
  assert.equal(FakeWindow.all.length, 0, "desktop mode off: nothing is created");
  desktop.sync(on, 0);
  assert.equal(FakeWindow.all.length, 0, "no main page yet: nothing is created");
  desktop.sync(on, 2);
  desktop.sync(on, 1);
  assert.equal(FakeWindow.all.length, 1, "one pet for any number of windows");
  const first = FakeWindow.all[0]!;
  desktop.sync(on, 0);
  assert.equal(first.destroyed, true, "no main page left: destroyed synchronously");
  assert.equal(desktop.contents(), null);
  desktop.sync(on, 1);
  assert.equal(FakeWindow.all.length, 2, "a reopened window brings her back");
  desktop.sync(resolvePet({ enabled: false, desktop: true }, true, true), 1);
  assert.equal(FakeWindow.all[1]!.destroyed, true, "turning the pet off removes the window");
});

test("rebuilding the window never leaks its webContents", () => {
  const { desktop, screenEvents } = setup();
  const before = FakeContents.alive.size;
  desktop.sync(on, 1);
  assert.equal(FakeContents.alive.size, before + 1);
  screenEvents.get("display-metrics-changed")!();
  screenEvents.get("display-removed")!();
  desktop.sync(resolvePet({ enabled: true, desktop: true, scale: 1 }, true, true), 1);
  assert.equal(FakeWindow.all.length, 4, "rebuilt for scaling changes, monitors and a new size");
  assert.equal(FakeContents.alive.size, before + 1, "only the current page is alive");
  // The window closing by itself (ZCode quitting closes every window) also closes the page.
  FakeWindow.all.at(-1)!.destroy();
  assert.equal(FakeContents.alive.size, before);
  assert.equal(desktop.contents(), null);
  desktop.sync(on, 0);
});

test("only the pet page is heard; drags move the window at a fixed size and save where it lands", () => {
  const { desktop, ipc, moveCursor, positionFile } = setup();
  desktop.sync(on, 1);
  const win = FakeWindow.all[0]!;
  const page = FakeView.all[0]!.webContents;
  const size = win.bounds.width;
  const stranger = new FakeContents();
  assert.equal(desktop.isPage(page), true);
  assert.equal(desktop.isPage(stranger), false);
  const drag = ipc.get(CHANNEL_PET_DRAG)!;
  const pointer = ipc.get(CHANNEL_PET_POINTER)!;
  drag({ sender: stranger }, "start");
  drag({ sender: stranger }, "move");
  assert.equal(win.calls.filter((call) => call[0] === "setBounds").length, 1, "a stranger's drag is ignored");

  // Hover: the page reports her pixels under the cursor, the window takes clicks.
  moveCursor(win.bounds.x + 200, win.bounds.y + 200);
  pointer({ sender: page }, { hit: true, x: 200, y: 200, body: { x: 0, y: 0, width: size, height: size } });
  assert.deepEqual(win.calls.at(-1), ["setIgnoreMouseEvents", false]);
  pointer({ sender: page }, { hit: false, x: 200, y: 200, body: { x: 0, y: 0, width: size, height: size } });
  assert.deepEqual(win.calls.at(-1), ["setIgnoreMouseEvents", true, { forward: true }], "transparent spot nearby: forwarding only");

  drag({ sender: page }, "start");
  const grab = { x: win.bounds.x + 200, y: win.bounds.y + 200 };
  for (let i = 1; i <= 50; i++) {
    moveCursor(grab.x - i * 36, grab.y - i * 22);
    drag({ sender: page }, "move");
  }
  const moves = win.calls.filter((call) => call[0] === "setBounds").slice(1) as Array<[string, { width: number; height: number }]>;
  assert.equal(moves.length, 50);
  assert.ok(moves.every(([, bounds]) => bounds.width === size && bounds.height === size), "every move keeps the exact size");
  assert.equal(win.calls.some((call) => call[0] === "setPosition"), false, "setPosition grows the window at fractional scaling");
  moveCursor(5, 5);
  drag({ sender: page }, "end");
  assert.deepEqual(win.bounds, { x: 0, y: 0, width: size, height: size }, "dropped near the top-left: snapped into the corner");
  assert.deepEqual(JSON.parse(readFileSync(positionFile, "utf8")), { h: "left", dx: 0, v: "top", dy: 0, area: AREA });
  assert.deepEqual(page.sent.at(-1), [CHANNEL_PET_FACING, true], "against the left edge she turns around");

  desktop.sync(on, 0);
  desktop.sync(on, 1);
  assert.deepEqual(FakeWindow.all[1]!.bounds, { x: 0, y: 0, width: size, height: size }, "the next window opens where she was left");
  desktop.sync(on, 0);
});

test("an unreadable position file or a crashed page never stops ZCode", () => {
  const { desktop, positionFile, logged } = setup();
  writeFileSync(positionFile, "{ not json");
  desktop.sync(on, 1);
  const win = FakeWindow.all[0]!;
  assert.equal(win.bounds.x, AREA.width - win.bounds.width, "falls back to the default corner");
  FakeView.all[0]!.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(win.destroyed, true);
  assert.match(logged.join("\n"), /desktop pet page gone \(crashed\)/);
  assert.ok(existsSync(positionFile), "the saved position is left alone");
  desktop.sync(on, 0);
});

test("a page that fails to load or a close that throws never reaches ZCode", async () => {
  const { desktop, logged } = setup();
  FakeContents.failLoad = true;
  try {
    desktop.sync(on, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(FakeWindow.all[0]!.destroyed, true, "no empty window left on screen");
    assert.equal(desktop.contents(), null);
    assert.match(logged.join(" | "), /desktop pet page failed to load: Error: ERR_FILE_NOT_FOUND/);
  } finally {
    FakeContents.failLoad = false;
  }
  desktop.sync(on, 0);
  desktop.sync(on, 1);
  const win = FakeWindow.all[1]!;
  FakeContents.failClose = true;
  try {
    assert.doesNotThrow(() => win.destroy(), "ZCode quitting closes every window: a throwing close stays inside Canvas");
    assert.match(logged.join(" | "), /desktop pet closed: Error: Object has been destroyed/);
    assert.equal(desktop.contents(), null, "forgotten even when its page could not be closed");
  } finally {
    FakeContents.failClose = false;
  }
  FakeView.all[1]!.webContents.close();
});
