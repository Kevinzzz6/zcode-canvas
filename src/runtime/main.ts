// Runs inside ZCode's Electron main process, loaded by the bootstrap before ZCode's own entry.
// Anything thrown here must never reach ZCode: every entry point is guarded.
import { app, BaseWindow, BrowserWindow, dialog, ipcMain, Menu, MenuItem, powerMonitor, screen, session, shell, Tray, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent, type OpenDialogOptions, type WebContents } from "electron";
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCss } from "../shared/css.ts";
import { canvasHome, loadLook, paths, readConfig, type Material } from "../shared/look.ts";
import { desktopPetAvailability, resolvePet, type PetAssets, type ResolvedPet } from "../shared/pet.ts";
import { CHANNEL_CSS, CHANNEL_GET, CHANNEL_PANEL_OPEN, CHANNEL_PANEL_CHANGED, CHANNEL_PANEL_LOG, CHANNEL_PET, CHANNEL_PET_GET, encodeState, ZCODE_SET_SHORTCUT_RECORDING, ZCODE_SHOW_TASK_NOTIFICATION } from "../shared/protocol.ts";
import { isMainWindowUrl } from "../shared/window.ts";
import { registerPanelHandlers } from "./panel.ts";
import { zcodeLogDir } from "./pet-log.ts";
import { createDesktopPet } from "./pet-desktop.ts";
import { createPetService } from "./pet-service.ts";
import { matchesPanelShortcut } from "./shortcut.ts";
import { watchHome, debounced } from "./watch.ts";

const PANEL_ACCELERATOR = "CommandOrControl+Alt+Shift+O";
const MENU_LABEL = "ZCode Canvas";
const TRAY_ITEM_LABEL = "ZCode Canvas 外观中心";
const OFFICIAL_MATERIAL: Material = "acrylic";

const home = canvasHome();
const logFile = paths.log(home);

function log(message: string) {
  try {
    if ((statSync(logFile, { throwIfNoEntry: false })?.size ?? 0) > 256 * 1024) renameSync(logFile, `${logFile}.old`);
    appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging is best effort.
  }
}

interface State {
  css: string;
  material: Material;
  pet: ResolvedPet;
}

const desktopAvailability = desktopPetAvailability(process.platform, process.env);

function compute(previous: State): State {
  try {
    const config = readConfig(home);
    const pet = resolvePet(config.pet, config.enabled !== false, desktopAvailability !== "unavailable");
    const { look, warnings } = loadLook(home);
    if (!look) return { css: "", material: OFFICIAL_MATERIAL, pet };
    const result = buildCss(look);
    for (const warning of [...warnings, ...result.warnings]) log(`warn: ${warning}`);
    return { css: result.css, material: look.glass.material, pet };
  } catch (error) {
    // A half-written config.json during editing is normal; keep showing the last good look.
    log(`config error, keeping previous look: ${String(error)}`);
    return previous;
  }
}

let state = compute({ css: "", material: OFFICIAL_MATERIAL, pet: resolvePet(undefined) });
const renderers = new Set<WebContents>();

/** The pet's bundled assets, deployed next to this file by `zcode-canvas apply`. */
const petAssets: PetAssets = (() => {
  const url = (name: string) => pathToFileURL(join(__dirname, "pets", "fox", name)).href;
  return { image: url("fox.png"), sounds: { duck: { press: url("Ya1.mp3"), release: url("Ya2.mp3") }, fx1: { press: url("D1.mp3"), release: url("D2.mp3") } } };
})();

const pet = createPetService({
  assets: petAssets,
  logDir: zcodeLogDir(),
  log,
  send(payload) {
    // The desktop pet page gets the same pushes, but is not one of the renderers: those are ZCode's
    // main pages, which also receive CSS and decide when the desktop pet must go.
    const desktopPage = desktop?.contents();
    for (const contents of desktopPage ? [...renderers, desktopPage] : renderers) {
      if (contents.isDestroyed()) continue;
      try {
        contents.send(CHANNEL_PET, payload);
      } catch (error) {
        log(`pet update failed: ${String(error)}`);
      }
    }
  },
});

/** Desktop mode (pet-desktop.ts): created the first time it is needed, so off it costs nothing. */
let desktop: ReturnType<typeof createDesktopPet> | null = null;

