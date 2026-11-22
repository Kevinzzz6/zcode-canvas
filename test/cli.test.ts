import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeStoredWallpaper, storeWallpaper } from "../src/shared/wallpaper-store.ts";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function run(home: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { env: { ...process.env, ZCODE_CANVAS_HOME: home }, encoding: "utf8" });
}

test("the CLI sets and clears the pet's desktop mode with the same checks as the panel", () => {
  const home = mkdtempSync(join(tmpdir(), "zc-cli-pet-"));
  const config = () => JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { pet?: Record<string, unknown> };
  assert.equal(run(home, "set", "pet.desktop", "true").status, 0);
  assert.equal(config().pet?.desktop, true);
  const bad = run(home, "set", "pet.desktop", "yes");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /pet\.desktop 的值 "yes" 无效/);
  assert.equal(config().pet?.desktop, true, "a rejected value leaves the config alone");
  assert.equal(run(home, "unset", "pet.desktop").status, 0);
  assert.equal("desktop" in (config().pet ?? {}), false);
});

test("wallpaper list marks the in-use import, and remove deletes the file and clears the reference", () => {
  const home = mkdtempSync(join(tmpdir(), "zc-cli-wallpaper-"));
  const source = join(home, "pic.png");
  writeFileSync(source, "not really a png, bytes are bytes to the store");
  const stored = storeWallpaper(source, home);
  const other = (() => {
    const file = join(home, "other.jpg");
    writeFileSync(file, "other bytes");
    return storeWallpaper(file, home);
  })();

  assert.equal(run(home, "set", "wallpaper.image", stored).status, 0);
  assert.equal(run(home, "set", "wallpaper.blur", "3").status, 0);
  const list = run(home, "wallpaper", "list");
  assert.equal(list.status, 0);
  assert.match(list.stdout, new RegExp(basename(stored).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(list.stdout, /当前使用/);
  assert.doesNotMatch(list.stdout, new RegExp(`${basename(other)}[^\\n]*当前使用`));

  const remove = run(home, "wallpaper", "remove", basename(stored));
  assert.equal(remove.status, 0);
  assert.equal(existsSync(stored), false, "the stored file is gone");
  assert.equal(existsSync(other), true, "other wallpapers survive");
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { wallpaper?: { image?: string; blur?: number } };
  assert.equal(config.wallpaper?.image, undefined, "the selection is cleared with the file");
  assert.equal(config.wallpaper?.blur, 3, "unrelated wallpaper settings survive");

  const missing = run(home, "wallpaper", "remove", basename(stored));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /壁纸库里没有/);
});

test("removeStoredWallpaper refuses names that would escape the store", () => {
  const home = mkdtempSync(join(tmpdir(), "zc-wallpaper-store-"));
  const source = join(home, "pic.png");
  writeFileSync(source, "bytes");
  const stored = storeWallpaper(source, home);
  assert.equal(removeStoredWallpaper(home, basename(stored)), true);
  assert.equal(removeStoredWallpaper(home, basename(stored)), false, "already gone");
  assert.throws(() => removeStoredWallpaper(home, "../pic.png"));
});
