import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadLook, readConfig, writeConfigAtomic, type CanvasConfig } from "../src/shared/look.ts";
import { CHANNEL_PANEL_APPLY, CHANNEL_PANEL_GET, CHANNEL_PANEL_PICK_WALLPAPER, CHANNEL_PANEL_PREVIEW, CHANNEL_PANEL_SAVE_THEME, CHANNEL_PANEL_SELECT_WALLPAPER } from "../src/shared/protocol.ts";
import {
  applyPanelInput,
  importWallpaperFile,
  listStoredWallpapers,
  readPanelData,
  registerPanelHandlers,
  type PanelIpc,
} from "../src/runtime/panel.ts";
import { storedWallpaperPath, wallpaperDisplayName } from "../src/shared/wallpaper-store.ts";

/** The content tag importWallpaperFile puts into stored wallpaper names. */
const tag = (data: string): string => createHash("sha256").update(data).digest("hex").slice(0, 12);

/** A fake canvas home with one built-in theme (wallpapered) and one user theme. */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zc-panel-"));
  mkdirSync(join(home, "runtime", "themes", "builtinwp"), { recursive: true });
  writeFileSync(
    join(home, "runtime", "themes", "builtinwp", "theme.json"),
    JSON.stringify({ name: "Builtin WP", wallpaper: { image: "bg.png" } }),
  );
  mkdirSync(join(home, "themes", "mine"), { recursive: true });
  writeFileSync(join(home, "themes", "mine", "theme.json"), JSON.stringify({ name: "Mine", accent: "#123456" }));
  return home;
}

function withWallpaperOverride(home: string): void {
  writeConfigAtomic(home, { theme: "mine", wallpaper: { image: join(home, "imports", "wallpaper", "pic.jpg") } });
}

test("readPanelData lists built-in and user themes and reports the current wallpaper", () => {
  const home = makeHome();
  withWallpaperOverride(home);
  const data = readPanelData(home);
  assert.deepEqual(
    data.themes,
    [
      { id: "builtinwp", name: "Builtin WP", builtin: true, swatch: { background: "#202534", accent: "#8b7cf5" } },
      { id: "mine", name: "Mine", builtin: false, swatch: { background: "#202534", accent: "#123456" } },
    ],
  );
  assert.equal(data.config.theme, "mine");
  assert.equal(data.wallpaper.file, "pic.jpg");
  assert.equal(data.wallpaper.id, null); // a deleted image is not offered as a selectable library entry
  assert.equal(data.wallpaper.fromTheme, false);

  // Without an override, the active theme's own wallpaper is what shows.
  writeConfigAtomic(home, { theme: "builtinwp" });
  const themed = readPanelData(home);
  assert.equal(themed.wallpaper.file, null);
  assert.equal(themed.wallpaper.fromTheme, true);
  writeConfigAtomic(home, {});
  assert.equal(readPanelData(home).wallpaper.fromTheme, false);
});

test("the library lists only usable stored images and marks GIFs as animated", (t: TestContext) => {
  const home = makeHome();
  const store = join(home, "imports", "wallpaper");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "still.png"), "png");
  writeFileSync(join(store, "loop.gif"), "gif");
  writeFileSync(join(store, "skip.exe"), "exe");
  mkdirSync(join(store, "folder.jpg"));
  writeFileSync(join(home, "outside.png"), "outside");
  try {
    symlinkSync(join(home, "outside.png"), join(store, "escape.png"));
  } catch (error) {
    t.diagnostic(`symlink check unavailable: ${String(error)}`);
  }
  const files = listStoredWallpapers(home);
  assert.deepEqual(files.map(({ id, animated }) => ({ id, animated })), [
    { id: "loop.gif", animated: true },
    { id: "still.png", animated: false },
  ]);
  assert.equal(files[0]?.url, pathToFileURL(join(store, "loop.gif")).href);
});

test("swatches reject unsafe CSS and effective values inherit theme tuning", () => {
  const home = makeHome();
  writeFileSync(join(home, "runtime", "themes", "builtinwp", "theme.json"), JSON.stringify({
    name: "Builtin WP",
    colors: { dark: { background: "url(file:///secret)", primary: "#31a6bb" } },
    accent: "url(file:///secret)",
    wallpaper: { image: "bg.png", blur: 13, dim: 0.42, scale: 1.4 },
  }));
  writeConfigAtomic(home, { theme: "builtinwp", wallpaper: { dim: 0.55 } });
  const data = readPanelData(home);
  assert.deepEqual(data.themes[0]?.swatch, { background: "#202534", accent: "#31a6bb" });
  assert.equal(data.effective.wallpaper.dark?.blur, 13);
  assert.equal(data.effective.wallpaper.dark?.dim, 0.55);
  assert.equal(data.effective.wallpaper.dark?.scale, 1.4);
  assert.equal(data.config.wallpaper?.blur, undefined);
});

