import { contextBridge, ipcRenderer } from "electron";
import { CHANNEL_PANEL_APPLY, CHANNEL_PANEL_GET, CHANNEL_PANEL_PICK_WALLPAPER } from "../shared/protocol.ts";
contextBridge.exposeInMainWorld("zcodeCanvas", {
  get: () => ipcRenderer.invoke(CHANNEL_PANEL_GET),
  apply: (value: unknown) => ipcRenderer.invoke(CHANNEL_PANEL_APPLY, value),
  pickWallpaper: () => ipcRenderer.invoke(CHANNEL_PANEL_PICK_WALLPAPER),
});
