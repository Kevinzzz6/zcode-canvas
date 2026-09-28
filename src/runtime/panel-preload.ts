import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("zcodeCanvas", {
  get: () => ipcRenderer.invoke("zcode-canvas:panel-get"),
  apply: (value: unknown) => ipcRenderer.invoke("zcode-canvas:panel-apply", value),
});