test("pet settings merge field by field, are validated, and are not part of the look", () => {
  const home = makeHome();
  const before: CanvasConfig = { theme: "mine", accent: "#7c5cff", pet: { enabled: true, scale: 2 } };
  const after = applyPanelInput(before, { pet: { volume: 0, sound: "fx1" } }, home);
  assert.deepEqual(after.pet, { enabled: true, scale: 2, volume: 0, sound: "fx1" });
  assert.equal(after.accent, "#7c5cff");
  assert.throws(() => applyPanelInput(before, { pet: { image: "C:/evil.png" } }, home), /invalid pet image/);
  assert.throws(() => applyPanelInput(before, { pet: { scale: 10 } }, home), /invalid pet scale/);
  assert.deepEqual(applyPanelInput(before, { discard: true }, home), { theme: "mine", pet: { enabled: true, scale: 2 } }, "discarding the look keeps the pet");
  writeConfigAtomic(home, before);
  assert.equal(readPanelData(home).unsaved, true, "the accent is unsaved, the pet alone would not be");
  writeConfigAtomic(home, { theme: "mine", pet: { enabled: true } });
  assert.equal(readPanelData(home).unsaved, false);
});

test("picking a theme only changes config.theme and never clears the wallpaper override", () => {
  const home = makeHome();
  const before: CanvasConfig = { theme: "mine", wallpaper: { image: "/w/pic.jpg", dim: 0.4 }, accent: "#7c5cff" };
  const after = applyPanelInput(before, { theme: "builtinwp" }, home);
  assert.equal(after.theme, "builtinwp");
  assert.equal(after.wallpaper?.image, "/w/pic.jpg");
  assert.equal(after.wallpaper?.dim, 0.4);
  assert.equal(after.accent, "#7c5cff");
});

test("relative wallpaper paths resolve against Canvas home for the selected library tile", () => {
  const home = makeHome();
  mkdirSync(join(home, "imports", "wallpaper"), { recursive: true });
  writeFileSync(join(home, "imports", "wallpaper", "relative.png"), "png");
  writeConfigAtomic(home, { wallpaper: { image: "imports/wallpaper/relative.png" } });
  assert.equal(readPanelData(home).wallpaper.id, "relative.png");
});

test("clearing the theme keeps the user's own wallpaper", () => {
  const home = makeHome();
  const before: CanvasConfig = { theme: "mine", wallpaper: { image: "/w/pic.jpg" } };
  const after = applyPanelInput(before, { theme: null }, home);
  assert.equal(after.theme, null);
  assert.equal(after.wallpaper?.image, "/w/pic.jpg");
});

test("clearing the wallpaper lets the theme's wallpaper show again, theme untouched", () => {
  const home = makeHome();
  const before: CanvasConfig = { theme: "mine", wallpaper: { image: "/w/pic.jpg", blur: 8 } };
  const after = applyPanelInput(before, { wallpaper: null }, home);
  assert.equal(after.theme, "mine");
  assert.equal(after.wallpaper, undefined); // the override is gone, not an explicit `null`
  // The flow from the bug report: clear, then switch to a wallpapered theme — its wallpaper must
  // actually resolve, not stay blank until some knob is nudged.
  const switched = applyPanelInput(after, { theme: "builtinwp" }, home);
  writeConfigAtomic(home, switched);
  const { look } = loadLook(home);
  assert.equal(look?.wallpaper.dark?.image, join(home, "runtime", "themes", "builtinwp", "bg.png"));
  assert.equal(look?.wallpaper.light?.image, join(home, "runtime", "themes", "builtinwp", "bg.png"));
  assert.equal(look?.wallpaper.dark?.blur, 0); // the old tuning died with the override
  assert.equal(readPanelData(home).wallpaper.fromTheme, true);
});

test("fit / blur / dim update in place and keep wallpaper.image", () => {
  const home = makeHome();
  const before: CanvasConfig = { theme: "mine", wallpaper: { image: "/w/pic.jpg", fit: "cover" } };
  const after = applyPanelInput(
    before,
    { fit: "contain", blur: 12, dim: 0.6, scale: 1.5, saturate: 0.5, brightness: 1.2, contrast: 0.9, grayscale: 1 },
    home,
  );
  assert.equal(after.wallpaper?.image, "/w/pic.jpg");
  assert.equal(after.wallpaper?.fit, "contain");
  assert.equal(after.wallpaper?.blur, 12);
  assert.equal(after.wallpaper?.dim, 0.6);
  assert.equal(after.wallpaper?.scale, 1.5);
  assert.equal(after.wallpaper?.saturate, 0.5);
  assert.equal(after.wallpaper?.brightness, 1.2);
  assert.equal(after.wallpaper?.contrast, 0.9);
  assert.equal(after.wallpaper?.grayscale, 1);
  for (
    const bad of [
      { fit: "stretch" },
      { blur: -1 },
      { blur: 201 },
      { blur: "lots" },
      { dim: 1.5 },
      { dim: -0.1 },
      { scale: 0.05 },
      { scale: 5 },
      { saturate: -1 },
      { brightness: 3 },
      { contrast: 9 },
      { grayscale: 2 },
    ] as const
  ) {
    assert.throws(() => applyPanelInput(before, bad, home), Error, JSON.stringify(bad));
  }
});