/** Called whenever the settings or the set of main pages change; see pet-desktop.ts sync. */
function syncDesktopPet() {
  try {
    if (!desktop) {
      if (!state.pet.enabled || !state.pet.desktop || renderers.size === 0) return;
      desktop = createDesktopPet({
        electron: { BaseWindow, WebContentsView, screen, ipcMain, powerMonitor },
        page: join(__dirname, "pet-desktop.html"),
        preload: join(__dirname, "pet-desktop-preload.cjs"),
        positionFile: paths.petPosition(home),
        log,
      });
    }
    desktop.sync(state.pet, renderers.size);
  } catch (error) {
    log(`desktop pet unavailable: ${String(error)}`);
  }
}

/** Set while ZCode's shortcut recorder is armed; the panel shortcut stands down so the user can
 *  bind the combination to a ZCode command (and no panel pops up mid-recording). */
let shortcutRecordingActive = false;

/** What Canvas reads from ZCode's own IPC on its way to ZCode's listeners, which see it unchanged. */
function observe(channel: string, args: unknown[]) {
  try {
    if (channel === ZCODE_SET_SHORTCUT_RECORDING && typeof args[0] === "boolean") shortcutRecordingActive = args[0];
    else if (channel === ZCODE_SHOW_TASK_NOTIFICATION) pet.prompt(args[0]);
  } catch (error) {
    log(`observing ${channel} failed: ${String(error)}`);
  }
}

/**
 * The runtime loads before ZCode's entry, so wrapping the registrations lets it see ZCode's own
 * messages. Only the observed channels get a wrapped listener: everywhere else ZCode keeps its own
 * function, so removeListener keeps working. Toggling the shortcut recorder also makes ZCode
 * rebuild the application menu, where wrapApplicationMenu re-adds the Canvas item with or without
 * its accelerator at exactly that moment.
 */
function observeZCodeIpc() {
  const observed = new Set([ZCODE_SET_SHORTCUT_RECORDING, ZCODE_SHOW_TASK_NOTIFICATION]);
  type Listener = (event: IpcMainEvent, ...args: unknown[]) => void;
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const on = ipcMain.on.bind(ipcMain) as (channel: string, listener: Listener) => typeof ipcMain;
  const handle = ipcMain.handle.bind(ipcMain) as (channel: string, handler: Handler) => void;
  ipcMain.on = ((channel: string, listener: Listener) =>
    on(channel, observed.has(channel) ? (event, ...args) => { observe(channel, args); return listener(event, ...args); } : listener)) as typeof ipcMain.on;
  ipcMain.handle = ((channel: string, handler: Handler) =>
    handle(channel, observed.has(channel) ? (event, ...args) => { observe(channel, args); return handler(event, ...args); } : handler)) as typeof ipcMain.handle;
}

/** Prefer the focused main window; the tray reopens the last active one even with its tab hidden. */
function openPanel() {
  try {
    const focused = BrowserWindow.getFocusedWindow();
    const target = focused && isMainWindowUrl(focused.webContents.getURL()) ? focused :
      BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && isMainWindowUrl(win.webContents.getURL()))
        .sort((a, b) => (lastFocused.get(b.webContents.id) ?? 0) - (lastFocused.get(a.webContents.id) ?? 0))[0];
    if (target) {
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
      target.webContents.send(CHANNEL_PANEL_OPEN);
    } else void shell.openPath(home).then((error) => { if (error) log(`configuration folder open failed: ${error}`); }).catch((error) => log(`configuration folder open failed: ${String(error)}`));
  } catch (error) { log(`panel open failed: ${String(error)}`); }
}

const lastFocused = new Map<number, number>();

function canvasMenuItem(): MenuItem {
  return new MenuItem({
    label: MENU_LABEL,
    // Off while ZCode records shortcuts: the recorder must see the combination, not the menu.
    submenu: [{ label: "打开外观中心", accelerator: shortcutRecordingActive ? undefined : PANEL_ACCELERATOR, click: openPanel }],
  });
}

function injectMenu() {
  const menu = Menu.getApplicationMenu();
  if (!menu || menu.items.some((item) => item.label === MENU_LABEL)) return;
  menu.append(canvasMenuItem());
  Menu.setApplicationMenu(menu);
}

