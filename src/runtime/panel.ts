// Everything the appearance panel does, kept free of electron imports so it can be tested outside
// ZCode: main.ts only wires the IPC channels, the native file dialog and the panel window.
//
// The panel selects a theme, stores wallpaper images, and applies validated personal appearance
// controls. Clearing an image restores the theme's wallpaper; resetting controls keeps the image.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCss, isSafeCssValue } from "../shared/css.ts";
import { GLASS_REGIONS, type GlassRegion, type GlassRegionSpec } from "../shared/glass.ts";
import { listThemes, MATERIALS, readConfig, resolveLook, WALLPAPER_FITS, writeConfigAtomic, type CanvasConfig, type GlassSpec, type Material, type Mode, type ResolvedLook, type ThemeManifest, type WallpaperFit, type WallpaperLayer } from "../shared/look.ts";
import { isPaletteColor, PALETTE_VARIANTS, type PaletteSpec, type PaletteVariant } from "../shared/palette.ts";
import { CHANNEL_PANEL_APPLY, CHANNEL_PANEL_GET, CHANNEL_PANEL_PICK_WALLPAPER, CHANNEL_PANEL_PREVIEW, CHANNEL_PANEL_SELECT_WALLPAPER } from "../shared/protocol.ts";

/** Image formats the panel accepts; a gif plays its animation in the CSS background. Anything
 *  executable stays out of scope. */
export const WALLPAPER_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg", ".gif"];

export interface PanelThemeInfo {
  id: string;
  name: string;
  builtin: boolean;
  swatch: { background: string; accent: string };
}

export interface PanelWallpaperInfo {
  /** Flat file name in the Canvas import store, never a renderer-supplied filesystem path. */
  id: string;
  name: string;
  url: string;
  animated: boolean;
}

export interface PanelData {
  config: CanvasConfig;
  themes: PanelThemeInfo[];
  wallpapers: PanelWallpaperInfo[];
  effective: ResolvedLook;
  defaults: ResolvedLook;
  /** What each region shows once its personal override is removed: the theme's region value, or the current global glass. */
  regionDefaults: ResolvedLook["glass"]["regions"];
  /** Region fields that neither the theme nor the user set, so they move with the global glass controls. */
  regionFollows: Record<GlassRegion, { opacity: boolean; blur: boolean }>;
  overrides: { theme: boolean; wallpaper: boolean };
  platform: string;
  /** file: URL of the image each mode paints, so the overlay can measure how the fit crops it. */
  imageUrl: Record<Mode, string | null>;
  /** The user's own wallpaper override (file name only), and whether the theme ships one instead. */
  wallpaper: { id: string | null; file: string | null; fromTheme: boolean };
}

function themeHasWallpaper(manifest: ThemeManifest): boolean {
  const wallpaper = manifest.wallpaper;
  return !!wallpaper && !!(wallpaper.image || wallpaper.dark?.image || wallpaper.light?.image);
}

function safeSwatchColor(value: unknown): string | null {
  return typeof value === "string" && value.trim() && isSafeCssValue(value, "color") ? value : null;
}

function themeSwatch(manifest: ThemeManifest): PanelThemeInfo["swatch"] {
  const dark = manifest.colors?.dark ?? {};
  const light = manifest.colors?.light ?? {};
  const background = safeSwatchColor(dark.background) ?? safeSwatchColor(dark["background-win-alt"])
    ?? safeSwatchColor(light.background) ?? "#202534";
  const accent = safeSwatchColor(typeof manifest.accent === "string" ? manifest.accent : manifest.accent?.dark)
    ?? safeSwatchColor(dark.primary) ?? safeSwatchColor(dark.brand)
    ?? safeSwatchColor(typeof manifest.accent === "object" && manifest.accent ? manifest.accent.light : null)
    ?? "#8b7cf5";
  return { background, accent };
}

