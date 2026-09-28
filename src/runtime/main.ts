// Runs inside ZCode's Electron main process, loaded by the bootstrap before ZCode's own entry.
// Anything thrown here must never reach ZCode: every entry point is guarded.
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, MenuItem, session, type WebContents } from "electron";
import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCss } from "../shared/css.ts";
import { canvasHome, listThemes, loadLook, paths, readConfig, type Material } from "../shared/look.ts";
import { CHANNEL_CSS, CHANNEL_GET, CHANNEL_PANEL_APPLY, CHANNEL_PANEL_GET, encodeState } from "../shared/protocol.ts";
import { watchHome } from "./watch.ts";

const PANEL_ACCELERATOR = "CommandOrControl+Alt+Shift+O";
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
  panel = new BrowserWindow({ width: 780, height: 620, minWidth: 560, minHeight: 480, title: "ZCode Canvas 外观中心", webPreferences: { preload: panelPreloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  panel.loadFile(panelPath("panel.html"));
  panel.on("closed", () => { panel = null; });
}

function injectMenu() {
  const menu = Menu.getApplicationMenu();
  if (!menu || menu.items.some((item) => item.label === "ZCode Canvas")) return;
  const canvas = new MenuItem({
    label: "ZCode Canvas",
    submenu: [{ label: "打开外观中心", accelerator: PANEL_ACCELERATOR, click: openPanel }],
  });
  menu.append(canvas);
  Menu.setApplicationMenu(menu);
}

function scheduleMenuInjection() {
  injectMenu();
  for (const delay of [250, 1000, 2500]) setTimeout(injectMenu, delay);
}

function readPanelData() {
  const config = readConfig(home);
  const imported = join(home, "imports", "wallpaper");
  const wallpapers = existsSync(imported)
    ? readdirSync(imported)
        .filter((f) => /\.(png|jpe?g|webp|avif|svg)$/i.test(f))
        .filter((f) => statSync(join(imported, f), { throwIfNoEntry: false })?.isFile())
    : [];
  const themes = listThemes(home).map((entry) => ({ id: entry.id, name: entry.manifest.name, builtin: entry.builtin }));
  return { config, wallpapers, themes };
}

function isImportedWallpaper(name: string): boolean {
  return name.length > 0 && name === name.split(/[\\/]/).pop() && /^[^<>:"/\\|?*]+$/.test(name);
}

function importedWallpaperPath(name: string): string | null {
  if (!isImportedWallpaper(name)) return null;
  const root = resolve(home, "imports", "wallpaper");
  const candidate = resolve(root, name);
  if (!candidate.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)) return null;
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    if (!realCandidate.startsWith(`${realRoot}${process.platform === "win32" ? "\\" : "/"}`)) return null;
  } catch {
    return null;
  }
  return candidate;
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

function writeConfigAtomic(config: ReturnType<typeof readConfig>) {
  mkdirSync(home, { recursive: true });
  const target = paths.config(home);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
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

function registerPanelHandlers() {
  try {
    ipcMain.handle(CHANNEL_PANEL_GET, () => readPanelData());
  } catch (error) {
    log(`panel get handler unavailable: ${String(error)}`);
  }
  try {
    ipcMain.handle(CHANNEL_PANEL_APPLY, (_event, value: unknown) => {
      if (!value || typeof value !== "object") throw new Error("invalid panel request");
      const input = value as { theme?: unknown; wallpaper?: unknown; fit?: unknown; blur?: unknown; dim?: unknown };
      const config = readConfig(home);
      if (input.theme === null || typeof input.theme === "string") {
        if (input.theme === null || input.theme === "") config.theme = null;
        else if (listThemes(home).some((entry) => entry.id === input.theme)) config.theme = input.theme;
        else throw new Error("unknown theme");
      }
      if (input.wallpaper === null) {
        config.wallpaper = null;
      } else if (typeof input.wallpaper === "string" && input.wallpaper) {
        const candidate = importedWallpaperPath(input.wallpaper);
        if (!candidate || !existsSync(candidate) || !statSync(candidate).isFile()) throw new Error("wallpaper is not imported");
        config.wallpaper = { ...(config.wallpaper ?? {}), image: candidate };
      }
      if (input.fit !== undefined || input.blur !== undefined || input.dim !== undefined) {
        const wallpaper = { ...(config.wallpaper ?? {}) };
        if (input.fit !== undefined) {
          if (!["cover", "contain", "fill", "tile", "center"].includes(String(input.fit))) throw new Error("invalid wallpaper fit");
          wallpaper.fit = input.fit as typeof wallpaper.fit;
        }
        if (input.blur !== undefined) {
          const n = Number(input.blur);
          if (!Number.isFinite(n) || n < 0 || n > 200) throw new Error("invalid wallpaper blur");
          wallpaper.blur = n;
        }
        if (input.dim !== undefined) {
          const n = Number(input.dim);
          if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error("invalid wallpaper dim");
          wallpaper.dim = n;
        }
        config.wallpaper = wallpaper;
      }
      writeConfigAtomic(config);
      reload();
      return { ok: true };
    });
  } catch (error) {
    log(`panel apply handler unavailable: ${String(error)}`);
  }
}

try {
  // Only the preload of ZCode's main window asks, so this also identifies the windows to style.
  ipcMain.on(CHANNEL_GET, (event) => {
    try {
      track(event.sender);
      if (state.material !== OFFICIAL_MATERIAL) applyMaterial(event.sender);
      event.returnValue = encodeState(state.css);
    } catch (error) {
      log(`get failed: ${String(error)}`);
      event.returnValue = encodeState("");
    }
  });

  registerPanelHandlers();

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
      scheduleMenuInjection();
      globalShortcut.register(PANEL_ACCELERATOR, openPanel);
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
