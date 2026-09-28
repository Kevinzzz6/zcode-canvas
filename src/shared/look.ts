import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type Mode = "dark" | "light";
export type Material = "acrylic" | "mica" | "tabbed" | "none";
export type WallpaperFit = "cover" | "contain" | "fill" | "tile" | "center";
export type StartupAnimation = "pop" | "fade" | "none";

export const MATERIALS: readonly Material[] = ["acrylic", "mica", "tabbed", "none"];
export const WALLPAPER_FITS: readonly WallpaperFit[] = ["cover", "contain", "fill", "tile", "center"];
export const STARTUP_ANIMATIONS: readonly StartupAnimation[] = ["pop", "fade", "none"];

export interface WallpaperSpec {
  /** Image file (png/jpg/webp/avif/gif). Relative paths resolve against the theme or canvas home. */
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
}

export interface GlassSpec {
  /** Native Windows backdrop material behind the window. ZCode ships with "acrylic". */
  material?: Material;
  /** Opacity of ZCode's surfaces, 0..1. 1 keeps the official opaque look. */
  opacity?: number;
  /** Backdrop blur applied to the main content surfaces, in px. */
  blur?: number;
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

/** Custom properties for both modes (keys start with `--`), optionally refined per mode. */
export type VarsSpec = { [property: `--${string}`]: string } & {
  dark?: Record<string, string>;
  light?: Record<string, string>;
};

/** Everything that defines a look. Shared by theme manifests and the user config. */
export interface LookSpec {
  /** ZCode color tokens per mode. Keys are token names without prefix ("sidebar") or "--color-sidebar". */
  colors?: ModeMap<Record<string, string>>;
  /** Fills primary / brand / ring (and a readable primary-foreground) wherever `colors` leaves them unset. */
  accent?: string | ModeMap<string> | null;
  /** Corner radius scale: 1 = official, 0 = square corners. `rounded-full` shapes stay round. */
  radius?: number | null;
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
}

export interface ResolvedWallpaper {
  image: string;
  fit: WallpaperFit;
  position: string;
  blur: number;
  dim: number;
  overlay: string | null;
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
  glass: Required<GlassSpec>;
  startup: ResolvedStartup;
}

export interface ThemeEntry {
  id: string;
  dir: string;
  builtin: boolean;
  manifest: ThemeManifest;
}

export function canvasHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ZCODE_CANVAS_HOME) return env.ZCODE_CANVAS_HOME;
  // `sudo zcode-canvas apply` must still install into the invoking user's home: ZCode reads it as
  // that user, not as root. Windows has no sudo, so SUDO_USER never appears there.
  const sudoUser = env.SUDO_USER;
  if (sudoUser && sudoUser !== "root" && (typeof process.getuid !== "function" || process.getuid() === 0)) {
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
};

export const DEFAULT_CONFIG: CanvasConfig = { enabled: true, theme: null };

export function readConfig(home: string): CanvasConfig {
  const file = paths.config(home);
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(file, "utf8")) as CanvasConfig) };
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
  };
}

/**
 * Merge theme + user config into one look. The config wins field by field; an explicit `null`
 * in the config removes what the theme set (e.g. `"wallpaper": null`).
 */
export function resolveLook(config: CanvasConfig, theme: ThemeEntry | null, home: string): ResolvedLook {
  const layers: LookSpec[] = [];
  if (theme) layers.push(withResolvedFiles(theme.manifest, theme.dir));
  layers.push(withResolvedFiles(config, home));

  const colors: Record<Mode, Record<string, string>> = { dark: {}, light: {} };
  const vars: Record<Mode, Record<string, string>> = { dark: {}, light: {} };
  const wallpaper: Record<Mode, WallpaperSpec | null> = { dark: null, light: null };
  let accent: ModeMap<string> = {};
  let radius: number | null = null;
  let glass: GlassSpec = {};
  let startup: StartupSpec = {};

  for (const layer of layers) {
    for (const mode of MODES) Object.assign(colors[mode], layer.colors?.[mode]);
    if (layer.accent === null) accent = {};
    else if (layer.accent !== undefined) accent = { ...accent, ...perMode(layer.accent, isString) };
    if (layer.radius !== undefined) radius = layer.radius === null ? null : clamp(layer.radius, 0, 4, 1);
    if (layer.vars === null) for (const mode of MODES) vars[mode] = {};
    else if (layer.vars) {
      const split = splitModes(layer.vars);
      for (const mode of MODES) Object.assign(vars[mode], split[mode]);
    }
    if (layer.wallpaper === null) for (const mode of MODES) wallpaper[mode] = null;
    else if (layer.wallpaper) {
      const split = splitModes(layer.wallpaper);
      for (const mode of MODES) {
        const own = split[mode];
        wallpaper[mode] = own === null ? null : { ...(wallpaper[mode] ?? {}), ...own };
      }
    }
    if (layer.glass) glass = { ...glass, ...layer.glass };
    if (layer.startup) startup = { ...startup, ...layer.startup };
  }

  return {
    colors,
    accent,
    radius,
    vars,
    wallpaper: { dark: resolveWallpaper(wallpaper.dark), light: resolveWallpaper(wallpaper.light) },
    glass: {
      material: oneOf(glass.material, MATERIALS, "acrylic"),
      opacity: clamp(glass.opacity, 0, 1, 1),
      blur: clamp(glass.blur, 0, 100, 0),
    },
    startup: {
      background: startup.background ?? null,
      logo: startup.logo ?? null,
      logoSize: clamp(startup.logoSize, 16, 512, 96),
      animation: oneOf(startup.animation, STARTUP_ANIMATIONS, "pop"),
    },
  };
}

const MANIFEST_KEYS = new Set([
  "$schema", "format", "name", "description", "author", "version", "license", "source", "modes",
  "colors", "accent", "radius", "vars", "wallpaper", "glass", "startup",
]);

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
