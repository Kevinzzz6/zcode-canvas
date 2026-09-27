// Session preload: runs in every page of ZCode's default session before any page script, so the
// CSS is in place for the very first paint (including the startup screen).
import { ipcRenderer, webFrame } from "electron";

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
    apply(ipcRenderer.sendSync("zcode-canvas:get") as string);
  } catch {
    // Never break ZCode's renderer over styling.
  }
  ipcRenderer.on("zcode-canvas:css", (_event, css: string) => {
    try {
      apply(css);
    } catch {
      // Same as above.
    }
  });
}