/**
 * ZCode rebuilds its whole application menu — on language switch, zoom change, shortcut recording,
 * settings sync — by passing a fresh Menu to Menu.setApplicationMenu, which drops anything that was
 * appended to the previous one. The runtime loads before ZCode's own entry, so wrapping the setter
 * re-adds the Canvas item every time the menu is replaced; injectMenu above only covers a menu set
 * through a path that bypasses the wrapper.
 */
function wrapApplicationMenu() {
  const setApplicationMenu = Menu.setApplicationMenu.bind(Menu);
  Menu.setApplicationMenu = (menu: Menu | null) => {
    try {
      if (menu && !menu.items.some((item) => item.label === MENU_LABEL)) menu.append(canvasMenuItem());
    } catch (error) {
      log(`menu injection failed: ${String(error)}`);
    }
    return setApplicationMenu(menu);
  };
}

/**
 * On Windows ZCode's windows are frameless: the application menu is never visible there, so the
 * tray is the entry point. Its context menu is also rebuilt wholesale (desktopTray.setContextMenu),
 * so it gets the same wrapper treatment.
 */
function wrapTrayMenu() {
  if (process.platform !== "win32") return;
  const trayPrototype = Tray.prototype as { setContextMenu: (this: Tray, menu: Menu | null) => void };
  const setContextMenu = trayPrototype.setContextMenu;
  trayPrototype.setContextMenu = function (this: Tray, menu: Menu | null) {
    try {
      if (menu && !menu.items.some((item) => item.label === TRAY_ITEM_LABEL)) {
        menu.append(new MenuItem({ type: "separator" }));
        menu.append(new MenuItem({ label: TRAY_ITEM_LABEL, click: () => openPanel() }));
      }
    } catch (error) {
      log(`tray menu injection failed: ${String(error)}`);
    }
    return setContextMenu.call(this, menu);
  };
}

/**
 * The panel shortcut fires only while a ZCode window has focus, never as a system-wide hotkey: a
 * globalShortcut would steal the combination from every other app. It also stands down while
 * ZCode's shortcut recorder is armed, so the combination can be recorded for a ZCode command.
 * App-menu accelerators (see canvasMenuItem) already cover the focused window on their own;
 * before-input-event is the backstop that does not depend on menu visibility.
 */
function installInWindowShortcut() {
  app.on("browser-window-created", (_event, window) => {
    try {
      window.webContents.on("before-input-event", (event, input) => {
        try {
          if (shortcutRecordingActive || !matchesPanelShortcut(input) || !isMainWindowUrl(window.webContents.getURL())) return;
          event.preventDefault();
          openPanel();
        } catch (error) { log(`shortcut failed: ${String(error)}`); }
      });
      const id = window.webContents.id;
      window.on("focus", () => { lastFocused.set(id, Date.now()); });
      window.on("closed", () => { lastFocused.delete(id); });
    } catch (error) {
      log(`shortcut wiring failed: ${String(error)}`);
    }
  });
}

/** Only a verified top-level main page can use appearance IPC. */
const isPanelSender = (event: unknown): boolean => senderIsMainWindow(event as IpcMainEvent);

/** The main window's page is the only legitimate source of a GET — its session preload sends one at
 *  document start. The same conditions the preload checks on itself, enforced on the main side. */
function senderIsMainWindow(event: IpcMainEvent): boolean {
  try {
    return event.senderFrame === event.sender.mainFrame && isMainWindowUrl(event.senderFrame?.url ?? "");
  } catch {
    return false;
  }
}

/** The only way a wallpaper enters the config: a file chosen in the native dialog. */
async function pickWallpaperFile(): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: "选择壁纸图片",
    properties: ["openFile"],
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "avif", "svg", "gif"] }],
  };
  const owner = BrowserWindow.getFocusedWindow() ?? undefined;
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!;
}

function consumeOpenRequest() {
  const request = paths.openRequest(home);
  if (!existsSync(request)) return;
  try {
    unlinkSync(request);
  } catch {
    return;
  }
  openPanel();
}

/**
 * Windows switches between acrylic/mica/tabbed via setBackgroundMaterial. macOS already ships with
 * "under-window" vibrancy, so only "none" (turning it off) differs from the official look. Linux
 * windows are plain transparent surfaces; there is nothing to switch.
 */