/** Ignore unsupported files, directories and symlinks escaping the import store. */
export function listStoredWallpapers(home: string): PanelWallpaperInfo[] {
  const root = resolve(home, "imports", "wallpaper");
  if (!existsSync(root)) return [];
  const wallpapers: PanelWallpaperInfo[] = [];
  for (const id of readdirSync(root)) {
    try {
      if (!WALLPAPER_EXTENSIONS.includes(extname(id).toLowerCase())) continue;
      const file = storedWallpaperPath(home, id);
      if (!statSync(file).isFile()) continue;
      wallpapers.push({ id, name: wallpaperDisplayName(id), url: pathToFileURL(file).href, animated: extname(id).toLowerCase() === ".gif" });
    } catch {
      // A malformed entry or hostile symlink must not hide the rest of the library.
    }
  }
  return wallpapers.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function selectedStoredWallpaperId(home: string, image: unknown): string | null {
  if (typeof image !== "string") return null;
  const id = basename(image);
  try {
    const file = resolve(home, image);
    return storedWallpaperPath(home, id) === file && statSync(file).isFile() ? id : null;
  } catch {
    return null;
  }
}

export function readPanelData(home: string): PanelData {
  const config = readConfig(home);
  const themes = listThemes(home);
  const wallpapers = listStoredWallpapers(home);
  const id = selectedStoredWallpaperId(home, config.wallpaper?.image);
  const file =
    typeof config.wallpaper?.image === "string" && config.wallpaper.image
      ? wallpaperDisplayName(basename(config.wallpaper.image))
      : null;
  const active = config.theme ? themes.find((entry) => entry.id === config.theme) : undefined;
  // A hand-edited `wallpaper: null` really does remove the theme's wallpaper; don't claim it shows.
  const fromTheme = !file && config.wallpaper !== null && active !== undefined && themeHasWallpaper(active.manifest);
  const effective = resolveLook(config, active ?? null, home);
  const withoutRegions: CanvasConfig = { ...config };
  if (config.glass?.regions) {
    const { regions: _personal, ...glass } = config.glass;
    withoutRegions.glass = glass;
  }
  const imageUrl = (mode: Mode) => {
    const image = effective.wallpaper[mode]?.image;
    try { return image ? pathToFileURL(image).href : null; } catch { return null; }
  };
  return {
    config,
    themes: themes.map(({ id, manifest, builtin }) => ({ id, name: manifest.name, builtin, swatch: themeSwatch(manifest) })),
    wallpapers,
    effective,
    defaults: resolveLook({ theme: config.theme }, active ?? null, home),
    regionDefaults: resolveLook(withoutRegions, active ?? null, home).glass.regions,
    regionFollows: Object.fromEntries(GLASS_REGIONS.map((region) => {
      const set = (field: keyof GlassRegionSpec) =>
        active?.manifest.glass?.regions?.[region]?.[field] !== undefined || config.glass?.regions?.[region]?.[field] !== undefined;
      return [region, { opacity: !set("opacity"), blur: !set("blur") }];
    })) as PanelData["regionFollows"],
    overrides: {
      theme: config.accent !== undefined || config.radius !== undefined || config.palette !== undefined || !!config.glass && Object.keys(config.glass).length > 0,
      wallpaper: !!config.wallpaper && WALLPAPER_CONTROL_KEYS.some((key) =>
        key in config.wallpaper! || !!config.wallpaper?.dark && key in config.wallpaper.dark || !!config.wallpaper?.light && key in config.wallpaper.light),
    },
    platform: process.platform,
    imageUrl: { dark: imageUrl("dark"), light: imageUrl("light") },
    wallpaper: { id: id && wallpapers.some((entry) => entry.id === id) ? id : null, file, fromTheme },
  };
}

export interface PanelInput {
  theme?: unknown;
  wallpaper?: unknown;
  fit?: unknown;
  blur?: unknown;
  dim?: unknown;
  scale?: unknown;
  saturate?: unknown;
  brightness?: unknown;
  contrast?: unknown;
  grayscale?: unknown;
  glassOpacity?: unknown;
  glassBlur?: unknown;
  material?: unknown;
  accent?: unknown;
  radius?: unknown;
  /** `{ seed, variant, backdrop? }` sets a Smart Palette; null removes the personal one. */
  palette?: unknown;
  frameOpacity?: unknown;
  mainOpacity?: unknown;
  mainBlur?: unknown;
  cardOpacity?: unknown;
  cardBlur?: unknown;
  inputOpacity?: unknown;
  inputBlur?: unknown;
  positionX?: unknown;
  positionY?: unknown;
  reset?: unknown;
  clearOverlay?: unknown;
  /** Control names whose personal override is removed, so the theme's value applies again. */
  unset?: unknown;
}

/** Numeric wallpaper knobs and the ranges the panel may set them to. */
const WALLPAPER_NUMBERS = {
  blur: [0, 200],
  dim: [0, 1],
  scale: [0.1, 4],
  saturate: [0, 4],
  brightness: [0, 2],
  contrast: [0, 2],
  grayscale: [0, 1],
} as const;
const WALLPAPER_CONTROL_KEYS = ["fit", "position", ...Object.keys(WALLPAPER_NUMBERS)] as const;
/** Per-region glass controls: the region, its field, and the range. */
const REGION_INPUTS = {
  frameOpacity: ["frame", "opacity", 1],
  mainOpacity: ["main", "opacity", 1],
  mainBlur: ["main", "blur", 100],
  cardOpacity: ["card", "opacity", 1],
  cardBlur: ["card", "blur", 100],
  inputOpacity: ["input", "opacity", 1],
  inputBlur: ["input", "blur", 100],
} as const satisfies Record<string, readonly [GlassRegion, keyof GlassRegionSpec, number]>;
type RegionInput = keyof typeof REGION_INPUTS;
const REGION_INPUT_KEYS = Object.keys(REGION_INPUTS) as RegionInput[];
const PANEL_INPUT_KEYS = new Set([
  "theme", "wallpaper", "fit", ...Object.keys(WALLPAPER_NUMBERS), ...REGION_INPUT_KEYS,
  "glassOpacity", "glassBlur", "material", "accent", "radius", "palette", "positionX", "positionY", "reset", "clearOverlay", "unset",
]);
const UNSET_KEYS = new Set(["glassOpacity", "glassBlur", "radius", "positionX", "positionY", ...Object.keys(WALLPAPER_NUMBERS), ...REGION_INPUT_KEYS]);

/** A glass override with the given region fields removed; empty regions and an empty glass disappear. */
function withoutRegionFields(glass: GlassSpec, keys: readonly RegionInput[]): GlassSpec {
  if (!glass.regions) return glass;
  const regions = { ...glass.regions };
  for (const key of keys) {
    const [region, field] = REGION_INPUTS[key];
    const own: GlassRegionSpec = { ...(regions[region] ?? {}) };
    delete own[field];
    if (Object.keys(own).length) regions[region] = own;
    else delete regions[region];
  }
  const next: GlassSpec = { ...glass, regions };
  if (!Object.keys(regions).length) delete next.regions;
  return next;
}

function parsePalette(raw: unknown): PaletteSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid palette");
  const { seed, variant, backdrop, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length || !isPaletteColor(seed) || !PALETTE_VARIANTS.includes(variant as PaletteVariant)
    || (backdrop !== undefined && !isPaletteColor(backdrop))) throw new Error("invalid palette");
  return { seed: seed.toLowerCase(), variant: variant as PaletteVariant, ...(backdrop ? { backdrop: (backdrop as string).toLowerCase() } : {}) };
}

