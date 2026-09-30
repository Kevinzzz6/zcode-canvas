import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { themeSchemaProblems } from "../src/cli/schema.ts";
import { buildCss } from "../src/shared/css.ts";
import { listThemes, loadLook, readConfig, resolveLook, writeConfigAtomic, type CanvasConfig, type ThemeEntry } from "../src/shared/look.ts";
import { flattenLook, saveLookAsTheme } from "../src/shared/save-theme.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const packagedThemes = join(packageRoot, "themes");

/** Declarations per rule, last one winning and sorted: the sheet as the browser applies it. File
 *  URLs become the hash of the file they point to, since a saved theme holds copies. */
function normalize(css: string): string {
  const files = css.replace(/url\("(file:[^"?]+)(\?v=\d+)?"\)/g, (_, url: string) =>
    `url(${createHash("sha256").update(readFileSync(fileURLToPath(url))).digest("hex").slice(0, 12)})`);
  return files.replace(/\{\n([^{}]*)\n\s*\}/g, (_, body: string) => {
    const declarations = new Map<string, string>();
    for (const line of body.split(";\n")) {
      const text = line.trim().replace(/;$/, "");
      const colon = text.indexOf(":");
      declarations.set(text.slice(0, colon).trim(), text.slice(colon + 1).trim());
    }
    return `{${[...declarations].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${v}`).join(";")}}`;
  });
}

const cssOf = (config: CanvasConfig, theme: ThemeEntry | null, home: string) => normalize(buildCss(resolveLook(config, theme, home)).css);

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zc-studio-"));
  mkdirSync(join(home, "imports", "wallpaper"), { recursive: true });
  writeFileSync(join(home, "imports", "wallpaper", "pic.png"), "picture");
  return home;
}

const OVERRIDES: Record<string, CanvasConfig> = {
  none: {},
  glass: { glass: { opacity: 0.7, blur: 12, regions: { main: { blur: 20 }, frame: { opacity: 0.5 } } } },
  accent: { accent: "#ff8800" },
  palette: { palette: { seed: "#5eead4", variant: "vivid", backdrop: "#223344" }, glass: { opacity: 0.6 } },
  "palette + accent": { palette: { seed: "#8b7cf5", variant: "oled" }, accent: { dark: "#ff0000" } },
  "accent + own colors": { accent: "#00ff00", colors: { dark: { sidebar: "#111111", "--color-primary": "#abcdef" } } },
  wallpaper: { wallpaper: { image: "imports/wallpaper/pic.png", dim: 0, light: { brightness: 0.8 } }, radius: 0.5 },
  "no wallpaper": { wallpaper: null, radius: null, accent: null },
  "vars + startup": { vars: { "--x": "1px", dark: { "--x": "2px" } }, startup: { logo: null, animation: "fade", background: "#101010" } },
};

test("a flattened look renders exactly like the theme with its personal overrides", () => {
  const home = makeHome();
  const themes: Array<ThemeEntry | null> = [null, ...listThemes(home, [packagedThemes])];
  assert.ok(themes.length > 5, "packaged themes are found");
  for (const theme of themes) {
    for (const [label, config] of Object.entries(OVERRIDES)) {
      const flat = flattenLook(config, theme, home);
      const single: ThemeEntry = { id: "flat", dir: home, builtin: false, manifest: { name: "flat", ...flat } };
      assert.equal(cssOf({}, single, home), cssOf(config, theme, home), `${theme?.id ?? "no theme"} + ${label}`);
      assert.deepEqual(themeSchemaProblems(packageRoot, { format: 1, ...single.manifest }), [], `${theme?.id ?? "no theme"} + ${label} is a valid theme`);
    }
  }
});

test("a flattened palette stays a palette instead of fifty spelled-out colors", () => {
  const home = makeHome();
  const flat = flattenLook(OVERRIDES.palette!, null, home);
  assert.deepEqual(flat.palette, OVERRIDES.palette!.palette);
  assert.equal(flat.colors, undefined);
  // The personal accent has to name the palette tokens it replaces.
  const both = flattenLook(OVERRIDES["palette + accent"]!, null, home);
  assert.equal(both.colors?.dark?.primary, "#ff0000");
  assert.equal(both.colors?.light, undefined);
});

test("save as copies the files in, switches to the new theme and clears the overrides", () => {
  const home = makeHome();
  mkdirSync(join(home, "themes", "mine"), { recursive: true });
  writeFileSync(join(home, "themes", "mine", "bg.png"), "background");
  writeFileSync(join(home, "themes", "mine", "theme.json"), JSON.stringify({ name: "Mine", license: "CC-BY-4.0", wallpaper: { image: "bg.png" }, glass: { opacity: 0.8 } }));
  const config: CanvasConfig = { theme: "mine", accent: "#ff8800", wallpaper: { image: "imports/wallpaper/pic.png", dark: { dim: 0.2 } } };
  writeConfigAtomic(home, config);
  const before = normalize(buildCss(loadLook(home).look!).css);

  assert.deepEqual(saveLookAsTheme(home, "  My Look "), { id: "my-look", name: "My Look" });
  assert.deepEqual(readConfig(home), { enabled: true, theme: "my-look" });
  assert.equal(normalize(buildCss(loadLook(home).look!).css), before);
  const saved = JSON.parse(readFileSync(join(home, "themes", "my-look", "theme.json"), "utf8"));
  assert.equal(saved.name, "My Look");
  assert.equal(saved.license, "CC-BY-4.0", "attribution of the base theme carries over");
  // The modes differ in dim, so each gets its own spec, sharing one copied file.
  assert.match(saved.wallpaper.dark.image, /^wallpaper-[0-9a-f]{12}\.png$/);
  assert.equal(saved.wallpaper.light.image, saved.wallpaper.dark.image);
  assert.deepEqual(readdirSync(join(home, "themes", "my-look")).sort(), [saved.wallpaper.dark.image, "theme.json"].sort());
  assert.deepEqual(readdirSync(home).filter((name) => name.startsWith(".theme-")), [], "no staging folder is left");

  // Non-Latin names get a free generic id.
  writeConfigAtomic(home, { theme: "my-look", radius: 0 });
  assert.equal(saveLookAsTheme(home, "我的主题").id, "custom");
  writeConfigAtomic(home, { theme: "custom", radius: 0.5 });
  assert.equal(saveLookAsTheme(home, "我的主题").id, "custom-2");
});

test("saving in place keeps the metadata and a backup, and refuses built-in themes", () => {
  const home = makeHome();
  mkdirSync(join(home, "themes", "mine"), { recursive: true });
  writeFileSync(join(home, "themes", "mine", "bg.png"), "background");
  const original = JSON.stringify({ name: "Mine", author: "me", version: "1.0.0", wallpaper: { image: "bg.png" } });
  writeFileSync(join(home, "themes", "mine", "theme.json"), original);
  writeConfigAtomic(home, { theme: "mine", glass: { opacity: 0.5 } });
  const before = normalize(buildCss(loadLook(home).look!).css);

  assert.deepEqual(saveLookAsTheme(home), { id: "mine", name: "Mine" });
  assert.equal(normalize(buildCss(loadLook(home).look!).css), before);
  assert.deepEqual(readConfig(home), { enabled: true, theme: "mine" });
  const saved = JSON.parse(readFileSync(join(home, "themes", "mine", "theme.json"), "utf8"));
  assert.deepEqual([saved.author, saved.version, saved.wallpaper.image, saved.glass.opacity], ["me", "1.0.0", "bg.png", 0.5]);
  assert.equal(readFileSync(join(home, "themes", "mine", "theme.json.bak"), "utf8"), original);

  mkdirSync(join(home, "runtime", "themes", "shipped"), { recursive: true });
  writeFileSync(join(home, "runtime", "themes", "shipped", "theme.json"), JSON.stringify({ name: "Shipped" }));
  writeConfigAtomic(home, { theme: "shipped", radius: 0 });
  assert.throws(() => saveLookAsTheme(home), /user theme/);
  writeConfigAtomic(home, { radius: 0 });
  assert.throws(() => saveLookAsTheme(home), /user theme/);
});

test("a missing file fails the save without leaving a theme behind or touching the config", () => {
  const home = makeHome();
  const config: CanvasConfig = { theme: null, wallpaper: { image: "imports/wallpaper/gone.png" } };
  writeConfigAtomic(home, config);
  assert.throws(() => saveLookAsTheme(home, "Broken"), /找不到/);
  assert.equal(existsSync(join(home, "themes", "broken")), false);
  assert.deepEqual(readdirSync(home).filter((name) => name.startsWith(".theme-")), []);
  assert.deepEqual(readConfig(home), { enabled: true, ...config });
  assert.throws(() => saveLookAsTheme(home, "  "), /invalid theme name/);
});

test("the first saved theme creates the themes folder", () => {
  const home = makeHome();
  assert.equal(existsSync(join(home, "themes")), false);
  writeConfigAtomic(home, { radius: 0 });
  assert.equal(saveLookAsTheme(home, "First").id, "first");
  assert.ok(existsSync(join(home, "themes", "first", "theme.json")));
});
