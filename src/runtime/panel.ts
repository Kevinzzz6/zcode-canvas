// Everything the appearance panel does, kept free of electron imports so it can be tested outside
// ZCode: main.ts only wires the IPC channels, the native file dialog and the panel window.
//
// The panel exposes exactly two concepts. `theme` selects a whole look; a wallpaper picked with the
// native dialog overrides only the theme's wallpaper. Clearing the wallpaper (config.wallpaper =
// null) lets the theme's own wallpaper show again; clearing the theme never touches the wallpaper.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { listThemes, readConfig, WALLPAPER_FITS, writeConfigAtomic, type CanvasConfig, type ThemeManifest, type WallpaperFit } from "../shared/look.ts";
import { CHANNEL_PANEL_APPLY, CHANNEL_PANEL_GET, CHANNEL_PANEL_PICK_WALLPAPER } from "../shared/protocol.ts";

/** Image formats the panel accepts; a gif plays its animation in the CSS background. Anything
 *  executable stays out of scope. */
export const WALLPAPER_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg", ".gif"];

export interface PanelThemeInfo {
  id: string;
  name: string;
  builtin: boolean;
}

export interface PanelData {
  config: CanvasConfig;
  themes: PanelThemeInfo[];
  /** The user's own wallpaper override (file name only), and whether the theme ships one instead. */
  wallpaper: { file: string | null; fromTheme: boolean };
}

function themeHasWallpaper(manifest: ThemeManifest): boolean {
  const wallpaper = manifest.wallpaper;
  return !!wallpaper && !!(wallpaper.image || wallpaper.dark?.image || wallpaper.light?.image);
}

export function readPanelData(home: string): PanelData {
  const config = readConfig(home);
  const themes = listThemes(home);
  const file =
    typeof config.wallpaper?.image === "string" && config.wallpaper.image
      ? wallpaperDisplayName(basename(config.wallpaper.image))
      : null;
  const active = config.theme ? themes.find((entry) => entry.id === config.theme) : undefined;
  return {
    config,
    themes: themes.map(({ id, manifest, builtin }) => ({ id, name: manifest.name, builtin })),
    wallpaper: { file, fromTheme: !file && active !== undefined && themeHasWallpaper(active.manifest) },
  };
}

export interface PanelInput {
  theme?: unknown;
  wallpaper?: unknown;
  fit?: unknown;
  blur?: unknown;
  dim?: unknown;
}

/**
 * Apply one panel request to the config. Only the fields present in the request change: picking a
 * theme never clears the wallpaper override, and wallpaper settings never clear the theme. Throws
 * on anything the panel UI would not have produced.
 */
