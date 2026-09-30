// Theme Studio: turns "theme + personal overrides" into one theme folder that renders the same, so a
// look tuned in the appearance panel can be kept, switched back to and shared.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";
import { ACCENT_TOKENS, contrastForeground } from "./css.ts";
import {
  FORMAT_VERSION,
  listThemes,
  LOOK_KEYS,
  lookLayers,
  mergeLayers,
  MODES,
  paths,
  readConfig,
  resolveLook,
  SCHEMA_URL,
  writeConfigAtomic,
  type CanvasConfig,
  type LookSpec,
  type Mode,
  type ModeMap,
  type ThemeEntry,
  type ThemeManifest,
  type VarsSpec,
  type WallpaperLayer,
} from "./look.ts";

type ThemeMeta = Omit<ThemeManifest, (typeof LOOK_KEYS)[number]>;

const shortToken = (key: string) => (key.startsWith("--color-") ? key.slice("--color-".length) : key);

/** One value for both modes when they agree, so saved themes read like hand-written ones. */
function shared<T extends object>(byMode: Record<Mode, T | null>): (T & ModeMap<T | null>) | undefined {
  const { dark, light } = byMode;
  if (!dark && !light) return undefined;
  if (dark && light && JSON.stringify(dark) === JSON.stringify(light)) return { ...dark };
  return { dark, light } as T & ModeMap<T | null>;
}

/**
 * Theme + config as a single theme layer that renders the same. Two rules only hold across layers
 * and are spelled out here: a personal palette replaces the theme's color tokens, and a personal
 * accent beats primary colors from the layer below. File references stay absolute.
 */
export function flattenLook(config: CanvasConfig, theme: ThemeEntry | null, home: string): LookSpec {
  const merged = mergeLayers(lookLayers(config, theme, home));
  const look: LookSpec = {};
  if (merged.palette) look.palette = merged.palette.spec;
  const { dark, light } = merged.accent;
  if (dark || light) look.accent = dark === light ? dark : merged.accent;
  if (merged.radius !== null) look.radius = merged.radius;
  const vars = shared({ dark: Object.keys(merged.vars.dark).length ? merged.vars.dark : null, light: Object.keys(merged.vars.light).length ? merged.vars.light : null });
  if (vars) look.vars = vars as VarsSpec;
  const wallpaper = shared({ dark: merged.wallpaper.dark?.image ? merged.wallpaper.dark : null, light: merged.wallpaper.light?.image ? merged.wallpaper.light : null });
  if (wallpaper) look.wallpaper = wallpaper as WallpaperLayer;
  if (Object.keys(merged.glass).length) look.glass = merged.glass;
  if (Object.keys(merged.startup).length) look.startup = merged.startup;

  // Colors: whatever the two layers produce, minus what the flattened palette already generates.
  const target = resolveLook(config, theme, home).colors;
  const generated = resolveLook({}, { id: "", dir: home, builtin: false, manifest: { name: "", ...look } }, home).colors;
  const colors: ModeMap<Record<string, string>> = {};
  for (const mode of MODES) {
    const want: Record<string, string> = {};
    for (const [key, value] of Object.entries(target[mode])) want[shortToken(key)] = value;
    const own: Record<string, string> = {};
    for (const [key, value] of Object.entries(want)) if (generated[mode][key] !== value) own[key] = value;
    // Only a personal accent removes generated tokens; single-layer, it has to name them.
    const accent = merged.accent[mode];
    for (const token of ACCENT_TOKENS) {
      if (accent && token in generated[mode] && !(token in want)) own[token] = token === "primary-foreground" ? contrastForeground(accent) : accent;
    }
    if (Object.keys(own).length) colors[mode] = own;
  }
  if (colors.dark || colors.light) look.colors = colors;
  return look;
}

/** Validated display name for a saved theme. */
function themeName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("invalid theme name");
  return name;
}

