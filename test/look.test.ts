import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { buildCss, contrastForeground, isSafeCssValue, tokenProperty } from "../src/shared/css.ts";
import { loadLook, resolveLook, type ThemeEntry } from "../src/shared/look.ts";

const theme = (manifest: ThemeEntry["manifest"], dir = "/themes/t"): ThemeEntry => ({ id: "t", dir, builtin: true, manifest });

test("config overrides theme field by field; null removes the theme's wallpaper", () => {
  const t = theme({ name: "T", wallpaper: { image: "bg.png", dim: 0.5 }, glass: { opacity: 0.6, blur: 10 } });
  const look = resolveLook({ glass: { blur: 4 } }, t, "/home");
  assert.equal(look.glass.opacity, 0.6);
  assert.equal(look.glass.blur, 4);
  assert.equal(look.wallpaper?.dim, 0.5);
  assert.equal(resolveLook({ wallpaper: null }, t, "/home").wallpaper, null);
});

test("relative files resolve against the theme dir or the canvas home", () => {
  const t = theme({ name: "T", wallpaper: { image: "bg.png" } }, resolve("/themes/t"));
  assert.equal(resolveLook({}, t, "/home").wallpaper?.image, resolve("/themes/t/bg.png"));
  assert.equal(resolveLook({ startup: { logo: "logo.png" } }, null, resolve("/home")).startup.logo, resolve("/home/logo.png"));
});

test("numbers are clamped and enums fall back to defaults", () => {
  const look = resolveLook({ glass: { opacity: 7, material: "glass" as never }, startup: { animation: "spin" as never } }, null, "/home");
  assert.equal(look.glass.opacity, 1);
  assert.equal(look.glass.material, "acrylic");
  assert.equal(look.startup.animation, "pop");
});

test("an untouched look produces no CSS", () => {
  assert.equal(buildCss(resolveLook({}, null, "/home")).css, "");
});

test("tokens and accent are scoped per mode", () => {
  const { css } = buildCss(resolveLook({ colors: { dark: { sidebar: "#101010" } }, accent: { light: "#ffcc00" } }, null, "/home"));
  assert.match(css, /html:root\.dark \{\n {2}--color-sidebar: #101010;/);
  assert.match(css, /html:root:not\(\.dark\) \{\n {2}--color-primary: #ffcc00;[\s\S]*--color-primary-foreground: #000000;/);
  assert.equal(tokenProperty("--x-custom"), "--x-custom");
});

test("glass makes surfaces translucent on #root without self-referencing tokens", () => {
  const { css } = buildCss(resolveLook({ glass: { opacity: 0.5, blur: 12 } }, null, "/home"));
  assert.match(css, /body \{\n {2}--zc-src-background-win-alt: var\(--color-background-win-alt\);/);
  assert.match(css, /--color-background-win-alt: color-mix\(in srgb, var\(--zc-src-background-win-alt\) 35%, transparent\)/);
  // frame 35% + content x% must add up to the requested 50%
  assert.match(css, /--color-background: color-mix\(in srgb, var\(--zc-src-background\) 23\.1%, transparent\)/);
  assert.match(css, /backdrop-filter: blur\(12px\)/);
});

test("unsafe values are dropped with a warning", () => {
  assert.equal(isSafeCssValue("red; } body { display:none"), false);
  assert.equal(isSafeCssValue("url(https://evil)"), false);
  assert.equal(isSafeCssValue("color-mix(in oklab, #fff 60%, transparent)"), true);
  const result = buildCss(resolveLook({ colors: { dark: { panel: "red;}" } } }, null, "/home"));
  assert.doesNotMatch(result.css, /red;\}/);
  assert.equal(result.warnings.length, 1);
});

test("contrast foreground picks black on light accents and white on dark ones", () => {
  assert.equal(contrastForeground("#fde047"), "#000000");
  assert.equal(contrastForeground("#1e3a8a"), "#ffffff");
  assert.equal(contrastForeground("rgb(250, 250, 250)"), "#000000");
  assert.equal(contrastForeground("hsl(10 50% 50%)"), "#ffffff");
});

test("wallpaper and startup logo become file URLs; overlay waits for startup-ready", () => {
  const home = mkdtempSync(join(tmpdir(), "zc-home-"));
  writeFileSync(join(home, "bg.png"), "x");
  const { css } = buildCss(resolveLook({ wallpaper: { image: "bg.png", fit: "contain", blur: 5 }, startup: { logo: "bg.png", animation: "none" } }, null, home));
  assert.match(css, /body::before \{[\s\S]*inset: -10px;[\s\S]*background: url\("file:\/\/\/[^"]+bg\.png\?v=\d+"\) center \/ contain no-repeat;[\s\S]*filter: blur\(5px\)/);
  assert.match(css, /html::before \{/);
  assert.match(css, /body:not\(\.zcode-startup-ready\)::after \{\n {2}opacity: 0;/);
  assert.match(css, /#loading \.startup-logo-shell \{[\s\S]*url\("file:\/\/\//);
  assert.match(css, /animation: none/);
});

test("loadLook reads config and user themes from disk; enabled=false switches off", () => {
  const home = mkdtempSync(join(tmpdir(), "zc-home-"));
  mkdirSync(join(home, "themes", "mine"), { recursive: true });
  writeFileSync(join(home, "themes", "mine", "theme.json"), JSON.stringify({ name: "Mine", accent: "#123456" }));
  writeFileSync(join(home, "config.json"), JSON.stringify({ theme: "mine" }));
  assert.equal(loadLook(home).look?.accent.dark, "#123456");
  writeFileSync(join(home, "config.json"), JSON.stringify({ theme: "missing" }));
  assert.deepEqual(loadLook(home).warnings, ['theme "missing" not found']);
  writeFileSync(join(home, "config.json"), JSON.stringify({ enabled: false, theme: "mine" }));
  assert.equal(loadLook(home).look, null);
});