test("personal controls are shared across themes and defaults omit personal overrides", () => {
  const home = makeHome();
  const base: CanvasConfig = { theme: "mine", wallpaper: { image: "/w/pic.jpg", blur: 3 } };
  const own = applyPanelInput(base, { glassOpacity: 0.52, glassBlur: 24, material: "mica", accent: "#A1b2C3", radius: 2, positionX: 20, positionY: 65 }, home);
  assert.deepEqual(own.glass, { opacity: 0.52, blur: 24, material: "mica" });
  assert.equal(own.accent, "#A1b2C3");
  assert.equal(own.radius, 2);
  assert.equal(own.wallpaper?.position, "20% 65%");
  const switched = applyPanelInput(own, { theme: "builtinwp" }, home);
  assert.equal(switched.accent, own.accent);
  assert.deepEqual(switched.glass, own.glass);
  writeConfigAtomic(home, switched);
  const data = readPanelData(home);
  assert.equal(data.effective.glass.opacity, 0.52);
  assert.equal(data.defaults.glass.opacity, 1);
  assert.equal(data.effective.radius, 2);
  assert.equal(data.defaults.radius, null);
  assert.deepEqual(data.overrides, { theme: true, wallpaper: true });
  assert.equal(data.platform, process.platform);
});

test("reset removes only controlled tuning and preserves images, theme and unrelated config", () => {
  const home = makeHome();
  const before: CanvasConfig = {
    theme: "mine", enabled: false, accent: "#123456", radius: 3, glass: { opacity: 0.5 },
    startup: { animation: "fade" },
    wallpaper: { image: "/w/pic.jpg", dim: 0.6, blur: 10, dark: { image: "/w/dark.jpg", dim: 0.9, fit: "tile" }, light: null },
  };
  const themeReset = applyPanelInput(before, { reset: "theme" }, home);
  assert.equal(themeReset.accent, undefined);
  assert.equal(themeReset.radius, undefined);
  assert.equal(themeReset.glass, undefined);
  assert.deepEqual(themeReset.wallpaper, before.wallpaper);
  const wallpaperReset = applyPanelInput(before, { reset: "wallpaper" }, home);
  assert.deepEqual(wallpaperReset.wallpaper, { image: "/w/pic.jpg", dark: { image: "/w/dark.jpg" }, light: null });
  assert.equal(wallpaperReset.theme, "mine");
  assert.deepEqual(wallpaperReset.startup, { animation: "fade" });
  assert.equal(wallpaperReset.enabled, false);
  assert.deepEqual(before.wallpaper?.dark, { image: "/w/dark.jpg", dim: 0.9, fit: "tile" });
  writeConfigAtomic(home, wallpaperReset);
  assert.equal(readPanelData(home).overrides.wallpaper, false, "selected image alone is not a tuning badge");
});

test("unset removes one personal override so the theme's value applies again", () => {
  const home = makeHome();
  mkdirSync(join(home, "themes", "framed"), { recursive: true });
  writeFileSync(join(home, "themes", "framed", "theme.json"), JSON.stringify({ name: "Framed", wallpaper: { image: "bg.png", position: "30% 70%", blur: 12 } }));
  const before: CanvasConfig = {
    theme: "framed", radius: 2, glass: { opacity: 0.4, blur: 20 },
    wallpaper: { image: "/w/pic.jpg", blur: 4, brightness: 0.8, position: "10% 90%", dark: { image: "/w/dark.jpg", blur: 8 } },
  };
  const one = applyPanelInput(before, { unset: ["blur"] }, home);
  assert.deepEqual(one.wallpaper, { image: "/w/pic.jpg", brightness: 0.8, position: "10% 90%", dark: { image: "/w/dark.jpg" } });
  assert.deepEqual(one.glass, before.glass);
  writeConfigAtomic(home, one);
  assert.equal(readPanelData(home).effective.wallpaper.light?.blur, 12, "the theme's blur shows again");

  const axis = applyPanelInput(before, { unset: ["positionX"] }, home);
  assert.equal(axis.wallpaper?.position, "30% 90%", "only the unset axis falls back to the theme");
  const both = applyPanelInput(axis, { unset: ["positionY"] }, home);
  assert.equal(both.wallpaper && "position" in both.wallpaper, false, "no override is left once both axes follow the theme");

  const glass = applyPanelInput(applyPanelInput(before, { unset: ["glassOpacity"] }, home), { unset: ["glassBlur", "radius"] }, home);
  assert.equal(glass.glass, undefined, "an emptied glass override disappears");
  assert.equal(glass.radius, undefined);
  assert.deepEqual(applyPanelInput({ theme: null }, { unset: ["blur", "glassOpacity"] }, home), { theme: null });

  for (const unset of [[], ["image"], ["theme"], "blur", [1]]) assert.throws(() => applyPanelInput(before, { unset }, home), /invalid unset/, JSON.stringify(unset));
  assert.equal(before.wallpaper?.dark?.blur, 8, "the original config is never mutated");
});