function panelNumber(raw: unknown, min: number, max: number, label: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max) throw new Error(`invalid ${label}`);
  return raw;
}

function positionAxes(value: string | undefined): [number, number] | null {
  if (!value) return null;
  const keywords: Record<string, number> = { left: 0, top: 0, center: 50, right: 100, bottom: 100 };
  const parts = value.trim().toLowerCase().split(/\s+/);
  const axis = (part: string): number | null => {
    if (part in keywords) return keywords[part]!;
    const match = /^(\d+(?:\.\d+)?)%$/.exec(part);
    if (!match) return null;
    const n = Number(match[1]);
    return n <= 100 ? n : null;
  };
  if (parts.length === 1) {
    const n = axis(parts[0]!);
    if (n === null) return null;
    return parts[0] === "top" || parts[0] === "bottom" ? [50, n] : [n, 50];
  }
  if (parts.length !== 2) return null;
  const vertical = (part: string) => part === "top" || part === "bottom";
  const horizontal = (part: string) => part === "left" || part === "right";
  const reversed = vertical(parts[0]!) && (horizontal(parts[1]!) || parts[1] === "center");
  const x = axis(parts[reversed ? 1 : 0]!);
  const y = axis(parts[reversed ? 0 : 1]!);
  return x === null || y === null ? null : [x, y];
}

