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

/** Everything that defines a look. Shared by theme manifests and the user config. */
export interface LookSpec {
  /** ZCode design tokens per mode. Keys are token names without prefix ("sidebar") or full custom properties ("--color-sidebar"). */
  colors?: ModeMap<Record<string, string>>;
  /** Accent color, either one value or one per mode. */
  accent?: string | ModeMap<string> | null;
  wallpaper?: WallpaperSpec | null;
  glass?: GlassSpec;
  startup?: StartupSpec;
}

export interface ThemeManifest extends LookSpec {
  name: string;
  author?: string;
  description?: string;
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
  wallpaper: ResolvedWallpaper | null;
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
  return env.ZCODE_CANVAS_HOME || join(homedir(), ".zcode-canvas");
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
  if (spec.wallpaper) out.wallpaper = { ...spec.wallpaper, image: resolveFile(base, spec.wallpaper.image) };
  if (spec.startup) out.startup = { ...spec.startup, logo: resolveFile(base, spec.startup.logo) };
  return out;
}

function perMode<T>(value: T | ModeMap<T> | null | undefined, isLeaf: (v: unknown) => v is T): ModeMap<T> {
  if (value == null) return {};
  if (isLeaf(value)) return { dark: value, light: value };
  return value as ModeMap<T>;
}

const isString = (v: unknown): v is string => typeof v === "string";

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
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
  let accent: ModeMap<string> = {};
  let wallpaper: WallpaperSpec | null = null;
  let glass: GlassSpec = {};
  let startup: StartupSpec = {};

  for (const layer of layers) {
    for (const mode of ["dark", "light"] as const) Object.assign(colors[mode], layer.colors?.[mode]);
    if (layer.accent === null) accent = {};
    else if (layer.accent !== undefined) accent = { ...accent, ...perMode(layer.accent, isString) };
    if (layer.wallpaper === null) wallpaper = null;
    else if (layer.wallpaper !== undefined) wallpaper = { ...(wallpaper ?? {}), ...layer.wallpaper };
    if (layer.glass) glass = { ...glass, ...layer.glass };
    if (layer.startup) startup = { ...startup, ...layer.startup };
  }

  return {
    colors,
    accent,
    wallpaper: wallpaper?.image
      ? {
          image: wallpaper.image,
          fit: oneOf(wallpaper.fit, WALLPAPER_FITS, "cover"),
          position: wallpaper.position || "center",
          blur: clamp(wallpaper.blur, 0, 200, 0),
          dim: clamp(wallpaper.dim, 0, 1, 0.35),
          overlay: wallpaper.overlay ?? null,
        }
      : null,
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

/** Load config + active theme from disk and resolve them. `null` means Canvas is switched off. */
export function loadLook(home: string, extraBuiltinDirs: string[] = []): { look: ResolvedLook | null; warnings: string[] } {
  const warnings: string[] = [];
  const config = readConfig(home);
  if (config.enabled === false) return { look: null, warnings };
  let theme: ThemeEntry | null = null;
  if (config.theme) {
    theme = listThemes(home, extraBuiltinDirs).find((t) => t.id === config.theme) ?? null;
    if (!theme) warnings.push(`theme "${config.theme}" not found`);
  }
  return { look: resolveLook(config, theme, home), warnings };
}