test("a Smart Palette request is validated, replaces the personal accent and can be cleared", () => {
  const home = makeHome();
  const before: CanvasConfig = { theme: "mine", accent: "#123456", wallpaper: { image: "/w/pic.jpg" } };
  const after = applyPanelInput(before, { palette: { seed: "#5EEAD4", variant: "vivid", backdrop: "#101820" } }, home);
  assert.deepEqual(after.palette, { seed: "#5eead4", variant: "vivid", backdrop: "#101820" });
  assert.equal(after.accent, undefined, "the palette's own primary colors take over");
  assert.equal(after.wallpaper?.image, "/w/pic.jpg");
  assert.equal(before.accent, "#123456", "the original config is never mutated");
  assert.equal(applyPanelInput(after, { palette: null }, home).palette, undefined, "clearing removes the override");
  assert.equal(applyPanelInput(after, { reset: "theme" }, home).palette, undefined, "恢复主题默认 removes it too");
  for (const palette of [
    "#5eead4", { seed: "red", variant: "natural" }, { seed: "#5eead4" }, { seed: "#5eead4", variant: "neon" },
    { seed: "#5eead4", variant: "soft", backdrop: "url(x)" }, { seed: "#5eead4", variant: "soft", colors: {} }, [],
  ]) assert.throws(() => applyPanelInput(before, { palette }, home), /invalid palette/, JSON.stringify(palette));
  writeConfigAtomic(home, after);
  const data = readPanelData(home);
  assert.equal(data.overrides.theme, true);
  assert.equal(data.effective.palette?.variant, "vivid");
});

test("region controls write glass.regions, unset one field at a time and report what they follow", () => {
  const home = makeHome();
  writeFileSync(join(home, "themes", "mine", "theme.json"), JSON.stringify({ name: "Mine", glass: { opacity: 0.7, regions: { card: { opacity: 0.9 } } } }));
  const before: CanvasConfig = { theme: "mine", glass: { opacity: 0.5, blur: 10 } };
  const tuned = applyPanelInput(before, { frameOpacity: 0.3, mainOpacity: 0.6, mainBlur: 24, inputBlur: 0 }, home);
  assert.deepEqual(tuned.glass, { opacity: 0.5, blur: 10, regions: { frame: { opacity: 0.3 }, main: { opacity: 0.6, blur: 24 }, input: { blur: 0 } } });
  assert.deepEqual(before.glass, { opacity: 0.5, blur: 10 });
  const mainBlurOnly = applyPanelInput(tuned, { unset: ["mainOpacity", "frameOpacity"] }, home);
  assert.deepEqual(mainBlurOnly.glass?.regions, { main: { blur: 24 }, input: { blur: 0 } });
  const none = applyPanelInput(mainBlurOnly, { unset: ["mainBlur", "inputBlur"] }, home);
  assert.deepEqual(none.glass, { opacity: 0.5, blur: 10 }, "no empty regions are left behind");
  for (const bad of [{ mainOpacity: 1.2 }, { cardBlur: 101 }, { frameBlur: 4 }, { mainOpacity: "0.5" }])
    assert.throws(() => applyPanelInput(before, bad, home), Error, JSON.stringify(bad));

  writeConfigAtomic(home, tuned);
  const data = readPanelData(home);
  assert.equal(data.effective.glass.regions.main.opacity, 0.6);
  assert.deepEqual(data.regionDefaults.main, { opacity: 0.5, blur: 10 }, "without its override main follows the personal global glass");
  assert.equal(data.regionDefaults.card.opacity, 0.9, "the theme's own region value is the card default");
  assert.deepEqual(data.regionFollows.main, { opacity: false, blur: false });
  assert.deepEqual(data.regionFollows.card, { opacity: false, blur: true });
  assert.deepEqual(data.regionFollows.input, { opacity: true, blur: false });
});

test("preview renders a palette without writing it", async () => {
  const home = makeHome();
  writeConfigAtomic(home, { theme: "mine" });
  const before = readFileSync(join(home, "config.json"), "utf8");
  const { listeners, reloads } = harness(home, async () => null);
  const preview = await listeners.get(CHANNEL_PANEL_PREVIEW)!(undefined, { palette: { seed: "#ff4d6d", variant: "oled" } }) as { css: string };
  assert.match(preview.css, /html:root\.dark \{[^}]*--color-background: #000000/);
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), before);
  assert.equal(reloads.length, 0);
});