function copyWallpaper(wallpaper: WallpaperLayer | null | undefined): WallpaperLayer {
  const copy: WallpaperLayer = { ...(wallpaper ?? {}) };
  for (const mode of ["dark", "light"] as const) if (copy[mode] && typeof copy[mode] === "object") copy[mode] = { ...copy[mode] };
  return copy;
}

function withoutWallpaperKeys(wallpaper: WallpaperLayer | null | undefined, keys: readonly string[]): WallpaperLayer | null | undefined {
  if (wallpaper === null || wallpaper === undefined) return wallpaper;
  const clean: WallpaperLayer = { ...wallpaper };
  for (const key of keys) delete (clean as Record<string, unknown>)[key];
  for (const mode of ["dark", "light"] as const) {
    if (clean[mode] && typeof clean[mode] === "object") {
      const own = { ...clean[mode] };
      for (const key of keys) delete (own as Record<string, unknown>)[key];
      clean[mode] = own;
    }
  }
  return Object.keys(clean).length ? clean : undefined;
}

function withoutWallpaperControls(wallpaper: WallpaperLayer | null | undefined): WallpaperLayer | null | undefined {
  return withoutWallpaperKeys(wallpaper, WALLPAPER_CONTROL_KEYS);
}

function setWallpaper(config: CanvasConfig, wallpaper: WallpaperLayer | null | undefined): void {
  if (wallpaper === undefined) delete config.wallpaper;
  else config.wallpaper = wallpaper;
}

/** Remove single personal overrides. One position axis falls back to the theme's axis, the other stays. */
function unsetControls(next: CanvasConfig, keys: unknown, home: string): void {
  if (!Array.isArray(keys) || !keys.length || keys.some((key) => typeof key !== "string" || !UNSET_KEYS.has(key)))
    throw new Error("invalid unset request");
  const glass = withoutRegionFields({ ...(next.glass ?? {}) }, keys.filter((key): key is RegionInput => key in REGION_INPUTS));
  if (keys.includes("glassOpacity")) delete glass.opacity;
  if (keys.includes("glassBlur")) delete glass.blur;
  if (next.glass) {
    if (Object.keys(glass).length) next.glass = glass;
    else delete next.glass;
  }
  if (keys.includes("radius")) delete next.radius;
  setWallpaper(next, withoutWallpaperKeys(next.wallpaper, keys.filter((key) => key in WALLPAPER_NUMBERS)));
  const axes = keys.filter((key) => key === "positionX" || key === "positionY");
  if (!axes.length || !next.wallpaper) return;
  const own = positionAxes(next.wallpaper.position);
  const withoutPosition = withoutWallpaperKeys(next.wallpaper, ["position"]);
  const theme = next.theme ? listThemes(home).find((entry) => entry.id === next.theme) ?? null : null;
  const inherited = resolveLook({ ...next, wallpaper: withoutPosition }, theme, home).wallpaper;
  const fallback = positionAxes(inherited.dark?.position) ?? positionAxes(inherited.light?.position) ?? [50, 50];
  const x = axes.includes("positionX") ? fallback[0] : own?.[0] ?? fallback[0];
  const y = axes.includes("positionY") ? fallback[1] : own?.[1] ?? fallback[1];
  if (x === fallback[0] && y === fallback[1]) setWallpaper(next, withoutPosition);
  else next.wallpaper = { ...copyWallpaper(withoutPosition), position: `${x}% ${y}%` };
}

function imageWithUnobscuredOverlay(wallpaper: WallpaperLayer): WallpaperLayer {
  if (wallpaper.dim !== undefined || wallpaper.dark?.dim !== undefined || wallpaper.light?.dim !== undefined) return wallpaper;
  return { ...wallpaper, dim: 0 };
}

/**
 * Apply one panel request to the config. Only the fields present in the request change: picking a
 * theme never clears the wallpaper override, and wallpaper settings never clear the theme. Throws
 * on anything the panel UI would not have produced.
 */