export function applyPanelInput(config: CanvasConfig, input: PanelInput, home: string): CanvasConfig {
  if (!input || typeof input !== "object") throw new Error("invalid panel request");
  const next = { ...config };
  if (input.theme !== undefined) {
    if (input.theme === null || input.theme === "") next.theme = null;
    else if (typeof input.theme === "string" && listThemes(home).some((entry) => entry.id === input.theme)) next.theme = input.theme;
    else throw new Error("unknown theme");
  }
  if (input.wallpaper !== undefined) {
    if (input.wallpaper === null) next.wallpaper = null;
    else throw new Error("wallpaper must be picked with the file dialog");
  }
  if (input.fit !== undefined || input.blur !== undefined || input.dim !== undefined) {
    const wallpaper = { ...(next.wallpaper ?? {}) };
    if (input.fit !== undefined) {
      if (typeof input.fit !== "string" || !WALLPAPER_FITS.includes(input.fit as WallpaperFit)) throw new Error("invalid wallpaper fit");
      wallpaper.fit = input.fit as WallpaperFit;
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
    next.wallpaper = wallpaper;
  }
  return next;
}

/**
 * Where a stored wallpaper file may live. Flat white-listed names only, and when something already
 * exists at the path its real location must still be inside the store — a symlink planted there
 * must never be written through.
 */
export function storedWallpaperPath(home: string, fileName: string): string {
  if (typeof fileName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName) || fileName.includes(".."))
    throw new Error("invalid wallpaper file name");
  const root = resolve(home, "imports", "wallpaper");
  const candidate = resolve(root, fileName);
  if (dirname(candidate) !== root) throw new Error("wallpaper path escapes the store");
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return candidate;
  }
  try {
    const real = realpathSync(candidate);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error("wallpaper path escapes the store");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return candidate;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Short content digest in a stored wallpaper's name, so two different images that happen to share
 *  a file name never overwrite each other — and re-picking the same image reuses the same file. */
function contentTag(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
}

/** The stored name without its content tag, e.g. "pic-1a2b….jpg" → "pic.jpg". Old names pass through. */
export function wallpaperDisplayName(fileName: string): string {
  return fileName.replace(/-[0-9a-f]{12}(?=\.[^.]+$)/, "");
}

/** Copy a main-process-picked image into the Canvas store and return its stored path. */
export function importWallpaperFile(source: string, home: string): string {
  const extension = extname(source).toLowerCase();
  if (!WALLPAPER_EXTENSIONS.includes(extension))
    throw new Error(`不支持的壁纸格式 "${extension || basename(source)}"，支持 ${WALLPAPER_EXTENSIONS.join(" / ")}`);
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`所选文件不可用: ${basename(source)}`);
  mkdirSync(resolve(home, "imports", "wallpaper"), { recursive: true });
  // Strip the extension by its original spelling, so PIC.PNG becomes pic's "PIC.png", not "PIC.PNG.png".
  const stem = safeName(basename(source, extname(source))) || "wallpaper";
  // The content tag is part of the name, so a file already sitting there has the same bytes and
  // the copy can be skipped. Throws on a hostile name or a symlink planted at the destination.
  const destination = storedWallpaperPath(home, `${stem}-${contentTag(source)}${extension}`);
  if (!existsSync(destination)) copyFileSync(source, destination);
  return destination;
}

export interface PanelIpc {
  handle(channel: string, listener: (event: unknown, value?: unknown) => unknown): void;
}

export interface PanelHandlersDeps {
  home: string;
  ipc: PanelIpc;
  log: (message: string) => void;
  /** Opens the native picker in the main process; resolves null when the user cancels. */
  pickWallpaperFile: () => Promise<string | null>;
  reload: () => void;
  /** True when a request comes from the panel window's own webContents; everything else is refused.
   *  ipcMain handlers are process-wide, so without this any page in ZCode could drive the panel. */
  isPanelSender: (event: unknown) => boolean;
}

/**
 * Registers the three panel channels. Each registration is guarded on its own: a channel that
 * cannot be registered (or a handler that fails on a request) is logged and skipped — the base
 * theming runtime keeps running either way.
 */
export function registerPanelHandlers({ home, ipc, log, pickWallpaperFile, reload, isPanelSender }: PanelHandlersDeps): void {
  const register = (channel: string, listener: (event: unknown, value?: unknown) => unknown): void => {
    try {
      ipc.handle(channel, (event, value) => {
        if (!isPanelSender(event)) {
          log(`panel ${channel}: refused a request that did not come from the panel window`);
          throw new Error("refused: sender is not the appearance panel");
        }
        return listener(event, value);
      });
    } catch (error) {
      log(`panel ${channel} unavailable: ${String(error)}`);
    }
  };

  register(CHANNEL_PANEL_GET, () => readPanelData(home));

  register(CHANNEL_PANEL_APPLY, (_event, value) => {
    const config = applyPanelInput(readConfig(home), value as PanelInput, home);
    writeConfigAtomic(home, config);
    reload();
    return { ok: true };
  });

  register(CHANNEL_PANEL_PICK_WALLPAPER, async () => {
    const source = await pickWallpaperFile();
    if (!source) return { canceled: true };
    const destination = importWallpaperFile(source, home);
    const config = readConfig(home);
    config.wallpaper = { ...(config.wallpaper ?? {}), image: destination };
    writeConfigAtomic(home, config);
    reload();
    return { canceled: false, file: wallpaperDisplayName(basename(destination)) };
  });
}
