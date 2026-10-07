import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { GLASS_REGIONS, regionAlphas, type GlassRegion, type GlassRegionSpec, type ResolvedRegion } from "./glass.ts";
import { filteredBackdrop, generatePalette, isPaletteColor, PALETTE_VARIANTS, type PaletteBackdrop, type PaletteReadability, type PaletteSpec, type PaletteVariant } from "./palette.ts";
import type { PetSpec } from "./pet.ts";

export type Mode = "dark" | "light";
export type Material = "acrylic" | "mica" | "tabbed" | "none";
export type WallpaperFit = "cover" | "contain" | "fill" | "tile" | "center";
export type StartupAnimation = "pop" | "fade" | "none";

export const MATERIALS: readonly Material[] = ["acrylic", "mica", "tabbed", "none"];
export const WALLPAPER_FITS: readonly WallpaperFit[] = ["cover", "contain", "fill", "tile", "center"];
export const STARTUP_ANIMATIONS: readonly StartupAnimation[] = ["pop", "fade", "none"];

export interface WallpaperSpec {
  /** Image file (png/jpg/webp/avif/gif/svg). Relative paths resolve against the theme or canvas home. */
  image?: string | null;
  fit?: WallpaperFit;
  /** CSS background-position, e.g. "center", "right bottom", "30% 50%". */
  position?: string;
  /** Blur radius of the wallpaper itself, in px. */
  blur?: number;
  /** Strength of the readability overlay, 0..1. */
  dim?: number;
  /** Overlay color. Defaults to black in dark mode and white in light mode. */
  overlay?: string | null;
  /** Zoom of the painted wallpaper around `position`, 1 = the fit as-is. */
  scale?: number;
  /** Color filters, 1 = unfiltered; grayscale is 0..1. */
  saturate?: number;
  brightness?: number;
  contrast?: number;
  grayscale?: number;
}

export interface GlassSpec {
  /** Native Windows backdrop material behind the window. ZCode ships with "acrylic". */
  material?: Material;
  /** Opacity of ZCode's surfaces, 0..1. 1 keeps the official opaque look. */
  opacity?: number;
  /** Backdrop blur applied to the main content surfaces, in px. */
  blur?: number;
  /** Per-region opacity / blur; a region or field left out follows `opacity` / `blur`. */
  regions?: Partial<Record<GlassRegion, GlassRegionSpec>>;
}

export interface ResolvedGlass {
  material: Material;
  opacity: number;
  blur: number;
  regions: Record<GlassRegion, ResolvedRegion>;
}

export interface StartupSpec {
  /** Background of the startup overlay (any CSS color or gradient). */
  background?: string | null;
  /** Image that replaces the ZCode logo tile on the startup screen. */
  logo?: string | null;
  /** Logo size in px (the official tile is 96). */
  logoSize?: number;
  animation?: StartupAnimation;
}

export type ModeMap<T> = Partial<Record<Mode, T>>;

/** The theme.json format this build understands. Bumped only for incompatible changes. */
export const FORMAT_VERSION = 1;

export const MODES: readonly Mode[] = ["dark", "light"];

export const SCHEMA_URL = "https://raw.githubusercontent.com/Kevinzzz6/zcode-canvas/main/schema/theme.schema.json";

/**
 * Wallpaper for both modes, optionally refined per mode: fields in `dark` / `light` override the
 * shared ones for that mode, and `"dark": null` removes the wallpaper in dark mode only.
 */
export interface WallpaperLayer extends WallpaperSpec {
  dark?: WallpaperSpec | null;
  light?: WallpaperSpec | null;
}

/**
 * Custom properties for both modes (keys start with `--`), optionally refined per mode; `"dark": null`
 * clears the dark-mode vars only.
 */
export type VarsSpec = { [property: `--${string}`]: string } & {
  dark?: Record<string, string> | null;
  light?: Record<string, string> | null;
};