export function applyPanelInput(config: CanvasConfig, input: PanelInput, home: string): CanvasConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid panel request");
  for (const key of Object.keys(input)) if (!PANEL_INPUT_KEYS.has(key)) throw new Error(`unknown panel field ${key}`);
  const next = { ...config };
  if (input.reset !== undefined) {
    if (input.reset === "theme") {
      delete next.accent;
      delete next.radius;
      delete next.glass;
      delete next.palette;
    } else if (input.reset === "wallpaper") {
      const wallpaper = withoutWallpaperControls(next.wallpaper);
      if (wallpaper === undefined) delete next.wallpaper;
      else next.wallpaper = wallpaper;
    } else throw new Error("invalid reset target");
  }
  if (input.unset !== undefined) unsetControls(next, input.unset, home);
  if (input.clearOverlay !== undefined) {
    if (input.clearOverlay !== true) throw new Error("invalid clearOverlay request");
    const wallpaper: WallpaperLayer = { ...copyWallpaper(next.wallpaper), dim: 0 };
    for (const mode of ["dark", "light"] as const) {
      if (wallpaper[mode] && typeof wallpaper[mode] === "object") {
        const own = { ...wallpaper[mode] };
        delete own.dim;
        wallpaper[mode] = own;
      }
    }
    next.wallpaper = wallpaper;
  }
  if (input.theme !== undefined) {
    if (input.theme === null || input.theme === "") next.theme = null;
    else if (typeof input.theme === "string" && listThemes(home).some((entry) => entry.id === input.theme)) next.theme = input.theme;
    else throw new Error("unknown theme");
  }
  if (input.wallpaper !== undefined) {
    // Clearing removes the override. Writing `null` instead would mean "no wallpaper at all": in
    // resolveLook an explicit null in the config also removes the theme's own wallpaper.
    if (input.wallpaper === null) delete next.wallpaper;
    else throw new Error("wallpaper must be picked with the file dialog");
  }
  const request = input as Record<string, unknown>;
  const numberKeys = Object.keys(WALLPAPER_NUMBERS) as Array<keyof typeof WALLPAPER_NUMBERS>;
  if (input.fit !== undefined || numberKeys.some((key) => request[key] !== undefined) || input.positionX !== undefined || input.positionY !== undefined) {
    const wallpaper = copyWallpaper(next.wallpaper);
    if (input.fit !== undefined) {
      if (typeof input.fit !== "string" || !WALLPAPER_FITS.includes(input.fit as WallpaperFit)) throw new Error("invalid wallpaper fit");
      wallpaper.fit = input.fit as WallpaperFit;
      for (const mode of ["dark", "light"] as const) if (wallpaper[mode] && typeof wallpaper[mode] === "object") delete (wallpaper[mode] as Record<string, unknown>).fit;
    }
    for (const key of numberKeys) {
      const raw = request[key];
      if (raw === undefined) continue;
      const [min, max] = WALLPAPER_NUMBERS[key];
      const n = panelNumber(raw, min, max, `wallpaper ${key}`);
      (wallpaper as Record<string, unknown>)[key] = n;
      for (const mode of ["dark", "light"] as const) if (wallpaper[mode] && typeof wallpaper[mode] === "object") delete (wallpaper[mode] as Record<string, unknown>)[key];
    }
    if (input.positionX !== undefined || input.positionY !== undefined) {
      const currentTheme = next.theme ? listThemes(home).find((entry) => entry.id === next.theme) ?? null : null;
      const resolved = resolveLook(next, currentTheme, home);
      const prior = positionAxes(wallpaper.position) ?? positionAxes(resolved.wallpaper.dark?.position) ?? positionAxes(resolved.wallpaper.light?.position) ?? [50, 50];
      const x = input.positionX === undefined ? prior[0] : panelNumber(input.positionX, 0, 100, "wallpaper positionX");
      const y = input.positionY === undefined ? prior[1] : panelNumber(input.positionY, 0, 100, "wallpaper positionY");
      wallpaper.position = `${x}% ${y}%`;
      for (const mode of ["dark", "light"] as const) if (wallpaper[mode] && typeof wallpaper[mode] === "object") delete (wallpaper[mode] as Record<string, unknown>).position;
    }
    next.wallpaper = wallpaper;
  }
  const regionKeys = REGION_INPUT_KEYS.filter((key) => request[key] !== undefined);
  if (input.glassOpacity !== undefined || input.glassBlur !== undefined || input.material !== undefined || regionKeys.length) {
    const glass: GlassSpec = { ...(next.glass ?? {}), ...(next.glass?.regions ? { regions: { ...next.glass.regions } } : {}) };
    if (input.glassOpacity !== undefined) glass.opacity = panelNumber(input.glassOpacity, 0, 1, "glass opacity");
    if (input.glassBlur !== undefined) glass.blur = panelNumber(input.glassBlur, 0, 100, "glass blur");
    if (input.material !== undefined) {
      if (typeof input.material !== "string" || !MATERIALS.includes(input.material as Material)) throw new Error("invalid material");
      glass.material = input.material as Material;
    }
    for (const key of regionKeys) {
      const [region, field, max] = REGION_INPUTS[key];
      const regions = glass.regions ?? {};
      regions[region] = { ...(regions[region] ?? {}), [field]: panelNumber(request[key], 0, max, `glass ${key}`) };
      glass.regions = regions;
    }
    next.glass = glass;
  }
  if (input.palette !== undefined) {
    // Clearing removes the override, so a theme's own palette applies again. Setting one drops the
    // personal accent: it would otherwise repaint the palette's primary colors.
    if (input.palette === null) delete next.palette;
    else {
      next.palette = parsePalette(input.palette);
      delete next.accent;
    }
  }
  if (input.accent !== undefined) {
    if (input.accent === null) delete next.accent;
    else if (typeof input.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(input.accent)) next.accent = input.accent;
    else throw new Error("invalid accent");
  }
  if (input.radius !== undefined) next.radius = panelNumber(input.radius, 0, 4, "radius");
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
  /** True for an explicitly verified panel or main-renderer sender; ipcMain handlers are process-wide. */
  isPanelSender: (event: unknown) => boolean;
}

