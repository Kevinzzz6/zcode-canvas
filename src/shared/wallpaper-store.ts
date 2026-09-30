// Canvas's own wallpaper store (`<home>/imports/wallpaper`). The appearance panel and the CLI's
// Wallpaper Engine import both write into it through here, so naming, path safety and the
// new-import overlay policy cannot drift apart.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, resolve, sep } from "node:path";
import type { WallpaperLayer } from "./look.ts";

/** Image formats Chromium renders from a CSS background url; a gif plays its animation there.
 *  Anything executable stays out of scope. */
export const WALLPAPER_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg", ".gif"];

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

/** One name segment reduced to what storedWallpaperPath accepts: starts alphanumeric, no "..". */
function safeSegment(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/^[^A-Za-z0-9]+|-+$/g, "") || "wallpaper"
  );
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

/**
 * Copy an already validated image into the store as `<prefix>-<file stem>-<content tag><ext>` and
 * return the stored path. The tag is part of the name, so a file already sitting there has the same
 * bytes and the copy is skipped. Throws on a symlink planted at the destination.
 */
export function storeWallpaper(source: string, home: string, prefix: readonly string[] = []): string {
  const extension = extname(source).toLowerCase();
  mkdirSync(resolve(home, "imports", "wallpaper"), { recursive: true });
  // Strip the extension by its original spelling, so PIC.PNG becomes "PIC-….png", not "PIC.PNG-….png".
  const stem = [...prefix, basename(source, extname(source))].map(safeSegment).join("-");
  const destination = storedWallpaperPath(home, `${stem}-${contentTag(source)}${extension}`);
  if (!existsSync(destination)) copyFileSync(source, destination);
  return destination;
}

/** New imports use brightness alone; a deliberately configured legacy overlay stays intact. */
export function withUnobscuredOverlay(wallpaper: WallpaperLayer): WallpaperLayer {
  if (wallpaper.dim !== undefined || wallpaper.dark?.dim !== undefined || wallpaper.light?.dim !== undefined) return wallpaper;
  return { ...wallpaper, dim: 0 };
}
