import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { buildCss, contrastForeground, isSafeCssValue, tokenProperty, type CssValueKind } from "../src/shared/css.ts";
import { checkManifest, listThemes, loadLook, readConfig, resolveLook, type StartupAnimation, type ThemeEntry } from "../src/shared/look.ts";
import { contrastRatio } from "../src/shared/palette.ts";

const theme = (manifest: ThemeEntry["manifest"], dir = "/themes/t"): ThemeEntry => ({ id: "t", dir, builtin: true, manifest });

test("config overrides theme field by field; null removes the theme's wallpaper", () => {
  const t = theme({ name: "T", wallpaper: { image: "bg.png", dim: 0.5 }, glass: { opacity: 0.6, blur: 10 } });
  const look = resolveLook({ glass: { blur: 4 } }, t, "/home");
  assert.equal(look.glass.opacity, 0.6);
  assert.equal(look.glass.blur, 4);
  assert.equal(look.wallpaper.dark?.dim, 0.5);
  assert.deepEqual(resolveLook({ wallpaper: null }, t, "/home").wallpaper, { dark: null, light: null });
});

test("relative files resolve against the theme dir or the canvas home", () => {
  const t = theme({ name: "T", wallpaper: { image: "bg.png" } }, resolve("/themes/t"));
  assert.equal(resolveLook({}, t, "/home").wallpaper.light?.image, resolve("/themes/t/bg.png"));
  assert.equal(resolveLook({ startup: { logo: "logo.png" } }, null, resolve("/home")).startup.logo, resolve("/home/logo.png"));
});

test("numbers are clamped and enums fall back to defaults", () => {
  const look = resolveLook({ glass: { opacity: 7, material: "glass" as never }, startup: { animation: "spin" as never } }, null, "/home");
  assert.equal(look.glass.opacity, 1);
  assert.equal(look.glass.material, "acrylic");
  assert.equal(look.startup.animation, "pop");
});

test("wallpaper scale and color filters clamp to their ranges and default to neutral", () => {
  const home = mkdtempSync(join(tmpdir(), "zc-home-"));
  const tuned = resolveLook(
    { wallpaper: { image: "a.png", scale: 9, saturate: -1, brightness: 0.5, contrast: 3, grayscale: 2 } },
    null,
    home,
  ).wallpaper.dark!;
  assert.equal(tuned.scale, 4);
  assert.equal(tuned.saturate, 0);
  assert.equal(tuned.brightness, 0.5);
  assert.equal(tuned.contrast, 2);
  assert.equal(tuned.grayscale, 1);
  const neutral = resolveLook({ wallpaper: { image: "a.png" } }, null, home).wallpaper.light!;
  assert.equal(neutral.scale, 1);
  assert.equal(neutral.saturate, 1);
  assert.equal(neutral.brightness, 1);
  assert.equal(neutral.contrast, 1);
  assert.equal(neutral.grayscale, 0);
  // schema/theme.schema.json mirrors the same ranges.
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schema/theme.schema.json", import.meta.url)), "utf8")) as object;
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  assert.ok(validate({ format: 1, name: "T", wallpaper: { image: "a.png", scale: 1.2, saturate: 2, brightness: 0.8, contrast: 1.1, grayscale: 0.5 } }));
  assert.ok(!validate({ format: 1, name: "T", wallpaper: { scale: 9 } }), "schema rejects out-of-range scale");
});

