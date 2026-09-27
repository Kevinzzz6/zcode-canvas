// Runs inside ZCode's Electron main process, loaded by the bootstrap before ZCode's own entry.
// Anything thrown here must never reach ZCode: every entry point is guarded.
import { app, BrowserWindow, ipcMain, session, type WebContents } from "electron";
import { appendFileSync, renameSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { buildCss } from "../shared/css.ts";
import { canvasHome, loadLook, paths, type Material } from "../shared/look.ts";

const CHANNEL_GET = "zcode-canvas:get";
const CHANNEL_CSS = "zcode-canvas:css";
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

function applyMaterial(contents: WebContents) {
  if (process.platform !== "win32") return;
  const win = BrowserWindow.fromWebContents(contents);
  if (win && !win.isDestroyed()) win.setBackgroundMaterial(state.material);
}

function track(contents: WebContents) {
  if (renderers.has(contents)) return;
  renderers.add(contents);
  contents.once("destroyed", () => renderers.delete(contents));
}

function reload() {
  const next = compute(state);
  const cssChanged = next.css !== state.css;
  const materialChanged = next.material !== state.material;
  state = next;
  for (const contents of renderers) {
    if (contents.isDestroyed()) continue;
    try {
      if (cssChanged) contents.send(CHANNEL_CSS, state.css);
      if (materialChanged) applyMaterial(contents);
    } catch (error) {
      log(`update failed: ${String(error)}`);
    }
  }
  log(`reloaded (css ${state.css.length} bytes, material ${state.material})`);
}

try {
  // Only the preload of ZCode's main window asks, so this also identifies the windows to style.
  ipcMain.on(CHANNEL_GET, (event) => {
    try {
      track(event.sender);
      if (state.material !== OFFICIAL_MATERIAL) applyMaterial(event.sender);
      event.returnValue = state.css;
    } catch (error) {
      log(`get failed: ${String(error)}`);
      event.returnValue = "";
    }
  });

  // Registered before ZCode's entry is imported, so this runs before ZCode creates its window.
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
  });

  let timer: NodeJS.Timeout | undefined;
  watch(home, { recursive: true }, (_event, file) => {
    if (file && /runtime\.log/.test(String(file))) return;
    clearTimeout(timer);
    timer = setTimeout(reload, 150);
  });

  log(`runtime loaded in ZCode ${app.getVersion()} (css ${state.css.length} bytes, material ${state.material})`);
} catch (error) {
  log(`runtime init failed: ${String(error)}`);
}