test("readPanelData exposes the painted image as a file URL per mode", () => {
  const home = makeHome();
  writeConfigAtomic(home, { theme: "builtinwp" });
  const data = readPanelData(home);
  assert.equal(data.imageUrl.dark, pathToFileURL(join(home, "runtime", "themes", "builtinwp", "bg.png")).href);
  assert.equal(data.imageUrl.light, data.imageUrl.dark);
  writeConfigAtomic(home, { theme: null });
  assert.deepEqual(readPanelData(home).imageUrl, { dark: null, light: null });
});

test("global wallpaper changes clear mode shadows without mutating the original config", () => {
  const home = makeHome();
  const before: CanvasConfig = { wallpaper: { image: "/w/shared.jpg", dark: { image: "/w/dark.jpg", blur: 31, fit: "tile", dim: 0.8, position: "top right" }, light: null } };
  const after = applyPanelInput(before, { fit: "contain", blur: 6, positionY: 40, clearOverlay: true }, home);
  assert.deepEqual(after.wallpaper?.dark, { image: "/w/dark.jpg" });
  assert.equal(after.wallpaper?.light, null);
  assert.equal(after.wallpaper?.position, "100% 40%");
  assert.equal(after.wallpaper?.dim, 0);
  assert.deepEqual(before.wallpaper?.dark, { image: "/w/dark.jpg", blur: 31, fit: "tile", dim: 0.8, position: "top right" });
  assert.throws(() => applyPanelInput(before, { fit: "contain", blur: 999 }, home), /invalid wallpaper blur/);
  assert.equal(before.wallpaper?.dark?.fit, "tile", "failed validation must leave the original untouched");
});

test("invalid personal controls and unknown request keys are refused", () => {
  const home = makeHome();
  const base: CanvasConfig = { theme: "mine" };
  const invalid = [
    { glassOpacity: -0.1 }, { glassOpacity: 1.1 }, { glassOpacity: "0.5" }, { glassBlur: 101 },
    { material: "glass" }, { accent: "red" }, { accent: "#abcd" }, { radius: 5 },
    { positionX: -1 }, { positionY: 101 }, { reset: "all" }, { clearOverlay: false },
    { image: "C:/private/file.png" },
  ];
  for (const value of invalid) assert.throws(() => applyPanelInput(base, value, home), Error, JSON.stringify(value));
  assert.deepEqual(base, { theme: "mine" });
});

test("unknown themes and renderer-supplied wallpaper paths are rejected", () => {
  const home = makeHome();
  const config: CanvasConfig = { theme: null };
  assert.throws(() => applyPanelInput(config, { theme: "nope" }, home), /unknown theme/);
  assert.throws(() => applyPanelInput(config, { theme: 42 }, home), /unknown theme/);
  // The panel renderer never gets to name a file: only the native dialog (main process) does.
  assert.throws(() => applyPanelInput(config, { wallpaper: "/etc/passwd" }, home), /file dialog/);
  assert.throws(() => applyPanelInput(config, "nonsense" as unknown as Record<string, unknown>, home), /invalid panel request/);
});

test("importWallpaperFile stores images under content-tagged names", () => {
  const home = makeHome();
  const source = join(home, "picker", "My Wallpaper.png");
  mkdirSync(join(home, "picker"), { recursive: true });
  writeFileSync(source, "png-data");
  const destination = importWallpaperFile(source, home);
  assert.equal(destination, join(home, "imports", "wallpaper", `My-Wallpaper-${tag("png-data")}.png`));
  assert.equal(readFileSync(destination, "utf8"), "png-data");
  // Re-picking the same content reuses the stored file.
  assert.equal(importWallpaperFile(source, home), destination);
  // Different content under the same name never overwrites what is already stored.
  writeFileSync(source, "png-data-2");
  const second = importWallpaperFile(source, home);
  assert.notEqual(second, destination);
  assert.equal(readFileSync(destination, "utf8"), "png-data");
  assert.equal(readFileSync(second, "utf8"), "png-data-2");
  assert.deepEqual(readdirSync(join(home, "imports", "wallpaper")).sort(), [basename(destination), basename(second)].sort());
  // A name with no safe characters left falls back to a fixed one.
  writeFileSync(join(home, "picker", "壁纸.png"), "x");
  assert.equal(basename(importWallpaperFile(join(home, "picker", "壁纸.png"), home)), `wallpaper-${tag("x")}.png`);
});

test("wallpaperDisplayName hides the content tag, old names pass through", () => {
  assert.equal(wallpaperDisplayName(`pic-${tag("z")}.jpg`), "pic.jpg");
  assert.equal(wallpaperDisplayName("old-style.jpg"), "old-style.jpg");
  assert.equal(wallpaperDisplayName("no-extension"), "no-extension");
});