function applyMaterial(contents: WebContents) {
  const win = BrowserWindow.fromWebContents(contents);
  if (!win || win.isDestroyed()) return;
  if (process.platform === "win32") win.setBackgroundMaterial(state.material);
  else if (process.platform === "darwin") win.setVibrancy(state.material === "none" ? null : "under-window");
}

function track(contents: WebContents) {
  if (renderers.has(contents)) return;
  renderers.add(contents);
  // Synchronously: the desktop pet must be gone before ZCode checks whether its last window closed.
  contents.once("destroyed", () => { renderers.delete(contents); syncDesktopPet(); });
  // Not inside the page's synchronous GET.
  setImmediate(syncDesktopPet);
}

function reload() {
  consumeOpenRequest();
  const next = compute(state);
  const cssChanged = next.css !== state.css;
  const materialChanged = next.material !== state.material;
  state = next;
  for (const contents of renderers) {
    if (contents.isDestroyed()) continue;
    try {
      if (cssChanged) contents.send(CHANNEL_CSS, encodeState(state.css));
      contents.send(CHANNEL_PANEL_CHANGED);
      if (materialChanged) applyMaterial(contents);
    } catch (error) {
      log(`update failed: ${String(error)}`);
    }
  }
  pet.configure(state.pet);
  syncDesktopPet();
  log(`reloaded (css ${state.css.length} bytes, material ${state.material}, pet ${state.pet.enabled ? "on" : "off"})`);
}

try {
  wrapApplicationMenu();
  wrapTrayMenu();
  observeZCodeIpc();
  installInWindowShortcut();

  // Only the preload of ZCode's main window asks, so this also identifies the windows to style —
  // verified on the main side, not just by the preload itself.
  ipcMain.on(CHANNEL_GET, (event) => {
    try {
      if (!senderIsMainWindow(event)) {
        log("get refused: sender is not ZCode's main window");
        event.returnValue = encodeState("");
        return;
      }
      track(event.sender);
      if (state.material !== OFFICIAL_MATERIAL) applyMaterial(event.sender);
      event.returnValue = encodeState(state.css);
    } catch (error) {
      log(`get failed: ${String(error)}`);
      event.returnValue = encodeState("");
    }
  });

  // One coalescing point for every reload trigger. Panel handlers call this directly after writing
  // config, and the watcher feeds filesystem events into it; sharing the timer means a single
  // logical change reloads once instead of once per source that noticed it.
  const scheduleReload = debounced(reload, 150);

  registerPanelHandlers({ home, ipc: ipcMain, log, pickWallpaperFile, reload: scheduleReload, isPanelSender });
  try {
    ipcMain.on(CHANNEL_PANEL_LOG, (event, message: unknown) => {
      try {
        if (senderIsMainWindow(event) && typeof message === "string") log(`overlay: ${message.slice(0, 1000)}`);
      } catch { /* Logging never affects the host. */ }
    });
  } catch (error) { log(`overlay logging unavailable: ${String(error)}`); }
  try {
    ipcMain.handle(CHANNEL_PET_GET, (event) => {
      if (!senderIsMainWindow(event as unknown as IpcMainEvent) && !desktop?.isPage(event.sender)) throw new Error("refused: sender is neither ZCode's main window nor the desktop pet");
      return pet.payload();
    });
    pet.configure(state.pet);
  } catch (error) { log(`pet unavailable: ${String(error)}`); }

  app.once("ready", () => {
    try {
      session.defaultSession.registerPreloadScript({
        id: "zcode-canvas",
        type: "frame",
        filePath: join(__dirname, "preload.cjs"),
      });
    } catch (error) {
      log(`preload registration failed: ${String(error)}`);
    }
    try {
      injectMenu();
      consumeOpenRequest();
    } catch (error) {
      log(`panel entry unavailable: ${String(error)}`);
    }
  });

  // The payload is versioned (shared/protocol.ts): after a runtime upgrade on disk, pages loaded
  // afterwards run the new preload against this still-running old main. Debounce lives in
  // scheduleReload (see above), so the watcher itself passes events through undelayed.
  watchHome(home, scheduleReload, log, 0);
  log(`runtime loaded in ZCode ${app.getVersion()} (css ${state.css.length} bytes, material ${state.material})`);
  if (desktopAvailability === "forced") log(`desktop pet forced on by ZCODE_CANVAS_PET_DESKTOP=force; untested on ${process.platform}`);
} catch (error) {
  log(`runtime init failed: ${String(error)}`);
}
