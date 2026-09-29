import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { readConfig, writeConfigAtomic, type CanvasConfig } from "../shared/look.ts";

/** Image formats Chromium renders from a CSS background url; a gif simply plays its animation there. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg", ".gif"]);
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
  if (!IMAGE_EXTENSIONS.has(extension)) {
    fail(`${label} 不是支持的图片格式（支持 png/jpg/jpeg/webp/avif/svg/gif）: ${value}`);
  }
  return file;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "wallpaper";
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

  const importDir = join(home, "imports", "wallpaper");
  mkdirSync(importDir, { recursive: true });
  // The content tag keeps a re-import with different bytes from silently overwriting the old file,
  // and an unchanged re-import from duplicating it.
  const tag = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 12);
  const extension = extname(source).toLowerCase();
  const destination = join(importDir, `${safeName(basename(projectDir))}-${safeName(basename(source, extension))}-${tag}${extension}`);
  if (!existsSync(destination)) copyFileSync(source, destination);

  const config = readConfig(home);
  config.wallpaper = { ...(config.wallpaper ?? {}), image: destination };
  // New imports use brightness alone; a deliberate legacy overlay remains intact.
  if (config.wallpaper.dim === undefined && config.wallpaper.dark?.dim === undefined && config.wallpaper.light?.dim === undefined)
    config.wallpaper.dim = 0;
  writeConfigAtomic(home, config);
  return { source, destination, config };
}