test("wallpaper scale zooms around the focal position; filters chain with blur", () => {
  const home = mkdtempSync(join(tmpdir(), "zc-home-"));
  writeFileSync(join(home, "a.png"), "x");
  const { css } = buildCss(
    resolveLook({ wallpaper: { image: "a.png", position: "50% 25%", scale: 1.5, blur: 8, saturate: 0.6, grayscale: 1 } }, null, home),
  );
  assert.match(css, /transform: scale\(1\.5\)/);
  assert.match(css, /transform-origin: 50% 25%/);
  assert.match(css, /filter: blur\(8px\) saturate\(0\.6\) grayscale\(1\)/);
  // Neutral values emit nothing, keeping the sheet minimal for everyone who does not tune.
  const plain = buildCss(resolveLook({ wallpaper: { image: "a.png" } }, null, home)).css;
  assert.doesNotMatch(plain, /transform:|filter:/);
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
  assert.equal(isSafeCssValue("red; } body { display:none", "color"), false);
  assert.equal(isSafeCssValue("url(https://evil)", "color"), false);
  assert.equal(isSafeCssValue("color-mix(in oklab, #fff 60%, transparent)", "color"), true);
  const result = buildCss(resolveLook({ colors: { dark: { panel: "red;}" } } }, null, "/home"));
  assert.doesNotMatch(result.css, /red;\}/);
  assert.equal(result.warnings.length, 1);
});

test("value escapes and resource loaders are rejected, not just literal url(", () => {
  for (const kind of ["color", "image", "position", "vars"] as const) {
    assert.equal(isSafeCssValue("ur\\6c(https://evil)", kind), false, `backslash escape via ${kind}`);
    assert.equal(isSafeCssValue("image-set(\"https://evil\" 1x)", kind), false, `image-set via ${kind}`);
    assert.equal(isSafeCssValue("cross-fade(url(x) 50%, red)", kind), false, `cross-fade via ${kind}`);
    assert.equal(isSafeCssValue("@import \"evil\"", kind), false, `at-rule via ${kind}`);
  }
  assert.equal(isSafeCssValue("linear-gradient(90deg, #fff500 0 10px, #101110 10px)", "image"), true);
  assert.equal(isSafeCssValue("linear-gradient(90deg, #fff500 0 10px, #101110 10px)", "color"), false);
  assert.equal(isSafeCssValue("calc(50% - 20px)", "position"), true);
  assert.equal(isSafeCssValue("red", "position"), true);
  assert.equal(isSafeCssValue("\"Segoe UI\", sans-serif", "vars"), true);
  assert.equal(isSafeCssValue("\"Segoe UI\", sans-serif", "color"), false);
  assert.equal(isSafeCssValue("var(--color-primary)", "vars"), true);
  assert.equal(isSafeCssValue("var(--color-primary)", "color"), false);
});

test("hostile color keys cannot break out of the declaration", () => {
  const key = "x; } body { background: url(https://evil); color: red";
  const { css, warnings } = buildCss(resolveLook({ colors: { dark: { [key]: "#101010" } } }, null, "/home"));
  assert.equal(css, "");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /ignored colors\.dark\./);
});

test("contrast foreground picks black on light accents and white on dark ones", () => {
  assert.equal(contrastForeground("#fde047"), "#000000");
  assert.equal(contrastForeground("#1e3a8a"), "#ffffff");
  assert.equal(contrastForeground("rgb(250, 250, 250)"), "#000000");
  assert.equal(contrastForeground("hsl(10 50% 30%)"), "#ffffff");
  // Mid tones: black contrasts more from L ≈ 0.179 up, so they must not fall back to white.
  assert.equal(contrastForeground("#808080"), "#000000");
  assert.equal(contrastForeground("#7c5cff"), "#000000");
});

test("contrast foreground agrees with the palette's WCAG contrast on every 12-bit color", () => {
  const hex = (n: number) => `#${[8, 4, 0].map((shift) => ((n >> shift) & 15).toString(16).repeat(2)).join("")}`;
  for (let n = 0; n < 4096; n++) {
    const color = hex(n);
    const other = contrastForeground(color) === "#000000" ? "#ffffff" : "#000000";
    assert.ok(contrastRatio(contrastForeground(color), color) >= contrastRatio(other, color), color);
  }
});

