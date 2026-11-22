import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { readConfig, writeConfigAtomic, type CanvasConfig, type WallpaperLayer, type WallpaperSpec } from "../shared/look.ts";
import { removeStoredWallpaper, storedWallpaperPath, storeWallpaper, wallpaperDisplayName, WALLPAPER_EXTENSIONS, withUnobscuredOverlay } from "../shared/wallpaper-store.ts";

const PREVIEW_TYPES = new Set(["scene", "video", "web"]);

export interface WallpaperImportResult {
  source: string;
  destination: string;
  config: CanvasConfig;
}

function fail(message: string): never {
  throw new Error(`Wallpaper Engine 导入失败: ${message}`);
}

function projectFile(projectDir: string, value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`project.json 缺少 ${label} 文件路径`);
  if (isAbsolute(value) || value.includes("\\") || value.split("/").some((part) => part === "..")) {
    fail(`${label} 路径必须是项目目录内的相对路径`);
  }
  const file = resolve(projectDir, value);
  const rel = relative(resolve(projectDir), file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) fail(`${label} 路径超出项目目录`);
  if (!existsSync(file) || !statSync(file).isFile()) fail(`${label} 文件不存在: ${value}`);
  const extension = extname(file).toLowerCase();
  if (!WALLPAPER_EXTENSIONS.includes(extension)) {
    fail(`${label} 不是支持的图片格式（支持 ${WALLPAPER_EXTENSIONS.map((ext) => ext.slice(1)).join("/")}）: ${value}`);
  }
  return file;
}

/** Import only a user-selected, local Wallpaper Engine image or preview. */
export function importWallpaper(projectDirectory: string, home: string, preview = false): WallpaperImportResult {
  if (!projectDirectory) fail("请指定 Wallpaper Engine 项目目录");
  const projectDir = resolve(projectDirectory);
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) fail(`项目目录不存在: ${projectDirectory}`);
  const manifestPath = join(projectDir, "project.json");
  if (!existsSync(manifestPath)) fail("项目目录中没有 project.json");
  let manifest: { type?: unknown; file?: unknown; preview?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch {
    fail("project.json 不是有效 JSON");
  }

  const type = typeof manifest.type === "string" ? manifest.type.toLowerCase() : "";
  let source: string;
  if (type === "image") {
    if (preview) fail("image 项目已有原图入口，不需要 --preview；请直接导入");
    source = projectFile(projectDir, manifest.file, "image");
  } else if (PREVIEW_TYPES.has(type)) {
    if (!preview) fail(`${type} 项目不是静态原图；如需导入其静态预览图，请显式使用 --preview`);
    source = projectFile(projectDir, manifest.preview, "preview");
  } else {
    fail(`不支持的项目类型 ${JSON.stringify(manifest.type)}；仅支持 type=image，或 scene/video/web 的 --preview`);
  }

  const destination = storeWallpaper(source, home, [basename(projectDir)]);
  const config = readConfig(home);
  config.wallpaper = withUnobscuredOverlay({ ...(config.wallpaper ?? {}), image: destination });
  writeConfigAtomic(home, config);
  return { source, destination, config };
}

export interface StoredWallpaper {
  fileName: string;
  displayName: string;
  bytes: number;
  inUse: boolean;
}

/** Absolute paths the config's wallpaper layers point at, mode variants included. Relative
 *  image paths resolve against the canvas home, the same way the look builder resolves them. */
function referencedWallpapers(config: CanvasConfig, home: string): Set<string> {
  const refs = new Set<string>();
  for (const spec of [config.wallpaper, config.wallpaper?.dark, config.wallpaper?.light])
    if (typeof spec?.image === "string") refs.add(resolve(home, spec.image));
  return refs;
}

/** Every image in the store, with whether the current config still points at it. */
export function listWallpapers(home: string): StoredWallpaper[] {
  const root = resolve(home, "imports", "wallpaper");
  const referenced = referencedWallpapers(readConfig(home), home);
  const out: StoredWallpaper[] = [];
  if (!existsSync(root)) return out;
  for (const fileName of readdirSync(root).sort()) {
    const path = join(root, fileName);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue; // deleted between readdir and stat
    }
    if (!stats.isFile() || !WALLPAPER_EXTENSIONS.includes(extname(fileName).toLowerCase())) continue;
    out.push({ fileName, displayName: wallpaperDisplayName(fileName), bytes: stats.size, inUse: referenced.has(resolve(path)) });
  }
  return out;
}

export interface WallpaperRemoveResult {
  removed: string[];
  missing: string[];
  clearedUse: boolean;
}

/** Delete stored wallpapers by stored file name (what `wallpaper list` prints). A wallpaper the
 *  config still points at — main image or a mode variant — loses that reference; other wallpaper
 *  settings survive, and re-importing the same image restores the same stored name. */
export function removeWallpapers(home: string, fileNames: string[]): WallpaperRemoveResult {
  const config = readConfig(home);
  const result: WallpaperRemoveResult = { removed: [], missing: [], clearedUse: false };
  for (const input of fileNames) {
    const fileName = basename(input);
    const path = storedWallpaperPath(home, fileName);
    if (!existsSync(path)) {
      result.missing.push(fileName);
      continue;
    }
    const target = resolve(path);
    const clearImage = (spec: WallpaperSpec | null | undefined): boolean => {
      if (typeof spec?.image !== "string" || resolve(home, spec.image) !== target) return false;
      delete spec.image;
      return true;
    };
    if (config.wallpaper) {
      let cleared = clearImage(config.wallpaper);
      for (const mode of ["dark", "light"] as const) {
        if (clearImage(config.wallpaper![mode])) {
          if (Object.keys(config.wallpaper![mode]!).length === 0) delete config.wallpaper![mode];
          cleared = true;
        }
      }
      result.clearedUse ||= cleared;
    }
    removeStoredWallpaper(home, fileName);
    result.removed.push(fileName);
  }
  if (result.clearedUse) writeConfigAtomic(home, config);
  return result;
}
