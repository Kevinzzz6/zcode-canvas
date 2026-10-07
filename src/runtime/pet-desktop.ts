// Desktop mode, in ZCode's main process: one pet for all of ZCode, in Canvas's own small
// transparent window that stays on top of everything, so she is still there while ZCode is
// minimized, in the tray or covered. Electron is handed in rather than imported, so the window's
// lifecycle can be tested outside ZCode.
//
// Why it is built the way it is (docs/design.md, "桌宠的边界"):
// - BaseWindow, not BrowserWindow: ZCode picks windows from BrowserWindow.getAllWindows() (last
//   window, OAuth and update fallbacks) and listens to browser-window-created; a BaseWindow is
//   invisible to all of that.
// - A BaseWindow keeps window-all-closed from firing, so the pet goes the moment the last ZCode main
//   page does (sync with mainPages 0), and the close event is never prevented.
// - Its own non-persistent session partition: no Canvas or ZCode preload, and ZCode's telemetry
//   script, which is injected into every page, has no channel to report through.
// - A WebContentsView's webContents outlives its window; it is closed explicitly on "closed".
import type { BaseWindow, BaseWindowConstructorOptions, IpcMain, IpcMainEvent, PowerMonitor, Rectangle, Screen, WebContents, WebContentsView } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { petBase, type ResolvedPet } from "../shared/pet.ts";
import { CHANNEL_PET_DRAG, CHANNEL_PET_FACING, CHANNEL_PET_LOG, CHANNEL_PET_POINTER, CHANNEL_PET_PROBE } from "../shared/protocol.ts";
import { boundsFromPosition, chooseArea, facesLeft, parseDesktopPosition, positionFromBounds, snapToArea, type DesktopPetPosition } from "./pet-desktop-position.ts";
import { decidePointer, parsePointerReport, POINTER_TIMING, probePoint, type PointerMode, type PointerReport, type PointerState } from "./pet-pointer.ts";

export const DESKTOP_PET_PARTITION = "zcode-canvas-pet";

/** The parts of electron the desktop pet uses. */
export interface DesktopPetElectron {
  BaseWindow: new (options: BaseWindowConstructorOptions) => BaseWindow;
  WebContentsView: new (options: { webPreferences: Electron.WebPreferences }) => WebContentsView;
  screen: Pick<Screen, "getCursorScreenPoint" | "getPrimaryDisplay" | "getAllDisplays" | "getDisplayMatching" | "on">;
  ipcMain: Pick<IpcMain, "on">;
  powerMonitor: Pick<PowerMonitor, "on">;
}

export interface DesktopPetDeps {
  electron: DesktopPetElectron;
  /** The pet's own page and preload, deployed next to the runtime. */
  page: string;
  preload: string;
  /** Where the position is kept: Canvas's own directory, never localStorage. */
  positionFile: string;
  log(message: string): void;
}

export const DESKTOP_WINDOW_OPTIONS = {
  frame: false,
  transparent: true,
  // A click on her must never move the system focus to a window ZCode does not know about.
  focusable: false,
  skipTaskbar: true,
  resizable: false,
  maximizable: false,
  minimizable: false,
  fullscreenable: false,
  hasShadow: false,
  show: false,
} as const satisfies BaseWindowConstructorOptions;

interface Shown {
  win: BaseWindow;
  contents: WebContents;
  scale: number;
  size: number;
  report: PointerReport | null;
  pointer: PointerState;
  applied: PointerMode | null;
  drag: { cursor: Electron.Point; bounds: Rectangle; at: number } | null;
  timers: ReturnType<typeof setInterval>[];
}