/** A free folder name derived from the display name; non-Latin names fall back to "custom". */
function themeId(name: string, taken: (id: string) => boolean): string {
  const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "custom";
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Write `look` as the user theme `id`. Referenced files are copied in under content-hashed names;
 * files already inside the theme folder stay where they are. A new theme is staged outside the
 * themes folder and moved in whole, so hot reload never sees half of it; replacing keeps the old
 * theme.json as theme.json.bak.
 */
export function writeTheme(home: string, id: string, meta: ThemeMeta, look: LookSpec, replace: boolean): void {
  if (!/^[\w-]+$/.test(id)) throw new Error(`invalid theme id ${JSON.stringify(id)}`);
  const dir = join(paths.userThemes(home), id);
  if (!replace && existsSync(dir)) throw new Error(`主题目录已存在: ${dir}`);
  const staging = replace ? dir : join(home, `.theme-${id}-${process.pid}`);
  if (!replace) rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const place = (file: string | null | undefined, stem: string) => {
      if (!file) return file;
      const inside = relative(dir, file);
      if (replace && inside && !inside.startsWith("..") && !isAbsolute(inside)) return inside.replace(/\\/g, "/");
      if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`找不到主题用到的文件: ${file}`);
      const name = `${stem}-${createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12)}${extname(file).toLowerCase()}`;
      if (!existsSync(join(staging, name))) copyFileSync(file, join(staging, name));
      return name;
    };
    const manifest: ThemeManifest = { $schema: SCHEMA_URL, format: FORMAT_VERSION, ...meta, ...look };
    if (look.wallpaper) {
      const wallpaper: WallpaperLayer = { ...look.wallpaper, image: place(look.wallpaper.image, "wallpaper") };
      for (const mode of MODES) {
        const own = wallpaper[mode];
        if (own?.image) wallpaper[mode] = { ...own, image: place(own.image, "wallpaper") };
      }
      manifest.wallpaper = wallpaper;
    }
    if (look.startup?.logo) manifest.startup = { ...look.startup, logo: place(look.startup.logo, "logo") };
    const file = join(staging, "theme.json");
    if (replace && existsSync(file)) copyFileSync(file, `${file}.bak`);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
    if (!replace) {
      mkdirSync(paths.userThemes(home), { recursive: true });
      renameSync(staging, dir);
    }
  } catch (error) {
    if (!replace) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Save the current look into the active user theme (`name` omitted) or as a new theme, then switch
 * to it with every personal look override removed: from now on the theme owns them.
 */
export function saveLookAsTheme(home: string, name?: unknown, extraBuiltinDirs: string[] = []): { id: string; name: string } {
  const config = readConfig(home);
  const themes = listThemes(home, extraBuiltinDirs);
  const current = config.theme ? themes.find((entry) => entry.id === config.theme) ?? null : null;
  const look = flattenLook(config, current, home);
  let id: string;
  let meta: ThemeMeta;
  if (name === undefined) {
    if (!current || current.builtin) throw new Error("only a user theme can be saved in place");
    id = current.id;
    meta = Object.fromEntries(Object.entries(current.manifest).filter(([key]) => !(LOOK_KEYS as readonly string[]).includes(key))) as ThemeMeta;
    writeTheme(home, id, meta, look, true);
  } else {
    // Attribution of the theme it derives from (artwork license, source) carries over.
    const { license, source, modes } = current?.manifest ?? {};
    meta = { name: themeName(name), ...(license ? { license } : {}), ...(source ? { source } : {}), ...(modes ? { modes } : {}) };
    id = themeId(meta.name, (candidate) => themes.some((entry) => entry.id === candidate) || existsSync(join(paths.userThemes(home), candidate)));
    writeTheme(home, id, meta, look, false);
  }
  const next: CanvasConfig = { ...config, theme: id };
  for (const key of LOOK_KEYS) delete next[key];
  writeConfigAtomic(home, next);
  return { id, name: meta.name };
}