/**
 * Registers the panel channels. Each registration is guarded on its own: a channel that
 * cannot be registered (or a handler that fails on a request) is logged and skipped — the base
 * theming runtime keeps running either way.
 */
export function registerPanelHandlers({ home, ipc, log, pickWallpaperFile, reload, isPanelSender }: PanelHandlersDeps): void {
  const register = (channel: string, listener: (event: unknown, value?: unknown) => unknown): void => {
    try {
      ipc.handle(channel, async (event, value) => {
        try {
          if (!isPanelSender(event)) throw new Error("refused: sender is not an authorized appearance panel caller");
          return await listener(event, value);
        } catch (error) {
          log(`panel ${channel} failed: ${String(error)}`);
          throw error;
        }
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

  register(CHANNEL_PANEL_PREVIEW, (_event, value) => {
    const config = applyPanelInput(readConfig(home), value as PanelInput, home);
    if (config.enabled === false) return { css: "" };
    const theme = config.theme ? listThemes(home).find((entry) => entry.id === config.theme) ?? null : null;
    return { css: buildCss(resolveLook(config, theme, home)).css };
  });

  register(CHANNEL_PANEL_PICK_WALLPAPER, async () => {
    const source = await pickWallpaperFile();
    if (!source) return { canceled: true };
    const destination = importWallpaperFile(source, home);
    const config = readConfig(home);
    config.wallpaper = imageWithUnobscuredOverlay({ ...(config.wallpaper ?? {}), image: destination });
    writeConfigAtomic(home, config);
    reload();
    return { canceled: false, file: wallpaperDisplayName(basename(destination)) };
  });

  register(CHANNEL_PANEL_SELECT_WALLPAPER, (_event, value) => {
    if (typeof value !== "string" || !WALLPAPER_EXTENSIONS.includes(extname(value).toLowerCase()))
      throw new Error("invalid stored wallpaper id");
    const file = storedWallpaperPath(home, value);
    if (!statSync(file).isFile()) throw new Error("stored wallpaper is not a file");
    const config = readConfig(home);
    config.wallpaper = imageWithUnobscuredOverlay({ ...(config.wallpaper ?? {}), image: file });
    writeConfigAtomic(home, config);
    reload();
    return { ok: true };
  });
}