test("importWallpaperFile rejects non-image formats", () => {
  const home = makeHome();
  mkdirSync(join(home, "picker"), { recursive: true });
  for (const name of ["a.txt", "b.exe", "c.mp4", "d.pkg", "e.scene", "f.webm", "noext"]) {
    writeFileSync(join(home, "picker", name), "x");
    assert.throws(() => importWallpaperFile(join(home, "picker", name), home), { message: /不支持的壁纸格式/ }, name);
  }
  writeFileSync(join(home, "picker", "UPPER.PNG"), "x");
  assert.ok(importWallpaperFile(join(home, "picker", "UPPER.PNG"), home).endsWith(`UPPER-${tag("x")}.png`));
  // A picked gif is stored like any other image; Chromium plays its animation in the background.
  writeFileSync(join(home, "picker", "loop.gif"), "gif");
  assert.ok(importWallpaperFile(join(home, "picker", "loop.gif"), home).endsWith(`loop-${tag("gif")}.gif`));
  assert.throws(() => importWallpaperFile(join(home, "picker", "missing.png"), home), /不可用/);
});

test("storedWallpaperPath rejects traversal and anything but a flat whitelisted name", () => {
  const home = makeHome();
  for (const name of ["../config.json", "..\\config.json", "a/b.png", "a\\b.png", "..", "...", ".hidden.png", "a..b.png", "", "x y.png"]) {
    assert.throws(() => storedWallpaperPath(home, name), { message: /invalid wallpaper file name/ }, JSON.stringify(name));
  }
  assert.equal(storedWallpaperPath(home, "ok.png"), join(home, "imports", "wallpaper", "ok.png"));
});

test("a symlink inside the store pointing out of it is refused, not written through", (t: TestContext) => {
  const home = makeHome();
  mkdirSync(join(home, "imports", "wallpaper"), { recursive: true });
  writeFileSync(join(home, "secret.txt"), "config data");
  const source = join(home, "picker", "evil.png");
  mkdirSync(join(home, "picker"), { recursive: true });
  writeFileSync(source, "x");
  try {
    symlinkSync(join(home, "secret.txt"), join(home, "imports", "wallpaper", "evil.png"));
    // The name importWallpaperFile will actually compute for this content.
    symlinkSync(join(home, "secret.txt"), join(home, "imports", "wallpaper", `evil-${tag("x")}.png`));
  } catch (error) {
    return t.skip(`symlinks need privileges here: ${String(error)}`);
  }
  assert.throws(() => storedWallpaperPath(home, "evil.png"), { message: /escapes the store/ });
  // Importing a file whose stored (content-tagged) name collides with the symlink fails closed.
  assert.throws(() => importWallpaperFile(source, home), { message: /escapes the store/ });
  assert.equal(readFileSync(join(home, "secret.txt"), "utf8"), "config data");
});

test("writeConfigAtomic replaces the config fully and leaves no temp files behind", () => {
  const home = makeHome();
  writeConfigAtomic(home, { theme: "mine", accent: "#111111" });
  writeConfigAtomic(home, { theme: null, wallpaper: { image: "/w/pic.jpg" } });
  assert.deepEqual(
    readdirSync(home).filter((name) => name.startsWith("config.json")),
    ["config.json"],
  );
  assert.deepEqual(readConfig(home), { enabled: true, theme: null, wallpaper: { image: "/w/pic.jpg" } });
});

/** Registers the handlers on a stub ipc and returns the captured listeners. */
function harness(
  home: string,
  pickWallpaperFile: () => Promise<string | null>,
  isPanelSender: (event: unknown) => boolean = () => true,
) {
  const listeners = new Map<string, (event: unknown, value?: unknown) => unknown>();
  const ipc: PanelIpc = { handle: (channel, listener) => listeners.set(channel, listener) };
  const reloads: string[] = [];
  const logged: string[] = [];
  registerPanelHandlers({
    home,
    ipc,
    log: (message) => logged.push(message),
    pickWallpaperFile,
    reload: () => reloads.push("reload"),
    isPanelSender,
  });
  return { listeners, reloads, logged };
}

test("the pick handler stores the chosen file as wallpaper.image and keeps the theme", async () => {
  const home = makeHome();
  withWallpaperOverride(home);
  const source = join(home, "picker", "chosen.webp");
  mkdirSync(join(home, "picker"), { recursive: true });
  writeFileSync(source, "webp");
  const { listeners, reloads } = harness(home, async () => source);
  const stored = join(home, "imports", "wallpaper", `chosen-${tag("webp")}.webp`);

  const picked = (await listeners.get(CHANNEL_PANEL_PICK_WALLPAPER)!(undefined)) as { canceled: boolean; file: string };
  assert.deepEqual(picked, { canceled: false, file: "chosen.webp" });
  const config = readConfig(home);
  assert.equal(config.theme, "mine"); // picking a wallpaper must not clear the theme
  assert.equal(config.wallpaper?.image, stored);
  assert.equal(reloads.length, 1);

  // A canceled dialog changes nothing.
  const canceling = harness(home, async () => null);
  assert.deepEqual(await canceling.listeners.get(CHANNEL_PANEL_PICK_WALLPAPER)!(undefined), { canceled: true });
  assert.equal(readConfig(home).wallpaper?.image, stored);
  assert.equal(canceling.reloads.length, 0);
});

