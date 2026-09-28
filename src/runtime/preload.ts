// Session preload: runs in every page of ZCode's default session before any page script, so the
// CSS is in place for the very first paint (including the startup screen).
import { ipcRenderer, webFrame } from "electron";
import { CHANNEL_CSS, CHANNEL_GET, decodeState } from "../shared/protocol.ts";

const isMainWindow =
  location.protocol === "file:" &&
  /\/out\/renderer\/index\.html$/.test(location.pathname) &&
  !new URLSearchParams(location.search).has("windowKind");

if (isMainWindow) {
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
  } catch {
    // Never break ZCode's renderer over styling.
  }
  ipcRenderer.on(CHANNEL_CSS, (_event, payload: unknown) => {
    try {
      const css = decodeState(payload);
      if (css !== null) apply(css);
    } catch {
      // Same as above.
    }
  });
}
