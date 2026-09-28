// Runs inside ZCode's Electron main process, loaded by the bootstrap before ZCode's own entry.
// Anything thrown here must never reach ZCode: every entry point is guarded.
import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItem, session, Tray, type IpcMainEvent, type OpenDialogOptions, type WebContents } from "electron";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildCss } from "../shared/css.ts";
import { canvasHome, loadLook, paths, readConfig, type Material } from "../shared/look.ts";
import { CHANNEL_CSS, CHANNEL_GET, encodeState } from "../shared/protocol.ts";
import { registerPanelHandlers } from "./panel.ts";
import { matchesPanelShortcut } from "./shortcut.ts";
import { watchHome } from "./watch.ts";

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
}

function compute(previous: State): State {
  try {
    const { look, warnings } = loadLook(home);
    if (!look) return { css: "", material: OFFICIAL_MATERIAL };
    const result = buildCss(look);
    for (const warning of [...warnings, ...result.warnings]) log(`warn: ${warning}`);
    return { css: result.css, material: look.glass.material };
  } catch (error) {
    // A half-written config.json during editing is normal; keep showing the last good look.
    log(`config error, keeping previous look: ${String(error)}`);
    return previous;
  }
}

let state = compute({ css: "", material: OFFICIAL_MATERIAL });
const renderers = new Set<WebContents>();

let panel: BrowserWindow | null = null;

function panelPath(file: string): string {
  return join(__dirname, "panel", file);
}

function panelPreloadPath(): string {
  return join(__dirname, "panel-preload.cjs");
}
function openPanel() {
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return; }
  panel = new BrowserWindow({ width: 640, height: 620, minWidth: 520, minHeight: 480, title: "ZCode Canvas 外观中心", webPreferences: { preload: panelPreloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  panel.loadFile(panelPath("panel.html"));
  panel.on("closed", () => { panel = null; });
}

function canvasMenuItem(): MenuItem {
  return new MenuItem({
    label: MENU_LABEL,
    submenu: [{ label: "打开外观中心", accelerator: PANEL_ACCELERATOR, click: openPanel }],
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
 * globalShortcut would steal the combination from every other app and trigger while ZCode itself
 * records user shortcuts. App-menu accelerators (see canvasMenuItem) already cover the focused
 * window on their own; before-input-event is the backstop that does not depend on menu visibility.
 */
function installInWindowShortcut() {
  app.on("browser-window-created", (_event, window) => {
    try {
      window.webContents.on("before-input-event", (event, input) => {
        if (!matchesPanelShortcut(input)) return;
        event.preventDefault();
        openPanel();
      });
    } catch (error) {
      log(`shortcut wiring failed: ${String(error)}`);
    }
  });
}

/** True when a panel-channel request comes from the panel window's own webContents. */
const isPanelSender = (event: unknown): boolean => {
  const sender = (event as { sender?: unknown } | null | undefined)?.sender;
  return !!panel && !panel.isDestroyed() && sender === panel.webContents;
};

/** The main window's page is the only legitimate source of a GET — its session preload sends one at
 *  document start. The same conditions the preload checks on itself, enforced on the main side. */
function senderIsMainWindow(event: IpcMainEvent): boolean {
  try {
    const url = event.senderFrame?.url ?? "";
    if (!url.startsWith("file:")) return false;
    const parsed = new URL(url);
    return /\/out\/renderer\/index\.html$/.test(parsed.pathname) && !parsed.searchParams.has("windowKind");
  } catch {
    return false;
  }
}

/**
 * electron-updater stages a downloaded update under <cache root>/<updaterCacheDirName>/pending —
 * the name comes from resources/app-update.yml — and installs it as the app quits (auto-install on
 * quit, or the explicit "restart to update" flow). A non-empty staging dir is the signal that this
 * quit is an updating one, so ordinary quits spawn nothing at all.
 */
function stagedUpdateIsPresent(): boolean {
  try {
    const yml = readFileSync(join(process.resourcesPath, "app-update.yml"), "utf8");
    const name = /^updaterCacheDirName:\s*(\S+)/m.exec(yml)?.[1];
    if (!name) return false;
    const cacheRoot =
      process.platform === "win32"
        ? process.env.LOCALAPPDATA
        : process.platform === "darwin"
          ? join(homedir(), "Library", "Caches")
          : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    if (!cacheRoot) return false;
    const pending = join(cacheRoot, name, "pending");
    return existsSync(pending) && readdirSync(pending).length > 0;
  } catch {
    return false;
  }
}

/**
 * Official updates replace app.asar wholesale, which removes the patch — and with it this runtime,
 * silently reverting the whole look. When ZCode quits over a staged update, hand over to a detached
 * helper (ZCode.exe running as plain Node through the default-enabled RunAsNode fuse) that waits
 * for the updater to finish writing the new archive and re-applies the patch.
 * `zcode-canvas set updateRescue false` turns this off.
 */
function spawnUpdateRescue() {
  try {
    if (readConfig(home).updateRescue === false) return;
    if (!stagedUpdateIsPresent()) return;
    const cliCopy = join(paths.runtime(home), "cli.mjs");
    const asar = join(process.resourcesPath, "app.asar");
    if (!existsSync(cliCopy) || !existsSync(asar)) return;
    const installDir =
      process.platform === "darwin" ? dirname(dirname(process.resourcesPath)) : dirname(process.resourcesPath);
    spawn(process.execPath, [cliCopy, "__rescue", installDir, home], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    }).unref();
    log("update rescue helper handed over");
  } catch (error) {
    log(`update rescue unavailable: ${String(error)}`);
  }
}

/** The only way a wallpaper enters the config: a file chosen in the native dialog. */
async function pickWallpaperFile(): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: "选择壁纸图片",
    properties: ["openFile"],
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "avif", "svg"] }],
  };
  const owner = panel && !panel.isDestroyed() ? panel : undefined;
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
  contents.once("destroyed", () => renderers.delete(contents));
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
      if (materialChanged) applyMaterial(contents);
    } catch (error) {
      log(`update failed: ${String(error)}`);
    }
  }
  log(`reloaded (css ${state.css.length} bytes, material ${state.material})`);
}

try {
  wrapApplicationMenu();
  wrapTrayMenu();
  installInWindowShortcut();
  app.once("will-quit", spawnUpdateRescue);

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

  registerPanelHandlers({ home, ipc: ipcMain, log, pickWallpaperFile, reload, isPanelSender });

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
  // afterwards run the new preload against this still-running old main.
  watchHome(home, reload, log);
  log(`runtime loaded in ZCode ${app.getVersion()} (css ${state.css.length} bytes, material ${state.material})`);
} catch (error) {
  log(`runtime init failed: ${String(error)}`);
}