export function createDesktopPet({ electron, page, preload, positionFile, log }: DesktopPetDeps) {
  const { BaseWindow: Window, WebContentsView: View, screen } = electron;
  let shown: Shown | null = null;
  let wanted: { scale: number } | null = null;

  const guard = <A extends unknown[]>(where: string, action: (...args: A) => void) => (...args: A) => {
    try { action(...args); } catch (error) { log(`desktop pet ${where}: ${String(error)}`); }
  };

  function readPosition(): DesktopPetPosition {
    try { return parseDesktopPosition(JSON.parse(readFileSync(positionFile, "utf8"))); } catch { return parseDesktopPosition(null); }
  }
  function savePosition(position: DesktopPetPosition) {
    try {
      mkdirSync(dirname(positionFile), { recursive: true });
      const tmp = `${positionFile}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(position)}\n`);
      renameSync(tmp, positionFile);
    } catch (error) { log(`desktop pet position not saved: ${String(error)}`); }
  }

  function apply(target: Shown, mode: PointerMode) {
    if (target.applied === mode || target.win.isDestroyed()) return;
    target.applied = mode;
    if (mode === "interactive") target.win.setIgnoreMouseEvents(false);
    else if (mode === "forward") target.win.setIgnoreMouseEvents(true, { forward: true });
    else target.win.setIgnoreMouseEvents(true);
  }

  /** `probe` only from the poll: a reply re-evaluates, and must not ask again at IPC speed. */
  function evaluate(target: Shown | null = shown, probe = false) {
    if (!target || target.win.isDestroyed()) return;
    if (target.drag && Date.now() - target.drag.at > POINTER_TIMING.dragHoldMs) target.drag = null;
    const inputs = { cursor: screen.getCursorScreenPoint(), window: target.win.getContentBounds(), report: target.report, dragging: !!target.drag };
    target.pointer = decidePointer(inputs, target.pointer);
    apply(target, target.pointer.mode);
    const point = probe ? probePoint(inputs, target.pointer) : null;
    if (point && !target.contents.isDestroyed()) target.contents.send(CHANNEL_PET_PROBE, point);
  }

  /** The native state can go stale silently; set it again from scratch. */
  function reissue(target: Shown | null = shown) {
    if (!target) return;
    target.applied = null;
    evaluate(target);
  }

  function sendFacing(target: Shown, position: DesktopPetPosition) {
    if (!target.contents.isDestroyed()) target.contents.send(CHANNEL_PET_FACING, facesLeft(position));
  }

  function create(scale: number) {
    const position = readPosition();
    const area = chooseArea(position, screen.getAllDisplays().map((display) => display.workArea), screen.getPrimaryDisplay().workArea);
    const size = Math.round(petBase(area.width, area.height, scale));
    const bounds = boundsFromPosition(position, area, size);
    const win = new Window({ ...DESKTOP_WINDOW_OPTIONS, ...bounds });
    let contents: WebContents | null = null;
    try {
      // Windows rounds a fresh frameless window up by a few px at fractional scaling; set it exactly.
      win.setBounds(bounds);
      // ZCode's computer use takes screenshots and clicks by coordinates: she must not be in them.
      win.setContentProtection(true);
      win.setIgnoreMouseEvents(true);
      const view = new View({
        webPreferences: { partition: DESKTOP_PET_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, preload },
      });
      contents = view.webContents;
      view.setBackgroundColor("#00000000");
      win.contentView.addChildView(view);
      const content = win.getContentBounds();
      view.setBounds({ x: 0, y: 0, width: content.width, height: content.height });
      const target: Shown = { win, contents, scale, size, report: null, pointer: { mode: "through", near: false }, applied: "through", drag: null, timers: [] };
      const owned = contents;
      win.on("closed", guard("closed", () => {
        for (const timer of target.timers) clearInterval(timer);
        if (shown === target) shown = null;
        if (!owned.isDestroyed()) owned.close();
      }));
      owned.setWindowOpenHandler(() => ({ action: "deny" }));
      owned.on("will-navigate", (event) => event.preventDefault());
      owned.on("render-process-gone", guard("crash", (_event: unknown, details: { reason?: string }) => {
        log(`desktop pet page gone (${details?.reason ?? "unknown"}); hidden until the next change`);
        if (!win.isDestroyed()) win.destroy();
      }));
      owned.once("did-finish-load", guard("loaded", () => {
        if (win.isDestroyed()) return;
        win.setAlwaysOnTop(true, "screen-saver");
        sendFacing(target, position);
        reissue(target);
      }));
      const poll = setInterval(guard("poll", () => evaluate(target, true)), POINTER_TIMING.pollMs);
      const heal = setInterval(guard("reissue", () => reissue(target)), POINTER_TIMING.reissueMs);
      poll.unref?.();
      heal.unref?.();
      target.timers.push(poll, heal);
      shown = target;
      // Shown before the page loads: a WebContentsView that starts painting inside a hidden
      // BaseWindow never reaches the screen (measured on Windows, Electron 41). Until the page
      // paints, the window is empty, transparent and click-through. Only the "screen-saver" level
      // really keeps it on top; it is set again once the page is there.
      win.showInactive();
      win.setAlwaysOnTop(true, "screen-saver");
      void owned.loadFile(page).catch(guard("load", (error: unknown) => {
        log(`desktop pet page failed to load: ${String(error)}; hidden until the next change`);
        if (!win.isDestroyed()) win.destroy();
      }));
    } catch (error) {
      if (contents && !contents.isDestroyed()) contents.close();
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
  }

  function destroy() {
    const target = shown;
    shown = null;
    if (!target) return;
    for (const timer of target.timers) clearInterval(timer);
    if (!target.win.isDestroyed()) target.win.destroy();
    if (!target.contents.isDestroyed()) target.contents.close();
  }

  function recreate() {
    if (!shown || !wanted) return;
    destroy();
    create(wanted.scale);
  }

  const fromPage = (event: IpcMainEvent) => !!shown && !shown.contents.isDestroyed() && event.sender === shown.contents;

  function drag(kind: unknown) {
    const target = shown;
    if (!target || target.win.isDestroyed()) return;
    if (kind === "start") {
      target.drag = { cursor: screen.getCursorScreenPoint(), bounds: target.win.getBounds(), at: Date.now() };
      evaluate(target);
    } else if (kind === "move" && target.drag) {
      const cursor = screen.getCursorScreenPoint();
      const { bounds } = target.drag;
      target.drag.at = Date.now();
      // setBounds with the size every time: setPosition grows a frameless window by a pixel per
      // call at fractional scaling, which a drag repeats hundreds of times.
      target.win.setBounds({ x: bounds.x + cursor.x - target.drag.cursor.x, y: bounds.y + cursor.y - target.drag.cursor.y, width: target.size, height: target.size });
    } else if (kind === "end" && target.drag) {
      target.drag = null;
      const current = { ...target.win.getBounds(), width: target.size, height: target.size };
      const area = screen.getDisplayMatching(current).workArea;
      const snapped = snapToArea(current, area);
      target.win.setBounds(snapped);
      const position = positionFromBounds(snapped, area);
      savePosition(position);
      sendFacing(target, position);
      reissue(target);
    }
  }

  // Registered once; each only answers the current pet page.
  electron.ipcMain.on(CHANNEL_PET_POINTER, guard("pointer", (event: IpcMainEvent, raw: unknown) => {
    if (!fromPage(event) || !shown) return;
    shown.report = parsePointerReport(raw);
    evaluate();
  }));
  electron.ipcMain.on(CHANNEL_PET_DRAG, guard("drag", (event: IpcMainEvent, kind: unknown) => {
    if (fromPage(event)) drag(kind);
  }));
  electron.ipcMain.on(CHANNEL_PET_LOG, guard("log", (event: IpcMainEvent, message: unknown) => {
    if (fromPage(event) && typeof message === "string") log(`desktop pet page: ${message.slice(0, 1000)}`);
  }));
  // New sizes and scaling: rebuild in the new geometry rather than patch the old window.
  screen.on("display-metrics-changed", guard("display", recreate));
  screen.on("display-added", guard("display", recreate));
  screen.on("display-removed", guard("display", recreate));
  electron.powerMonitor.on("resume", guard("resume", () => reissue()));

  return {
    /**
     * Shows the pet while it is on, in desktop mode, and at least one ZCode main page exists;
     * otherwise destroys it at once. With no main page left the pet must already be gone when
     * ZCode checks whether its last window closed.
     */
    sync: guard("sync", (pet: ResolvedPet, mainPages: number) => {
      wanted = pet.enabled && pet.desktop && mainPages > 0 ? { scale: pet.scale } : null;
      if (!wanted) return destroy();
      if (shown && shown.scale !== wanted.scale) destroy();
      if (!shown) create(wanted.scale);
    }),
    /** The pet page, for pushing payloads; null while there is none. */
    contents: (): WebContents | null => (shown && !shown.contents.isDestroyed() ? shown.contents : null),
    /** Identity, not URL: only this exact webContents counts as the pet page. */
    isPage: (sender: unknown): boolean => !!shown && !shown.contents.isDestroyed() && sender === shown.contents,
  };
}
