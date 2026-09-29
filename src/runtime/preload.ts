// Session preload: runs in every page of ZCode's default session before any page script, so the
// CSS is in place for the very first paint (including the startup screen).
import { ipcRenderer, webFrame } from "electron";
import { CHANNEL_CSS, CHANNEL_GET, CHANNEL_PANEL_GET, CHANNEL_PANEL_APPLY, CHANNEL_PANEL_PICK_WALLPAPER, CHANNEL_PANEL_SELECT_WALLPAPER, CHANNEL_PANEL_OPEN, CHANNEL_PANEL_CHANGED, CHANNEL_PANEL_MANAGE, CHANNEL_PANEL_LOG, decodeState } from "../shared/protocol.ts";
import { isMainWindowUrl } from "../shared/window.ts";
import { mountOverlay } from "./overlay.ts";

const isMainWindow = window === window.top && isMainWindowUrl(location.href);

if (isMainWindow) {
  const log = (message: string) => { try { ipcRenderer.send(CHANNEL_PANEL_LOG, message); } catch { /* Old runtimes may lack this channel. */ } };
  let key: string | null = null;
  const apply = (css: string) => {
    if (key) webFrame.removeInsertedCSS(key);
    key = css ? webFrame.insertCSS(css) : null;
  };
  try {
    // A payload from a newer runtime protocol (main upgraded on disk, ZCode not restarted) is
    // ignored: half-understood styling is worse than none until the next launch.
    const css = decodeState(ipcRenderer.sendSync(CHANNEL_GET));
    if (css !== null) apply(css);
  } catch (error) {
    log(`initial CSS: ${String(error)}`);
  }
  ipcRenderer.on(CHANNEL_CSS, (_event, payload: unknown) => {
    try {
      const css = decodeState(payload);
      if (css !== null) apply(css);
    } catch (error) {
      log(`updated CSS: ${String(error)}`);
    }
  });
  let overlay: ReturnType<typeof mountOverlay> | undefined;
  let requested = false;
  let previewKey: string | null = null;
  const clearPreview = () => {
    if (previewKey) webFrame.removeInsertedCSS(previewKey);
    previewKey = null;
  };
  const mount = () => {
    try {
      overlay = mountOverlay({
        get: () => ipcRenderer.invoke(CHANNEL_PANEL_GET),
        apply: (value) => ipcRenderer.invoke(CHANNEL_PANEL_APPLY, value),
        selectWallpaper: (id) => ipcRenderer.invoke(CHANNEL_PANEL_SELECT_WALLPAPER, id),
        pickWallpaper: () => ipcRenderer.invoke(CHANNEL_PANEL_PICK_WALLPAPER),
        manage: () => ipcRenderer.invoke(CHANNEL_PANEL_MANAGE),
        preview: (css) => { clearPreview(); previewKey = css ? webFrame.insertCSS(css) : null; },
        clearPreview, log,
      });
      if (requested) overlay.open();
    } catch (error) { log(`mount: ${String(error)}`); }
  };
  try {
    ipcRenderer.on(CHANNEL_PANEL_OPEN, () => {
      try { if (overlay) overlay.open(); else requested = true; } catch (error) { log(String(error)); }
    });
    ipcRenderer.on(CHANNEL_PANEL_CHANGED, () => {
      try { overlay?.refresh(); } catch (error) { log(String(error)); }
    });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
    else mount();
  } catch (error) { log(`overlay wiring: ${String(error)}`); }
}
