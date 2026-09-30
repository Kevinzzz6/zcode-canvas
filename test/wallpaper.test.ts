import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { readConfig } from "../src/shared/look.ts";
import { importWallpaper } from "../src/cli/wallpaper.ts";

test("imports image projects and preserves existing config", () => {
  const root = mkdtempSync(join(tmpdir(), "we-import-"));
  const project = join(root, "project");
  const home = join(root, "home");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "project.json"), JSON.stringify({ type: "image", file: "main.png" }));
  writeFileSync(join(project, "main.png"), "png");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ theme: "aurora", glass: { opacity: 0.5 } }));
  const result = importWallpaper(project, home);
  assert.equal(result.config.theme, "aurora");
  assert.equal(result.config.glass?.opacity, 0.5);
  assert.equal(result.config.wallpaper?.image, result.destination);
  assert.equal(result.config.wallpaper?.dim, 0, "new imports do not silently add an overlay");
  assert.equal(readFileSync(result.destination, "utf8"), "png");
  // The config on disk already reflects the import, written atomically.
  assert.equal(readConfig(home).wallpaper?.image, result.destination);
  // Content-tagged: re-importing changed bytes stores a second file instead of overwriting.
  writeFileSync(join(project, "main.png"), "png-2");
  const second = importWallpaper(project, home);
  assert.notEqual(second.destination, result.destination);
  assert.equal(readFileSync(result.destination, "utf8"), "png");
  assert.equal(readConfig(home).wallpaper?.image, second.destination);
  assert.equal(readdirSync(join(home, "imports", "wallpaper")).length, 2);
});

test("import preserves an explicitly configured legacy overlay", () => {
  const root = mkdtempSync(join(tmpdir(), "we-overlay-"));
  const project = join(root, "project");
  const home = join(root, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(project, "project.json"), JSON.stringify({ type: "image", file: "main.png" }));
  writeFileSync(join(project, "main.png"), "png");
  writeFileSync(join(home, "config.json"), JSON.stringify({ wallpaper: { dark: { dim: .4 } } }));
  const config = importWallpaper(project, home).config;
  assert.equal(config.wallpaper?.dim, undefined);
  assert.equal(config.wallpaper?.dark?.dim, .4);
});

test("requires explicit preview for scene/video/web; accepts gif, rejects non-image formats", () => {
  const root = mkdtempSync(join(tmpdir(), "we-preview-"));
  const project = join(root, "scene");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "project.json"), JSON.stringify({ type: "scene", preview: "preview.jpg" }));
  writeFileSync(join(project, "preview.jpg"), "jpg");
  assert.throws(() => importWallpaper(project, join(root, "home")), /--preview/);
  const result = importWallpaper(project, join(root, "home"), true);
  assert.match(result.destination, /-preview-[0-9a-f]{12}\.jpg$/);
  // An image project's own gif entry imports directly; its animation plays in the CSS background.
  writeFileSync(join(project, "project.json"), JSON.stringify({ type: "image", file: "anim.gif" }));
  writeFileSync(join(project, "anim.gif"), "gif");
  assert.match(importWallpaper(project, join(root, "home")).destination, /anim-[0-9a-f]{12}\.gif$/);
  writeFileSync(join(project, "project.json"), JSON.stringify({ type: "image", file: "clip.mp4" }));
  writeFileSync(join(project, "clip.mp4"), "mp4");
  assert.throws(() => importWallpaper(project, join(root, "home")), /图片格式/);
});

test("rejects traversal and unsupported project types", () => {
  const root = mkdtempSync(join(tmpdir(), "we-safe-"));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "project.json"), JSON.stringify({ type: "video", preview: "../outside.png" }));
  assert.throws(() => importWallpaper(project, join(root, "home"), true), /项目目录内/);
  writeFileSync(join(project, "project.json"), JSON.stringify({ type: "web", preview: "x.png" }));
  writeFileSync(join(project, "x.png"), "x");
  assert.doesNotThrow(() => importWallpaper(project, join(root, "home"), true));
});

const tag = (content: string) => createHash("sha256").update(content).digest("hex").slice(0, 12);

function makeProject(root: string, dirName: string, file: string, content: string): string {
  const project = join(root, dirName);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "project.json"), JSON.stringify({ type: "image", file }));
  writeFileSync(join(project, file), content);
  return project;
}

test("stored names always pass the store's flat-name check, like panel imports", () => {
  const root = mkdtempSync(join(tmpdir(), "we-names-"));
  const home = join(root, "home");
  // A leading dot or underscore, or "..", used to produce a name the store itself would refuse.
  assert.equal(basename(importWallpaper(makeProject(root, ".hidden", "main.png", "a"), home).destination), `hidden-main-${tag("a")}.png`);
  assert.equal(basename(importWallpaper(makeProject(root, "_x..y", "main.png", "b"), home).destination), `x.y-main-${tag("b")}.png`);
  // The extension is stripped by its original spelling, as the panel does.
  assert.equal(basename(importWallpaper(makeProject(root, "caps", "MAIN.PNG", "c"), home).destination), `caps-MAIN-${tag("c")}.png`);
  assert.equal(basename(importWallpaper(makeProject(root, "壁纸", "图.png", "d"), home).destination), `wallpaper-wallpaper-${tag("d")}.png`);
});

test("a symlink planted at the CLI destination is refused, not written through", (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "we-symlink-"));
  const home = join(root, "home");
  const project = makeProject(root, "project", "main.png", "x");
  mkdirSync(join(home, "imports", "wallpaper"), { recursive: true });
  writeFileSync(join(root, "secret.txt"), "config data");
  try {
    symlinkSync(join(root, "secret.txt"), join(home, "imports", "wallpaper", `project-main-${tag("x")}.png`));
  } catch (error) {
    return t.skip(`symlinks need privileges here: ${String(error)}`);
  }
  assert.throws(() => importWallpaper(project, home), { message: /escapes the store/ });
  assert.equal(readFileSync(join(root, "secret.txt"), "utf8"), "config data");
});