/** Everything that defines a look. Shared by theme manifests and the user config. */
export interface LookSpec {
  /** ZCode color tokens per mode. Keys are token names without prefix ("sidebar") or "--color-sidebar". */
  colors?: ModeMap<Record<string, string>>;
  /** Fills primary / brand / ring (and a readable primary-foreground) wherever `colors` leaves them unset. */
  accent?: string | ModeMap<string> | null;
  /** Corner radius scale: 1 = official, 0 = square corners. `rounded-full` shapes stay round. */
  radius?: number | null;
  /** Generates a full set of color tokens around one seed color. `colors` in the same layer refine it. */
  palette?: PaletteSpec | null;
  /** Other CSS custom properties, for anything that has no dedicated field. */
  vars?: VarsSpec | null;
  wallpaper?: WallpaperLayer | null;
  glass?: GlassSpec;
  startup?: StartupSpec;
}

export interface ThemeManifest extends LookSpec {
  $schema?: string;
  /** theme.json format version; omitted means 1. */
  format?: number;
  name: string;
  description?: string;
  author?: string;
  /** Version of the theme itself. */
  version?: string;
  /** SPDX license id, e.g. "MIT". */
  license?: string;
  /** Where the theme or the work it adapts comes from (URL). */
  source?: string;
  /** Modes the theme is designed for; omitted means both. */
  modes?: Mode[];
}

export interface CanvasConfig extends LookSpec {
  /** Master switch. false leaves ZCode exactly as shipped. */
  enabled?: boolean;
  /** Active theme id (folder name), or null for none. */
  theme?: string | null;
  /** The desktop pet (shared/pet.ts). Not part of the look: never saved into a theme. */
  pet?: PetSpec;
}

export interface ResolvedWallpaper {
  image: string;
  fit: WallpaperFit;
  position: string;
  blur: number;
  dim: number;
  overlay: string | null;
  scale: number;
  saturate: number;
  brightness: number;
  contrast: number;
  grayscale: number;
}

export interface ResolvedStartup {
  background: string | null;
  logo: string | null;
  logoSize: number;
  animation: StartupAnimation;
}

export interface ResolvedLook {
  colors: Record<Mode, Record<string, string>>;
  accent: ModeMap<string>;
  radius: number | null;
  vars: Record<Mode, Record<string, string>>;
  wallpaper: Record<Mode, ResolvedWallpaper | null>;
  glass: ResolvedGlass;
  startup: ResolvedStartup;
  /** The palette in effect, and how readable its body text is over the wallpaper per mode. */
  palette: { seed: string; variant: PaletteVariant; readability: Record<Mode, PaletteReadability | null> } | null;
}

export interface ThemeEntry {
  id: string;
  dir: string;
  builtin: boolean;
  manifest: ThemeManifest;
}

/** `uid` is the process's user id, null where there is none (Windows). Not undefined: an explicit
 *  undefined would fall back to this process's real uid. */
export function canvasHome(env: NodeJS.ProcessEnv = process.env, uid: number | null = process.getuid?.() ?? null): string {
  if (env.ZCODE_CANVAS_HOME) return env.ZCODE_CANVAS_HOME;
  // `sudo zcode-canvas apply` must still install into the invoking user's home: ZCode reads it as
  // that user, not as root. Windows has no sudo, so SUDO_USER never appears there.
  const sudoUser = env.SUDO_USER;
  if (sudoUser && sudoUser !== "root" && (uid === null || uid === 0)) {
    const homes = process.platform === "darwin" ? "/Users" : "/home";
    return join(homes, sudoUser, ".zcode-canvas");
  }
  return join(homedir(), ".zcode-canvas");
}

export const paths = {
  config: (home: string) => join(home, "config.json"),
  userThemes: (home: string) => join(home, "themes"),
  runtime: (home: string) => join(home, "runtime"),
  builtinThemes: (home: string) => join(home, "runtime", "themes"),
  log: (home: string) => join(home, "runtime.log"),
  openRequest: (home: string) => join(home, ".open-panel"),
  /** Where the desktop-mode pet sits (runtime/pet-desktop-position.ts). A UI preference, not config. */
  petPosition: (home: string) => join(home, "pet-position.json"),
};

export const DEFAULT_CONFIG: CanvasConfig = { enabled: true, theme: null };

export function readConfig(home: string): CanvasConfig {
  const file = paths.config(home);
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    // V8's message already names the offending token and position; add the file and a way out.
    throw new Error(
      `配置文件 ${file} 不是有效的 JSON（${(error as Error).message}）。\n` +
        "  请修正语法错误后重试；或删除该文件，主题设置会回到默认。",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`配置文件 ${file} 的内容不是 JSON 对象。\n  请修正后重试；或删除该文件，主题设置会回到默认。`);
  }
  return { ...DEFAULT_CONFIG, ...(parsed as CanvasConfig) };
}