test("contrast foreground resolves modern color syntaxes instead of defaulting to white", () => {
  assert.equal(contrastForeground("rgb(100% 100% 100%)"), "#000000");
  assert.equal(contrastForeground("rgb(0 0 0 / 40%)"), "#ffffff");
  assert.equal(contrastForeground("rgba(30, 58, 138, 0.9)"), "#ffffff");
  assert.equal(contrastForeground("hsl(10, 50%, 50%)"), "#000000"); // L 0.1797, a hair past the crossover
  assert.equal(contrastForeground("hsl(10 50% 90%)"), "#000000");
  // oklch: a pale blue accent and a deep violet accent.
  assert.equal(contrastForeground("oklch(96% 0.03 255)"), "#000000");
  assert.equal(contrastForeground("oklch(0.37 0.13 265)"), "#ffffff");
  assert.equal(contrastForeground("oklab(95% 0 0)"), "#000000");
  // Syntaxes that cannot be resolved statically keep the documented white fallback.
  assert.equal(contrastForeground("color-mix(in oklab, #fff 60%, transparent)"), "#ffffff");
  assert.equal(contrastForeground("lab(52% 40 59)"), "#ffffff");
});

test("wallpaper and startup logo become file URLs; overlay waits for startup-ready", () => {
  const home = mkdtempSync(join(tmpdir(), "zc-home-"));
  writeFileSync(join(home, "bg.png"), "x");
  const { css } = buildCss(resolveLook({ wallpaper: { image: "bg.png", fit: "contain", blur: 5 }, startup: { logo: "bg.png", animation: "none" } }, null, home));
  assert.match(css, /body::before \{[\s\S]*inset: -10px;[\s\S]*background: url\("file:\/\/\/[^"]+bg\.png\?v=\d+"\) center \/ contain no-repeat;[\s\S]*filter: blur\(5px\)/);
  assert.match(css, /html::before \{/);
  assert.match(css, /body:not\(\.zcode-startup-ready\)::after \{\n {2}opacity: 0;/);
  assert.match(css, /#loading \.startup-logo-shell \{[\s\S]*url\("file:\/\/\//);
  assert.match(css, /animation-name: zc-startup-none/);
});

test("startup animations always end, and motion gives way to reduced motion", () => {
  const css = (animation: StartupAnimation) => buildCss(resolveLook({ startup: { animation } }, null, "/home")).css;
  // pop is ZCode's own animation, which already honors reduced motion.
  assert.equal(css("pop"), "");
  assert.match(
    css("fade"),
    /@media \(prefers-reduced-motion: no-preference\) \{\n {2}#loading \.startup-logo-shell \{\n {4}transform: none;\n {4}animation: zc-startup-fade 0\.6s ease forwards;\n {2}\}\n\}/,
  );
  // ZCode takes the startup screen down on the shell's animationend, so a still logo keeps ZCode's
  // own animation timing and only swaps the keyframes.
  const none = css("none");
  assert.match(none, /@keyframes zc-startup-none \{/);
  assert.match(none, /#loading \.startup-logo-shell \{[^}]*animation-name: zc-startup-none;/);
  assert.doesNotMatch(none, /\banimation:|prefers-reduced-motion/);
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

test("a broken config.json reports the file, the position and a way out", () => {
  const home = mkdtempSync(join(tmpdir(), "zc-home-"));
  writeFileSync(join(home, "config.json"), '{ "theme": "mine" ');
  assert.throws(
    () => readConfig(home),
    (error: unknown) => {
      const message = (error as Error).message;
      return message.includes(join(home, "config.json")) && message.includes("不是有效的 JSON") && message.includes("删除该文件");
    },
  );
  for (const content of ["[]", "123", '"text"', "null"]) {
    writeFileSync(join(home, "config.json"), content);
    assert.throws(() => readConfig(home), /不是 JSON 对象/, content);
  }
  // Once the syntax error is fixed, everything reads again.
  writeFileSync(join(home, "config.json"), '{ "theme": "mine" }');
  assert.equal(readConfig(home).theme, "mine");
});

const builtinDir = fileURLToPath(new URL("../themes", import.meta.url));

test("every built-in theme resolves to CSS without warnings and ships the files it references", () => {
  const themes = listThemes(mkdtempSync(join(tmpdir(), "zc-home-")), [builtinDir]);
  assert.ok(themes.length >= 7);
  for (const entry of themes) {
    const look = resolveLook({}, entry, "/home");
    assert.deepEqual(buildCss(look).warnings, [], entry.id);
    for (const file of [look.wallpaper.dark?.image, look.wallpaper.light?.image, look.startup.logo]) {
      if (file) assert.ok(existsSync(file), `${entry.id}: missing ${file}`);
    }
  }
});

function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r = 0, g = 0, bl = 0] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

test("endfield palettes keep text and accent text at AA on every surface they sit on", () => {
  for (const id of ["endfield", "endfield-wuling"]) {
    const manifest = JSON.parse(readFileSync(join(builtinDir, id, "theme.json"), "utf8")) as ThemeEntry["manifest"];
    for (const mode of ["dark", "light"] as const) {
      const c = manifest.colors?.[mode] ?? {};
      const at = (key: string) => c[key] ?? assert.fail(`${id}.${mode} lacks ${key}`);
      const pairs: Array<[string, string]> = [
        ["foreground", "background"],
        ["foreground", "card"],
        ["foreground", "popover"],
        ["foreground-subtle", "background"],
        ["primary-foreground", "primary"],
        // brand is used as text (links, focused borders, file chips); on paper it must sink to the deep stop
        ["brand", "background"],
        ["brand", "card"],
      ];
      for (const [fg, bg] of pairs) {
        const ratio = contrast(at(fg), at(bg));
        assert.ok(ratio >= 4.5, `${id}.${mode}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test("colors set explicitly win over the tokens derived from accent", () => {
  const { css } = buildCss(resolveLook({ accent: "#fff500", colors: { light: { primary: "#101110" } } }, null, "/home"));
  const light = css.match(/html:root:not\(\.dark\) \{[^}]*\}/)?.[0] ?? "";
  assert.match(light, /--color-primary: #101110;/);
  assert.doesNotMatch(light, /--color-primary: #fff500/);
  assert.match(light, /--color-brand: #fff500;/);
  assert.match(light, /--color-ring: #fff500;/);
  // primary-foreground still follows the accent only when primary itself came from it
  assert.match(css, /html:root\.dark \{[^}]*--color-primary-foreground: #000000;/);
});

test("personal accent overrides theme primary tokens but preserves explicit user colors", () => {
  const preset = theme({ name: "Explicit palette", colors: {
    dark: { primary: "#fff500", brand: "#fff500", ring: "#fff500", "primary-foreground": "#000000" },
    light: { "--color-primary": "#101110", brand: "#6b5d00" },
  } });
  const before = structuredClone(preset);
  const css = buildCss(resolveLook({ accent: "#204080" }, preset, "/home")).css;
  assert.equal((css.match(/--color-primary: #204080/g) ?? []).length, 2);
  assert.equal((css.match(/--color-brand: #204080/g) ?? []).length, 2);
  assert.equal((css.match(/--color-primary-foreground: #ffffff/g) ?? []).length, 2);
  const explicit = buildCss(resolveLook({ accent: "#204080", colors: { light: { primary: "#ff0000" } } }, preset, "/home")).css;
  assert.match(explicit, /html:root:not\(\.dark\) \{[^}]*--color-primary: #ff0000/);
  const restored = buildCss(resolveLook({}, preset, "/home")).css;
  assert.match(restored, /--color-primary: #fff500/);
  assert.match(restored, /--color-primary: #101110/);
  assert.deepEqual(preset, before, "never rewrite the original theme");
});

test("a per-mode personal accent leaves the other mode's theme palette unchanged", () => {
  const preset = theme({ name: "Two modes", colors: { dark: { primary: "#fff500" }, light: { primary: "#101110" } } });
  const css = buildCss(resolveLook({ accent: { dark: "#204080" } }, preset, "/home")).css;
  assert.match(css, /html:root\.dark \{[^}]*--color-primary: #204080/);
  assert.match(css, /html:root:not\(\.dark\) \{[^}]*--color-primary: #101110/);
});

test("radius scales the Tailwind radius variables; 0 is square and 1 emits nothing", () => {
  assert.match(buildCss(resolveLook({ radius: 0 }, null, "/home")).css, /html:root \{\n {2}--radius-xs: 0;[\s\S]*--radius-3xl: 0;/);
  assert.match(buildCss(resolveLook({ radius: 0.5 }, null, "/home")).css, /--radius-xl: 0\.375rem;/);
  assert.equal(buildCss(resolveLook({ radius: 1 }, null, "/home")).css, "");
  const t = theme({ name: "T", radius: 0 });
  assert.equal(resolveLook({ radius: null }, t, "/home").radius, null);
});

test("vars apply to both modes, per-mode entries refine them, and bad names are dropped", () => {
  const look = resolveLook({ vars: { "--gap": "4px", "--edge": "1px", dark: { "--edge": "2px", "not-a-var": "x" } } }, null, "/home");
  assert.deepEqual(look.vars.light, { "--gap": "4px", "--edge": "1px" });
  assert.deepEqual(look.vars.dark, { "--gap": "4px", "--edge": "2px", "not-a-var": "x" });
  const { css, warnings } = buildCss(look);
  assert.match(css, /html:root\.dark \{[^}]*--edge: 2px;/);
  assert.match(css, /html:root:not\(\.dark\) \{[^}]*--edge: 1px;/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /vars\.dark\."not-a-var"/);
});

test("vars: null clears every mode; vars.dark / vars.light null clear only that mode", () => {
  const t = theme({ name: "T", vars: { "--gap": "4px", dark: { "--edge": "2px" }, light: { "--edge": "1px" } } });
  assert.deepEqual(resolveLook({ vars: null }, t, "/home").vars, { dark: {}, light: {} });

  const noDark = resolveLook({ vars: { dark: null } }, t, "/home").vars;
  assert.deepEqual(noDark.dark, {});
  assert.deepEqual(noDark.light, { "--gap": "4px", "--edge": "1px" });

  const noLight = resolveLook({ vars: { "--pad": "2px", light: null } }, t, "/home").vars;
  assert.deepEqual(noLight.dark, { "--gap": "4px", "--edge": "2px", "--pad": "2px" });
  assert.deepEqual(noLight.light, {});

  const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schema/theme.schema.json", import.meta.url)), "utf8")) as object;
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  for (const vars of [null, { dark: null }, { "--gap": "4px", light: null }]) {
    assert.ok(validate({ format: 1, name: "T", vars }), JSON.stringify(validate.errors));
  }
});

test("colors keys that are not color tokens are ignored with a warning", () => {
  const { css, warnings } = buildCss(resolveLook({ colors: { dark: { "--radius-xl": "0", "--color-panel": "#000" } } }, null, "/home"));
  assert.deepEqual(warnings, ['ignored colors.dark."--radius-xl": not a color token, move it to vars']);
  assert.match(css, /--color-panel: #000;/);
  assert.doesNotMatch(css, /--radius-xl/);
});

test("wallpaper: shared fields, per-mode refinement, per-mode removal, config override", () => {
  const t = theme({ name: "T", wallpaper: { dim: 0.2, dark: { image: "d.png" }, light: { image: "l.png", dim: 0 } } }, resolve("/themes/t"));
  const look = resolveLook({}, t, "/home");
  assert.equal(look.wallpaper.dark?.image, resolve("/themes/t/d.png"));
  assert.equal(look.wallpaper.dark?.dim, 0.2);
  assert.equal(look.wallpaper.light?.dim, 0);
  // a shared config field overrides both modes; `dark: null` removes only dark
  const overridden = resolveLook({ wallpaper: { image: "mine.png", dark: null } }, t, resolve("/home"));
  assert.equal(overridden.wallpaper.dark, null);
  assert.equal(overridden.wallpaper.light?.image, resolve("/home/mine.png"));
  assert.equal(overridden.wallpaper.light?.dim, 0);
});

test("different wallpapers per mode are scoped per mode and hidden behind the startup screen", () => {
  const home = mkdtempSync(join(tmpdir(), "zc-home-"));
  const both = buildCss(resolveLook({ wallpaper: { image: "a.png" } }, null, home)).css;
  assert.match(both, /^html body::before \{/m);
  assert.doesNotMatch(both, /zcode-startup-ready\)::before/);
  const split = buildCss(resolveLook({ wallpaper: { dark: { image: "d.png" }, light: { image: "l.png" } } }, null, home)).css;
  assert.match(split, /html:root\.dark body::before \{[\s\S]*d\.png/);
  assert.match(split, /html:root:not\(\.dark\) body::before \{[\s\S]*l\.png/);
  assert.match(split, /body:not\(\.zcode-startup-ready\)::before[^{]*\{\n {2}opacity: 0;/);
});

test("checkManifest flags newer formats, unknown fields and bad modes", () => {
  assert.deepEqual(checkManifest("t", { name: "T" }), []);
  assert.deepEqual(checkManifest("t", { format: 1, name: "T", modes: ["dark"] }), []);
  const warnings = checkManifest("t", { format: 2, name: "T", modes: ["dim" as never], colour: {} } as never);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0]!, /format 2/);
  assert.match(warnings[1]!, /unknown field "colour"/);
  assert.match(warnings[2]!, /modes/);
});

test("every built-in theme validates against schema/theme.schema.json and declares format 1", () => {
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schema/theme.schema.json", import.meta.url)), "utf8")) as object;
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  for (const entry of listThemes(mkdtempSync(join(tmpdir(), "zc-home-")), [builtinDir])) {
    assert.ok(validate(entry.manifest), `${entry.id}: ${JSON.stringify(validate.errors)}`);
    assert.equal(entry.manifest.format, 1, entry.id);
    assert.deepEqual(checkManifest(entry.id, entry.manifest), [], entry.id);
  }
});

// schema/theme.schema.json mirrors isSafeCssValue per field kind; this corpus keeps the two honest.
test("the schema's value defs accept and reject exactly what isSafeCssValue does", () => {
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schema/theme.schema.json", import.meta.url)), "utf8")) as object;
  const ajv = new Ajv2020({ allErrors: true });
  const defFor: Record<CssValueKind, string> = { color: "colorValue", image: "imageValue", position: "positionValue", vars: "cssValue" };
  const corpus = [
    "#101418",
    "rgba(150, 190, 255, 0.12)",
    "color-mix(in oklab, #d5deef 62%, transparent)",
    "linear-gradient(90deg, #fff500 0 10px, #101110 10px)",
    "repeating-conic-gradient(from 0deg, #000 0 10deg, #fff 10deg 20deg)",
    "center",
    "right bottom",
    "30% 50%",
    "calc(50% - 20px)",
    '"Segoe UI", sans-serif',
    "var(--color-primary)",
    "transparent",
    "red; } body { display:none",
    "url(https://evil)",
    "ur\\6c(https://evil)",
    "image-set(\"https://evil\" 1x)",
    "cross-fade(url(x) 50%, red)",
    "@import \"evil\"",
    "element(#shot)",
    "var (--x)",
    "xrgb(1)",
    "RGB(1, 2, 3)",
    "hsl(10 50% 50% / 0.5)",
    "oklch(0.5 0.1 200)",
  ];
  for (const kind of ["color", "image", "position", "vars"] as const) {
    const validate = ajv.compile({ $ref: `#/$defs/${defFor[kind]}`, $defs: (schema as { $defs: object }).$defs });
    for (const value of corpus) {
      assert.equal(
        validate(value),
        isSafeCssValue(value, kind),
        `${kind} value ${JSON.stringify(value)}: schema says ${validate(value)}, runtime says ${isSafeCssValue(value, kind)}`,
      );
    }
  }
});
