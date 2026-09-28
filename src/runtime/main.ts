// Runs inside ZCode's Electron main process, loaded by the bootstrap before ZCode's own entry.
// Anything thrown here must never reach ZCode: every entry point is guarded.
import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItem, session, Tray, type IpcMainEvent, type OpenDialogOptions, type WebContents } from "electron";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildCss } from "../shared/css.ts";
import { canvasHome, loadLook, paths, readConfig, type Material } from "../shared/look.ts";
import { CHANNEL_CSS, CHANNEL_GET, encodeState, ZCODE_SET_SHORTCUT_RECORDING } from "../shared/protocol.ts";
import { startDetachedPowerShell } from "../shared/windows.ts";
import { registerPanelHandlers } from "./panel.ts";
import { stagedUpdateCacheDir, stagedUpdateIsPresent, windowsRescueWaiterCommand } from "./rescue.ts";
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

/** Set while ZCode's shortcut recorder is armed; the panel shortcut stands down so the user can
 *  bind the combination to a ZCode command (and no panel pops up mid-recording). */
let shortcutRecordingActive = false;

/**
 * ZCode notifies the main process of the recorder state over ipcMain.on (desktopMainIpcPlatform).
 * The runtime loads before ZCode's entry, so wrapping the registration lets it observe that state
 * — and since toggling the recorder makes ZCode rebuild the application menu, the menu wrapper
 * below naturally re-adds the Canvas item with/without its accelerator at exactly that moment.
 */
function observeShortcutRecording() {
  type Listener = (event: IpcMainEvent, ...args: unknown[]) => void;
  const on = ipcMain.on.bind(ipcMain) as (channel: string, listener: Listener) => ReturnType<typeof ipcMain.on>;
  const wrapped: typeof ipcMain.on = (channel, listener) =>
    on(channel, (event, ...args) => {
      if (channel === ZCODE_SET_SHORTCUT_RECORDING && typeof args[0] === "boolean") shortcutRecordingActive = args[0];
      return listener(event, ...args);
    });
  ipcMain.on = wrapped;
}

function panelPath(file: string): string {
  return join(__dirname, "panel", file);
}

function panelPreloadPath(): string {
  return join(__dirname, "panel-preload.cjs");
}
function openPanel() {
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return; }
  panel = new BrowserWindow({ width: 640, height: 700, minWidth: 520, minHeight: 480, title: "ZCode Canvas 外观中心", webPreferences: { preload: panelPreloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  panel.loadFile(panelPath("panel.html"));
  panel.on("closed", () => { panel = null; });
}

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
        if (shortcutRecordingActive || !matchesPanelShortcut(input)) return;
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
 * Official updates replace app.asar wholesale, which removes the patch — and with it this runtime,
 * silently reverting the whole look. Nothing of Canvas may run from the install dir while the
 * installer works (electron-builder's NSIS running-app check kills every process whose path is
 * under the install dir), so on Windows the runtime only starts System32's powershell.exe: a
 * hidden waiter that confirms the update installer actually appears, waits for it to exit, and
 * only then runs the NEW ZCode.exe as plain Node to re-apply the patch. Because ZCode on Windows
 * installs only via an explicit "restart to update" (auto-install-on-quit is off there), an
 * ordinary quit with a merely downloaded update also starts that waiter — it sees no installer,
 * logs, and exits.
 * macOS/Linux hand over directly: no installer sweeps those platforms, and POSIX does not lock
 * replaced binaries. `zcode-canvas set updateRescue false` turns the whole mechanism off.
 */
function spawnUpdateRescue() {
  try {
    if (readConfig(home).updateRescue === false) return;
    const cliCopy = join(paths.runtime(home), "cli.mjs");
    const asar = join(process.resourcesPath, "app.asar");
    if (!existsSync(cliCopy) || !existsSync(asar)) return;
    const installDir =
      process.platform === "darwin" ? dirname(dirname(process.resourcesPath)) : dirname(process.resourcesPath);
    if (process.platform === "win32") {
      if (!stagedUpdateIsPresent(process.resourcesPath)) return;
      const updaterCacheDir = stagedUpdateCacheDir(process.resourcesPath);
      if (!updaterCacheDir) return;
      // The waiter script is staged in the canvas home and started via the safe launcher: a
      // detached powershell.exe of our own dies at spawn (console subsystem, no console).
      const scriptFile = join(paths.runtime(home), "rescue-waiter.ps1");
      writeFileSync(scriptFile, `${windowsRescueWaiterCommand({
        updaterCacheDir,
        rescueExe: process.execPath,
        cliCopy,
        installDir,
        canvasHome: home,
        logFile,
      })}\n`, "utf8");
      const { started, error } = startDetachedPowerShell(scriptFile);
      log(started ? "rescue waiter handed over" : `rescue waiter failed to start${error ? `: ${error}` : ""}`);
    } else {
      spawn(process.execPath, [cliCopy, "__rescue", installDir, home], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      }).unref();
      log("update rescue helper handed over");
    }
  } catch (error) {
    log(`update rescue unavailable: ${String(error)}`);
  }
}

/** The only way a wallpaper enters the config: a file chosen in the native dialog. */
async function pickWallpaperFile(): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: "选择壁纸图片",
    properties: ["openFile"],
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "avif", "svg", "gif"] }],
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
  observeShortcutRecording();
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
