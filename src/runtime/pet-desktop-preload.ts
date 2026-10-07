// Preload of the desktop-mode pet page only (pet-desktop.html, in its own session partition). The
// page gets exactly what the pet needs and nothing else: its payload, facing and probes in, its pointer
// reports, drags and errors out.
import { contextBridge, ipcRenderer } from "electron";
import { CHANNEL_PET, CHANNEL_PET_DRAG, CHANNEL_PET_FACING, CHANNEL_PET_GET, CHANNEL_PET_LOG, CHANNEL_PET_POINTER, CHANNEL_PET_PROBE } from "../shared/protocol.ts";

contextBridge.exposeInMainWorld("zcodeCanvasPet", {
  get: (): Promise<unknown> => ipcRenderer.invoke(CHANNEL_PET_GET),
  onUpdate: (listener: (payload: unknown) => void) => {
    ipcRenderer.on(CHANNEL_PET, (_event, payload: unknown) => listener(payload));
  },
  onFacing: (listener: (left: boolean) => void) => {
    ipcRenderer.on(CHANNEL_PET_FACING, (_event, left: unknown) => listener(left === true));
  },
  onProbe: (listener: (x: number, y: number) => void) => {
    ipcRenderer.on(CHANNEL_PET_PROBE, (_event, point: { x?: unknown; y?: unknown } | null) => {
      if (typeof point?.x === "number" && typeof point.y === "number" && Number.isFinite(point.x) && Number.isFinite(point.y)) listener(point.x, point.y);
    });
  },
  pointer: (report: unknown) => ipcRenderer.send(CHANNEL_PET_POINTER, report),
  drag: (kind: unknown) => {
    if (kind === "start" || kind === "move" || kind === "end") ipcRenderer.send(CHANNEL_PET_DRAG, kind);
  },
  log: (message: unknown) => {
    if (typeof message === "string") ipcRenderer.send(CHANNEL_PET_LOG, message.slice(0, 1000));
  },
});