test("new image selection clears inherited dim while explicit legacy dim stays intact", async () => {
  const home = makeHome();
  const store = join(home, "imports", "wallpaper");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "new.png"), "new");
  const { listeners } = harness(home, async () => null);
  writeConfigAtomic(home, { theme: "builtinwp" });
  await listeners.get(CHANNEL_PANEL_SELECT_WALLPAPER)!(undefined, "new.png");
  assert.equal(readConfig(home).wallpaper?.dim, 0);
  assert.equal(readPanelData(home).effective.wallpaper.dark?.dim, 0);

  writeConfigAtomic(home, { theme: "builtinwp", wallpaper: { dim: 0.7 } });
  await listeners.get(CHANNEL_PANEL_SELECT_WALLPAPER)!(undefined, "new.png");
  assert.equal(readConfig(home).wallpaper?.dim, 0.7);

  writeConfigAtomic(home, { theme: "builtinwp", wallpaper: { dark: { dim: 0.9 } } });
  await listeners.get(CHANNEL_PANEL_SELECT_WALLPAPER)!(undefined, "new.png");
  assert.equal(readConfig(home).wallpaper?.dim, undefined);
  assert.equal(readConfig(home).wallpaper?.dark?.dim, 0.9);
});

test("selecting a stored wallpaper preserves theme and tuning while refusing paths and symlinks", async (t: TestContext) => {
  const home = makeHome();
  const store = join(home, "imports", "wallpaper");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "first.png"), "first");
  writeFileSync(join(store, "second.gif"), "second");
  writeFileSync(join(store, "unsupported.exe"), "exe");
  writeFileSync(join(home, "outside.png"), "outside");
  writeConfigAtomic(home, { theme: "mine", wallpaper: { image: join(store, "first.png"), dim: 0.37, blur: 9 } });
  const { listeners, reloads, logged } = harness(home, async () => null);
  assert.deepEqual(await listeners.get(CHANNEL_PANEL_SELECT_WALLPAPER)!(undefined, "second.gif"), { ok: true });
  assert.deepEqual(readConfig(home).wallpaper, { image: join(store, "second.gif"), dim: 0.37, blur: 9 });
  assert.equal(readConfig(home).theme, "mine");
  assert.equal(readPanelData(home).wallpaper.id, "second.gif");
  assert.equal(reloads.length, 1);
  const bad = ["../outside.png", "..\\outside.png", join(home, "outside.png"), "unsupported.exe", "missing.png", { id: "first.png" }];
  for (const value of bad) await assert.rejects(async () => listeners.get(CHANNEL_PANEL_SELECT_WALLPAPER)!(undefined, value));
  try {
    symlinkSync(join(home, "outside.png"), join(store, "escape.png"));
    await assert.rejects(async () => listeners.get(CHANNEL_PANEL_SELECT_WALLPAPER)!(undefined, "escape.png"), /escapes the store/);
  } catch (error) {
    if (String(error).includes("EPERM")) t.diagnostic("symlink check unavailable");
    else throw error;
  }
  assert.equal(readConfig(home).wallpaper?.image, join(store, "second.gif"));
  assert.equal(reloads.length, 1);
  assert.ok(logged.length >= bad.length, "rejected requests are logged before returning errors");
});

test("the panel saves the look as a theme, and discard drops every personal override", async () => {
  const home = makeHome();
  writeConfigAtomic(home, { theme: "mine", radius: 0, glass: { opacity: 0.6 } });
  assert.equal(readPanelData(home).unsaved, true);
  const { listeners, reloads } = harness(home, async () => null);
  const save = listeners.get(CHANNEL_PANEL_SAVE_THEME)!;

  assert.deepEqual(await save(undefined, { name: "Kept" }), { id: "kept", name: "Kept" });
  assert.deepEqual(readConfig(home), { enabled: true, theme: "kept" });
  assert.equal(readPanelData(home).unsaved, false);
  assert.equal(readPanelData(home).effective.glass.opacity, 0.6);
  assert.equal(reloads.length, 1);
  for (const bad of [undefined, "Kept", ["Kept"], { name: "Kept", path: "/tmp" }, { name: "" }]) await assert.rejects(async () => save(undefined, bad));

  writeConfigAtomic(home, { theme: "builtinwp", accent: "#123456", wallpaper: { image: "x.png", blur: 3 } });
  const discarded = applyPanelInput(readConfig(home), { discard: true }, home);
  assert.deepEqual(discarded, { enabled: true, theme: "builtinwp" });
  assert.throws(() => applyPanelInput(readConfig(home), { discard: "yes" }, home), /invalid discard/);
});