/** Replace config.json in one rename, so a reader never sees a half-written file. */
export function writeConfigAtomic(home: string, config: CanvasConfig): void {
  mkdirSync(home, { recursive: true });
  const target = paths.config(home);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

/** User themes shadow built-in themes with the same id. */
export function listThemes(home: string, extraBuiltinDirs: string[] = []): ThemeEntry[] {
  const found = new Map<string, ThemeEntry>();
  const sources: Array<[string, boolean]> = [
    ...extraBuiltinDirs.map((dir): [string, boolean] => [dir, true]),
    [paths.builtinThemes(home), true],
    [paths.userThemes(home), false],
  ];
  for (const [root, builtin] of sources) {
    if (!existsSync(root)) continue;
    for (const id of readdirSync(root)) {
      const dir = join(root, id);
      const manifestFile = join(dir, "theme.json");
      if (!statSync(dir).isDirectory() || !existsSync(manifestFile)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as ThemeManifest;
        found.set(id, { id, dir, builtin, manifest });
      } catch {
        // A broken theme must not take the others down; `zcode-canvas themes` reports it.
      }
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function resolveFile(base: string, value: string | null | undefined): string | null | undefined {
  if (value == null || value === "") return value;
  return isAbsolute(value) ? value : resolve(base, value);
}

function withResolvedFiles(spec: LookSpec, base: string): LookSpec {
  const out: LookSpec = { ...spec };
  if (spec.wallpaper) {
    const layer: WallpaperLayer = { ...spec.wallpaper };
    if ("image" in layer) layer.image = resolveFile(base, layer.image);
    for (const mode of MODES) {
      const sub = layer[mode];
      if (sub && "image" in sub) layer[mode] = { ...sub, image: resolveFile(base, sub.image) };
    }
    out.wallpaper = layer;
  }
  if (spec.startup) out.startup = { ...spec.startup, logo: resolveFile(base, spec.startup.logo) };
  return out;
}

function perMode<T>(value: T | ModeMap<T> | null | undefined, isLeaf: (v: unknown) => v is T): ModeMap<T> {
  if (value == null) return {};
  if (isLeaf(value)) return { dark: value, light: value };
  return value as ModeMap<T>;
}

const isString = (v: unknown): v is string => typeof v === "string";

/** Splits a shared-plus-per-mode object into what applies to each mode; `null` means "remove". */
function splitModes<T extends object>(layer: T & ModeMap<object | null>): Record<Mode, (T & object) | null> {
  const shared = { ...layer } as Record<string, unknown>;
  for (const mode of MODES) delete shared[mode];
  const result = {} as Record<Mode, (T & object) | null>;
  for (const mode of MODES) {
    const own = layer[mode];
    result[mode] = own === null ? null : ({ ...shared, ...(own ?? {}) } as T & object);
  }
  return result;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function resolveWallpaper(spec: WallpaperSpec | null): ResolvedWallpaper | null {
  if (!spec?.image) return null;
  return {
    image: spec.image,
    fit: oneOf(spec.fit, WALLPAPER_FITS, "cover"),
    position: spec.position || "center",
    blur: clamp(spec.blur, 0, 200, 0),
    dim: clamp(spec.dim, 0, 1, 0.35),
    overlay: spec.overlay ?? null,
    scale: clamp(spec.scale, 0.1, 4, 1),
    saturate: clamp(spec.saturate, 0, 4, 1),
    brightness: clamp(spec.brightness, 0, 2, 1),
    contrast: clamp(spec.contrast, 0, 2, 1),
    grayscale: clamp(spec.grayscale, 0, 1, 0),
  };
}

/** The glass of one layer merged onto the ones below it; regions merge region by region, field by field. */
function mergeGlass(below: GlassSpec, layer: GlassSpec): GlassSpec {
  const merged: GlassSpec = { ...below, ...layer };
  if (below.regions || layer.regions) {
    const regions: Partial<Record<GlassRegion, GlassRegionSpec>> = {};
    for (const region of GLASS_REGIONS) {
      const own = { ...(below.regions?.[region] ?? {}), ...(layer.regions?.[region] ?? {}) };
      if (Object.keys(own).length) regions[region] = own;
    }
    merged.regions = regions;
  }
  return merged;
}

function resolveGlass(glass: GlassSpec): ResolvedGlass {
  const opacity = clamp(glass.opacity, 0, 1, 1);
  const blur = clamp(glass.blur, 0, 100, 0);
  const regions = {} as Record<GlassRegion, ResolvedRegion>;
  for (const region of GLASS_REGIONS) {
    const own = glass.regions?.[region];
    regions[region] = {
      opacity: clamp(own?.opacity, 0, 1, opacity),
      blur: region === "frame" ? 0 : clamp(own?.blur, 0, 100, blur),
    };
  }
  return { material: oneOf(glass.material, MATERIALS, "acrylic"), opacity, blur, regions };
}

/** The look fields of a theme manifest or config, i.e. everything a theme can be saved with. */
export const LOOK_KEYS = ["colors", "accent", "radius", "palette", "vars", "wallpaper", "glass", "startup"] as const;

/** Theme and config as layers, bottom first, with file references made absolute. */
export function lookLayers(config: CanvasConfig, theme: ThemeEntry | null, home: string): LookSpec[] {
  const layers: LookSpec[] = [];
  if (theme) layers.push(withResolvedFiles(theme.manifest, theme.dir));
  layers.push(withResolvedFiles(config, home));
  return layers;
}

/** Every field but `colors`, merged across layers; still specs, so defaults and "follows" stay implicit. */
export interface MergedLook {
  accent: ModeMap<string>;
  radius: number | null;
  vars: Record<Mode, Record<string, string>>;
  wallpaper: Record<Mode, WallpaperSpec | null>;
  glass: GlassSpec;
  startup: StartupSpec;
  /** The topmost palette and the layer it sits in: it replaces the color tokens of the layers below. */
  palette: { spec: PaletteSpec; layer: number } | null;
}

export function mergeLayers(layers: LookSpec[]): MergedLook {
  const vars: Record<Mode, Record<string, string>> = { dark: {}, light: {} };
  const wallpaper: Record<Mode, WallpaperSpec | null> = { dark: null, light: null };
  let accent: ModeMap<string> = {};
  let radius: number | null = null;
  let glass: GlassSpec = {};
  let startup: StartupSpec = {};
  let palette: { spec: PaletteSpec; layer: number } | null = null;

  layers.forEach((layer, index) => {
    if (layer.palette === null) palette = null;
    else if (layer.palette && isPaletteColor(layer.palette.seed)) palette = { spec: layer.palette, layer: index };
    if (layer.accent === null) accent = {};
    else if (layer.accent !== undefined) accent = { ...accent, ...perMode(layer.accent, isString) };
    if (layer.radius !== undefined) radius = layer.radius === null ? null : clamp(layer.radius, 0, 4, 1);
    if (layer.vars === null) for (const mode of MODES) vars[mode] = {};
    else if (layer.vars) {
      const split = splitModes(layer.vars);
      for (const mode of MODES) {
        const own = split[mode];
        if (own === null) vars[mode] = {};
        else Object.assign(vars[mode], own);
      }
    }
    if (layer.wallpaper === null) for (const mode of MODES) wallpaper[mode] = null;
    else if (layer.wallpaper) {
      const split = splitModes(layer.wallpaper);
      for (const mode of MODES) {
        const own = split[mode];
        wallpaper[mode] = own === null ? null : { ...(wallpaper[mode] ?? {}), ...own };
      }
    }
    if (layer.glass) glass = mergeGlass(glass, layer.glass);
    if (layer.startup) startup = { ...startup, ...layer.startup };
  });
  return { accent, radius, vars, wallpaper, glass, startup, palette };
}

/**
 * Merge theme + user config into one look. The config wins field by field; an explicit `null`
 * in the config removes what the theme set (e.g. `"wallpaper": null`).
 */
export function resolveLook(config: CanvasConfig, theme: ThemeEntry | null, home: string): ResolvedLook {
  const layers = lookLayers(config, theme, home);
  const { accent, radius, vars, wallpaper, glass, startup, palette } = mergeLayers(layers);
  const colors: Record<Mode, Record<string, string>> = { dark: {}, light: {} };

  const resolvedGlass = resolveGlass(glass);
  const resolvedWallpaper = { dark: resolveWallpaper(wallpaper.dark), light: resolveWallpaper(wallpaper.light) };

  // A palette replaces the tokens of the layers below it and is refined by `colors` of its own layer
  // and the layers above: a user palette recolors a theme, a theme's colors refine its own palette.
  const active = palette as { spec: PaletteSpec; layer: number } | null;
  let generated: ReturnType<typeof generatePalette> = null;
  if (active) {
    const alphas = regionAlphas(resolvedGlass.regions);
    const backdrops: Partial<Record<Mode, PaletteBackdrop>> = {};
    const average = active.spec.backdrop;
    for (const mode of MODES) {
      const shown = resolvedWallpaper[mode];
      if (!shown || !isPaletteColor(average) || alphas.main >= 1) continue;
      backdrops[mode] = {
        color: filteredBackdrop(average, shown.brightness, shown.dim, shown.overlay, mode),
        frameAlpha: alphas.frame,
        mainAlpha: alphas.main,
      };
    }
    generated = generatePalette(active.spec, backdrops);
  }
  layers.forEach((layer, index) => {
    if (generated && active && index === active.layer) for (const mode of MODES) Object.assign(colors[mode], generated.colors[mode]);
    for (const mode of MODES) Object.assign(colors[mode], layer.colors?.[mode]);
  });

  // A personal accent overrides the theme's primary colors, including themes which spell out
  // those tokens explicitly. Explicit *user* color tokens remain more specific than the accent.
  const personalAccent = perMode(config.accent, isString);
  for (const mode of MODES) {
    if (!personalAccent[mode]) continue;
    const own = config.colors?.[mode] ?? {};
    for (const token of ["primary", "brand", "ring", "primary-foreground"]) {
      for (const key of [token, `--color-${token}`]) {
        if (!(key in own)) delete colors[mode][key];
      }
    }
  }

  return {
    colors,
    accent,
    radius,
    vars,
    wallpaper: resolvedWallpaper,
    glass: resolvedGlass,
    startup: {
      background: startup.background ?? null,
      logo: startup.logo ?? null,
      logoSize: clamp(startup.logoSize, 16, 512, 96),
      animation: oneOf(startup.animation, STARTUP_ANIMATIONS, "pop"),
    },
    palette: generated && active
      ? {
          seed: active.spec.seed.toLowerCase(),
          variant: PALETTE_VARIANTS.includes(active.spec.variant as PaletteVariant) ? active.spec.variant! : "natural",
          readability: generated.readability,
        }
      : null,
  };
}

const MANIFEST_KEYS = new Set<string>(["$schema", "format", "name", "description", "author", "version", "license", "source", "modes", ...LOOK_KEYS]);

/** Problems in a theme.json that do not stop it from loading. */
export function checkManifest(id: string, manifest: ThemeManifest): string[] {
  const warnings: string[] = [];
  const format = manifest.format ?? FORMAT_VERSION;
  if (!Number.isInteger(format) || format < 1) warnings.push(`theme "${id}": invalid format ${JSON.stringify(manifest.format)}`);
  else if (format > FORMAT_VERSION)
    warnings.push(`theme "${id}" uses format ${format}; this Canvas understands format ${FORMAT_VERSION}, update zcode-canvas`);
  for (const key of Object.keys(manifest)) if (!MANIFEST_KEYS.has(key)) warnings.push(`theme "${id}": unknown field "${key}"`);
  if (manifest.modes !== undefined && (!Array.isArray(manifest.modes) || manifest.modes.some((m) => !MODES.includes(m))))
    warnings.push(`theme "${id}": modes must be a list of "dark" / "light"`);
  return warnings;
}

/** Load config + active theme from disk and resolve them. `null` means Canvas is switched off. */
export function loadLook(home: string, extraBuiltinDirs: string[] = []): { look: ResolvedLook | null; warnings: string[] } {
  const warnings: string[] = [];
  const config = readConfig(home);
  if (config.enabled === false) return { look: null, warnings };
  let theme: ThemeEntry | null = null;
  if (config.theme) {
    theme = listThemes(home, extraBuiltinDirs).find((t) => t.id === config.theme) ?? null;
    if (!theme) warnings.push(`theme "${config.theme}" not found`);
    else warnings.push(...checkManifest(theme.id, theme.manifest));
  }
  return { look: resolveLook(config, theme, home), warnings };
}
