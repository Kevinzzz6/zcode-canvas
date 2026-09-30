// The channel names and payload format shared by the Canvas main-process runtime and its session
// preload. The runtime is loaded from ~/.zcode-canvas once, when ZCode starts, while the preload is
// re-read from disk for every page: after `zcode-canvas apply` upgrades the runtime on disk, a
// running ZCode briefly mixes the old main with the new preload. The payload therefore carries a
// version, decoders accept one version back (and the pre-versioning bare string), and anything
// newer is ignored rather than misinterpreted — styling then resumes on the next ZCode start.

export const CHANNEL_GET = "zcode-canvas:get";
export const CHANNEL_CSS = "zcode-canvas:css";
export const CHANNEL_PANEL_GET = "zcode-canvas:panel-get";
export const CHANNEL_PANEL_APPLY = "zcode-canvas:panel-apply";
export const CHANNEL_PANEL_PREVIEW = "zcode-canvas:panel-preview";
export const CHANNEL_PANEL_PICK_WALLPAPER = "zcode-canvas:panel-pick-wallpaper";
export const CHANNEL_PANEL_SELECT_WALLPAPER = "zcode-canvas:panel-select-wallpaper";
export const CHANNEL_PANEL_SAVE_THEME = "zcode-canvas:panel-save-theme";
export const CHANNEL_PANEL_OPEN = "zcode-canvas:panel-open";
export const CHANNEL_PANEL_CHANGED = "zcode-canvas:panel-changed";
export const CHANNEL_PANEL_LOG = "zcode-canvas:panel-log";

/**
 * Not a Canvas channel: ZCode's own notification that its shortcut recorder armed/disarmed
 * (desktopMainIpcPlatform.ts). The runtime observes it so the panel shortcut stands down while a
 * recording is in progress — otherwise the user could never bind this combination in ZCode.
 */
export const ZCODE_SET_SHORTCUT_RECORDING = "zcode:set-shortcut-recording-active";

export const PROTOCOL_VERSION = 1;

export interface CanvasStatePayload {
  v: number;
  css: string;
}

export function encodeState(css: string): CanvasStatePayload {
  return { v: PROTOCOL_VERSION, css };
}

/** The CSS of the payload, or null when it comes from an incompatible (newer) protocol. */
export function decodeState(payload: unknown): string | null {
  if (typeof payload === "string") return payload; // a main process older than versioned payloads
  if (typeof payload !== "object" || payload === null) return null;
  const { v, css } = payload as Partial<CanvasStatePayload>;
  if (v !== PROTOCOL_VERSION || typeof css !== "string") return null;
  return css;
}