test("an asynchronous picker failure is logged before the IPC request rejects", async () => {
  const home = makeHome();
  const { listeners, logged, reloads } = harness(home, async () => { throw new Error("picker unavailable"); });
  await assert.rejects(async () => listeners.get(CHANNEL_PANEL_PICK_WALLPAPER)!(undefined), /picker unavailable/);
  assert.match(logged[0]!, /panel-pick-wallpaper failed: Error: picker unavailable/);
  assert.equal(reloads.length, 0);
});

test("requests that do not come from the panel window are refused and change nothing", async () => {
  const home = makeHome();
  withWallpaperOverride(home);
  const stranger = harness(home, async () => null, () => false);
  for (const channel of [CHANNEL_PANEL_GET, CHANNEL_PANEL_APPLY, CHANNEL_PANEL_PREVIEW, CHANNEL_PANEL_PICK_WALLPAPER, CHANNEL_PANEL_SELECT_WALLPAPER, CHANNEL_PANEL_SAVE_THEME]) {
    await assert.rejects(
      async () => {
        await stranger.listeners.get(channel)!({ sender: { id: 1 } });
      },
      /refused/,
      channel,
    );
  }
  assert.ok(stranger.logged.length >= 3, "every refusal is logged");
  assert.equal(stranger.reloads.length, 0);
  assert.equal(readConfig(home).theme, "mine"); // nothing was executed
});

test("preview validates and resolves exact CSS without writing or reloading", async () => {
  const home = makeHome();
  writeConfigAtomic(home, { theme: "mine", wallpaper: { image: "/w/pic.jpg" } });
  const before = readFileSync(join(home, "config.json"), "utf8");
  const { listeners, reloads } = harness(home, async () => null);
  const preview = await listeners.get(CHANNEL_PANEL_PREVIEW)!(undefined, { accent: "#aabbcc", glassOpacity: 0.5 }) as { css: string };
  assert.match(preview.css, /#aabbcc/i);
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), before);
  assert.equal(reloads.length, 0);
  await assert.rejects(async () => listeners.get(CHANNEL_PANEL_PREVIEW)!(undefined, { accent: "url(file:\/\/\/secret)" }), /invalid accent/);
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), before);
  writeConfigAtomic(home, { enabled: false, theme: "mine" });
  assert.deepEqual(await listeners.get(CHANNEL_PANEL_PREVIEW)!(undefined, { radius: 2 }), { css: "" });
});

test("the apply handler writes the merged config to disk and triggers a reload", async () => {
  const home = makeHome();
  withWallpaperOverride(home);
  const { listeners, reloads } = harness(home, async () => null);
  const result = await listeners.get(CHANNEL_PANEL_APPLY)!(undefined, { theme: null, wallpaper: null });
  assert.deepEqual(result, { ok: true });
  const config = readConfig(home);
  assert.equal(config.theme, null);
  assert.equal(config.wallpaper, undefined);
  assert.equal(reloads.length, 1);
  // After a reset no override lingers: switching to a wallpapered theme shows its wallpaper.
  await listeners.get(CHANNEL_PANEL_APPLY)!(undefined, { theme: "builtinwp" });
  const { look } = loadLook(home);
  assert.equal(look?.wallpaper.dark?.image, join(home, "runtime", "themes", "builtinwp", "bg.png"));
  // Invalid requests reject (the renderer shows them) without writing anything.
  await assert.rejects(async () => {
    await listeners.get(CHANNEL_PANEL_APPLY)!(undefined, { theme: "nope" });
  });
  assert.equal(readConfig(home).theme, "builtinwp");
});

test("a channel that cannot be registered is logged and skipped; the rest still works", async () => {
  const home = makeHome();
  const listeners = new Map<string, (event: unknown, value?: unknown) => unknown>();
  const logged: string[] = [];
  // e.g. a second runtime instance already owns the get channel.
  const ipc: PanelIpc = {
    handle: (channel, listener) => {
      if (channel === CHANNEL_PANEL_GET) throw new Error("handler already registered");
      listeners.set(channel, listener);
    },
  };
  const reloads: string[] = [];
  registerPanelHandlers({
    home,
    ipc,
    log: (m) => logged.push(m),
    pickWallpaperFile: async () => null,
    reload: () => reloads.push("r"),
    isPanelSender: () => true,
  });
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /panel-get unavailable/);
  assert.ok(listeners.has(CHANNEL_PANEL_APPLY), "apply still registered");
  assert.ok(listeners.has(CHANNEL_PANEL_PICK_WALLPAPER), "pick still registered");
  await listeners.get(CHANNEL_PANEL_APPLY)!(undefined, { theme: "mine" });
  assert.equal(readConfig(home).theme, "mine");
});

test("appearance IPC is restricted to the top-level main window; no standalone panel is created", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/runtime/main.ts", import.meta.url)), "utf8");
  assert.match(source, /const isPanelSender = \(event: unknown\): boolean => senderIsMainWindow/);
  assert.match(source, /event\.senderFrame === event\.sender\.mainFrame && isMainWindowUrl/);
  assert.doesNotMatch(source, /new BrowserWindow\(/);
});
