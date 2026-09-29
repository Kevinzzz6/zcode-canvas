import assert from "node:assert/strict";
import { test } from "node:test";
import { previewCss } from "../src/runtime/overlay-preview.ts";
import { resolveLook, type ResolvedLook } from "../src/shared/look.ts";
import { isMainWindowUrl } from "../src/shared/window.ts";

const mainUrl = "file:///C:/ZCode/resources/app/out/renderer/index.html";

test("only the main file renderer page gets the injected UI", () => {
  assert.equal(isMainWindowUrl(mainUrl), true);
  assert.equal(isMainWindowUrl(`${mainUrl}?session=hello#editor`), true);
  assert.equal(isMainWindowUrl(`${mainUrl}?windowKind=chat`), false);
  assert.equal(isMainWindowUrl(`${mainUrl}?windowKind=`), false);
  assert.equal(isMainWindowUrl(`${mainUrl}?session=hello&windowKind=`), false);
  assert.equal(isMainWindowUrl("https://example.test/out/renderer/index.html"), false);
  assert.equal(isMainWindowUrl("file:///C:/ZCode/out/renderer/other.html"), false);
  assert.equal(isMainWindowUrl("file:///C:/ZCode/out/renderer/index.html/child"), false);
  assert.equal(isMainWindowUrl("not a URL"), false);
});

function wallpaperLook(): ResolvedLook {
  return resolveLook({ wallpaper: {
    image: "wallpaper.png",
    dark: { image: "dark.png", overlay: "#123456", dim: 0.3 },
    light: { image: "light.png", overlay: "#abcdef", dim: 0.2 },
  } }, null, "C:/canvas");
}

test("preview rules are scoped to each mode and keep a zero-dim layer", () => {
  const css = previewCss(wallpaperLook(), { dim: 0, blur: 11 });
  assert.match(css, /html:root\.dark body::before\{[^}]*blur\(11px\)/);
  assert.match(css, /html:root:not\(\.dark\) body::before\{[^}]*blur\(11px\)/);
  assert.equal((css.match(/body::after\{/g) ?? []).length, 2);
  assert.equal((css.match(/ 0%,transparent/g) ?? []).length, 2);
  assert.match(css, /pointer-events:none/);
});

test("preview clamps numbers, replaces nonfinite values, and leaves the resolved look untouched", () => {
  const look = wallpaperLook();
  const before = structuredClone(look);
  const css = previewCss(look, { dim: 100, blur: -20, scale: Infinity, saturate: NaN, brightness: -1, contrast: 300, grayscale: -9 });
  assert.match(css, /blur\(0px\) saturate\(1\) brightness\(0\) contrast\(2\) grayscale\(0\)/);
  assert.match(css, /transform:scale\(1\)/);
  assert.match(css, / 100%,transparent/);
  assert.doesNotMatch(css, /NaN|Infinity|blur\(-20px\)|contrast\(300\)/);
  assert.deepEqual(look, before);
});

test("untrusted overlay values cannot break out of generated preview declarations", () => {
  const look = wallpaperLook();
  look.wallpaper.dark!.overlay = "red;}body{display:none";
  const css = previewCss(look, {});
  assert.doesNotMatch(css, /display:none|red;\}/);
  assert.match(css, /html:root\.dark body::after\{[^}]*#000000/);
});

test("preview produces rules only for wallpaper modes that exist", () => {
  const look = wallpaperLook();
  look.wallpaper.light = null;
  const css = previewCss(look, { dim: 0.4 });
  assert.match(css, /html:root\.dark body::before/);
  assert.doesNotMatch(css, /html:root:not\(\.dark\)/);
  assert.equal(previewCss(resolveLook({}, null, "C:/canvas"), { dim: 0.4 }), "\n");
});
