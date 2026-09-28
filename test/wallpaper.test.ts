import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
  assert.equal(readFileSync(result.destination, "utf8"), "png");
});

test("requires explicit preview for scene/video/web and rejects animation formats", () => {
  const root = mkdtempSync(join(tmpdir(), "we-preview-"));
  const project = join(root, "scene");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "project.json"), JSON.stringify({ type: "scene", preview: "preview.jpg" }));
  writeFileSync(join(project, "preview.jpg"), "jpg");
  assert.throws(() => importWallpaper(project, join(root, "home")), /--preview/);
  const result = importWallpaper(project, join(root, "home"), true);
  assert.match(result.destination, /preview\.jpg$/);
  writeFileSync(join(project, "project.json"), JSON.stringify({ type: "image", file: "anim.gif" }));
  writeFileSync(join(project, "anim.gif"), "gif");
  assert.throws(() => importWallpaper(project, join(root, "home")), /静态图片格式/);
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
