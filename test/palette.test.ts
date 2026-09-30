import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { buildCss, isSafeCssValue } from "../src/shared/css.ts";
import { BLUR_REGIONS, BLURRED_SURFACES, mainCappedByFrame, regionAlphas, regionHighlightCss, type GlassRegion, type ResolvedRegion } from "../src/shared/glass.ts";
import { resolveLook, type ThemeEntry } from "../src/shared/look.ts";
import { contrastRatio, extractColors, filteredBackdrop, generatePalette, PALETTE_VARIANTS } from "../src/shared/palette.ts";

const theme = (manifest: ThemeEntry["manifest"]): ThemeEntry => ({ id: "t", dir: "/themes/t", builtin: true, manifest });
const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schema/theme.schema.json", import.meta.url)), "utf8")) as object;

/** Hue in degrees of a #rrggbb color, via the CSS hsl model (enough to tell hues apart). */
function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
const saturation = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(r!, g!, b!) - Math.min(r!, g!, b!);
};

test("palettes are only generated from #rrggbb seeds", () => {
  for (const seed of ["", "red", "#abc", "#12345g", "url(x)", "#1234567"]) assert.equal(generatePalette({ seed }), null, seed);
  assert.ok(generatePalette({ seed: "#5EEAD4" }));
});

test("every variant keeps text readable on the surfaces it sits on, in both modes", () => {
  for (const seed of ["#5eead4", "#ff4d6d", "#fde047", "#1e3a8a", "#808080", "#000000", "#ffffff"]) {
    for (const variant of PALETTE_VARIANTS) {
      const palette = generatePalette({ seed, variant })!;
      for (const mode of ["dark", "light"] as const) {
        const c = palette.colors[mode];
        const label = `${seed} ${variant} ${mode}`;
        const strict = variant === "contrast";
        for (const surface of ["background", "card", "background-win-alt", "secondary"]) {
          assert.ok(contrastRatio(c.foreground!, c[surface]!) >= (strict ? 12 : 7), `${label}: foreground on ${surface}`);
        }
        for (const surface of ["background", "card"]) {
          assert.ok(contrastRatio(c["foreground-subtle"]!, c[surface]!) >= (strict ? 7 : 4.5), `${label}: subtle on ${surface}`);
          assert.ok(contrastRatio(c.brand!, c[surface]!) >= (strict ? 7 : 4.5), `${label}: brand on ${surface}`);
        }
        assert.ok(contrastRatio(c["foreground-subtlest"]!, c.background!) >= (strict ? 4.5 : 3), `${label}: subtlest`);
        for (const [fg, bg] of [["primary-foreground", "primary"], ["success-foreground", "success"], ["warning-foreground", "warning"], ["destructive-foreground", "destructive"]] as const)
          assert.ok(contrastRatio(c[fg]!, c[bg]!) >= 4.5, `${label}: ${fg} on ${bg}`);
        for (const [key, value] of Object.entries(c)) assert.ok(isSafeCssValue(value, "color"), `${label}: ${key} = ${value}`);
      }
    }
  }
});

test("the palette follows the seed's hue; a gray seed stays monochrome; OLED is true black", () => {
  const teal = generatePalette({ seed: "#14b8a6" })!.colors.dark;
  assert.ok(hueGap(hue(teal.brand!), hue("#14b8a6")) < 15, `brand hue ${hue(teal.brand!)}`);
  assert.ok(hueGap(hue(teal.background!), hue("#14b8a6")) < 25, "surfaces are tinted towards the seed");
  const gray = generatePalette({ seed: "#7f7f7f", variant: "vivid" })!.colors.dark;
  assert.ok(saturation(gray.brand!) <= 6, `gray seed brand ${gray.brand}`);
  const oled = generatePalette({ seed: "#8b5cf6", variant: "oled" })!.colors;
  assert.equal(oled.dark.background, "#000000");
  assert.equal(oled.dark["background-win-alt"], "#000000");
  assert.notEqual(oled.light.background, "#000000");
  const vivid = generatePalette({ seed: "#8b5cf6", variant: "vivid" })!.colors.dark;
  const soft = generatePalette({ seed: "#8b5cf6", variant: "soft" })!.colors.dark;
  assert.ok(saturation(vivid.brand!) > saturation(soft.brand!), "vivid is more colorful than soft");
});

test("text is pushed further from a bright wallpaper showing through, and reports when it cannot keep up", () => {
  const plain = generatePalette({ seed: "#60a5fa" })!;
  assert.deepEqual(plain.readability, { dark: null, light: null });
  const bright = { color: "#d8d8d0", frameAlpha: 0.35, mainAlpha: 0.23 };
  const guarded = generatePalette({ seed: "#60a5fa" }, { dark: bright })!;
  const seen = guarded.readability.dark!;
  assert.ok(seen.contrast > 0, "contrast is reported for the guarded mode");
  assert.equal(guarded.readability.light, null);
  assert.ok(contrastRatio(guarded.colors.dark.foreground!, "#000000") >= contrastRatio(plain.colors.dark.foreground!, "#000000"), "text got lighter, not darker");
  const hopeless = generatePalette({ seed: "#60a5fa" }, { dark: { color: "#ffffff", frameAlpha: 0.05, mainAlpha: 0 } })!;
  assert.equal(hopeless.readability.dark?.ok, false);
  const dimmed = generatePalette({ seed: "#60a5fa" }, { dark: { color: filteredBackdrop("#ffffff", 1, 0.8, null, "dark"), frameAlpha: 0.35, mainAlpha: 0.23 } })!;
  assert.equal(dimmed.readability.dark?.ok, true, "a dim overlay makes the same wallpaper readable");
});

test("filteredBackdrop applies the wallpaper's brightness and dim overlay", () => {
  assert.equal(filteredBackdrop("#808080", 0.5, 0, null, "dark"), "#404040");
  assert.equal(filteredBackdrop("#808080", 1, 1, null, "dark"), "#000000");
  assert.equal(filteredBackdrop("#808080", 1, 1, null, "light"), "#ffffff");
  assert.equal(filteredBackdrop("#808080", 1, 1, "#ff0000", "dark"), "#ff0000");
  assert.equal(filteredBackdrop("#808080", 1, 1, "rgba(1,2,3,1)", "dark"), "#000000", "non-hex overlays fall back to the mode default");
});

/** RGBA bytes: `share` of the pixels in the first color, the rest in the second. */
function image(first: [number, number, number], second: [number, number, number], share: number, size = 400): Uint8ClampedArray {
  const bytes = new Uint8ClampedArray(size * 4);
  for (let i = 0; i < size; i++) bytes.set([...(i < size * share ? first : second), 255], i * 4);
  return bytes;
}

test("seeds come from the image's dominant hues, strongest first, and gray images give one neutral seed", () => {
  const found = extractColors(image([37, 99, 235], [249, 115, 22], 0.7))!;
  assert.ok(found.seeds.length >= 2);
  assert.ok(hueGap(hue(found.seeds[0]!), 221) < 20, `first seed ${found.seeds[0]} is the blue`);
  assert.ok(found.seeds.some((seed) => hueGap(hue(seed), 25) < 20), `an orange seed in ${found.seeds}`);
  const grayish = extractColors(image([120, 120, 120], [30, 30, 30], 0.5))!;
  assert.equal(grayish.seeds.length, 1);
  assert.ok(saturation(grayish.seeds[0]!) <= 6);
  assert.equal(grayish.average, "#4b4b4b");
  // A small colorful accent in a mostly gray image is still worth a seed.
  const accent = extractColors(image([220, 38, 38], [110, 110, 110], 0.05))!;
  assert.ok(hueGap(hue(accent.seeds[0]!), 0) < 20);
  assert.equal(extractColors(new Uint8ClampedArray(64)), null, "fully transparent");
  assert.ok(extractColors(image([37, 99, 235], [249, 115, 22], 0.5), 1)!.seeds.length === 1, "maxSeeds is honored");
});

const regions = (values: Partial<Record<GlassRegion, number>>, fallback = 0.5): Record<GlassRegion, ResolvedRegion> => ({
  frame: { opacity: values.frame ?? fallback, blur: 0 },
  main: { opacity: values.main ?? fallback, blur: 0 },
  card: { opacity: values.card ?? fallback, blur: 0 },
  input: { opacity: values.input ?? fallback, blur: 0 },
});

test("region alphas reproduce the global formula and handle an opaque or clearer-than-frame main", () => {
  const same = regionAlphas(regions({}));
  assert.equal(same.frame, 0.35);
  assert.equal(Math.round(same.main * 1000) / 10, 23.1, "frame 35% + main together show 50%");
  assert.equal(same.card, 0.75);
  assert.deepEqual(regionAlphas(regions({}, 1)), { frame: 1, main: 1, card: 1, input: 1 });
  assert.equal(regionAlphas(regions({ frame: 1, main: 0.5 })).main, 0.5, "over an opaque frame the main alpha is its own");
  assert.equal(regionAlphas(regions({ frame: 0.8, main: 0.2 })).main, 0, "cannot look clearer than the frame under it");
  assert.equal(mainCappedByFrame(regions({ frame: 0.8, main: 0.2 })), true);
  assert.equal(mainCappedByFrame(regions({})), false);
  assert.equal(mainCappedByFrame(regions({ frame: 0.4, main: 0.9 })), false);
});

test("per-region glass writes its own alphas and blur, and untouched regions keep the official color", () => {
  const { css } = buildCss(resolveLook({ glass: { opacity: 0.5, blur: 12, regions: { frame: { opacity: 0.3 }, input: { opacity: 1 }, card: { blur: 30 } } } }, null, "/home"));
  assert.match(css, /--color-sidebar: color-mix\(in srgb, var\(--zc-src-sidebar\) 21%, transparent\)/);
  // main 50% over a 21% frame: 1 - 0.5 / 0.79
  assert.match(css, /--color-background: color-mix\(in srgb, var\(--zc-src-background\) 36\.7%, transparent\)/);
  assert.match(css, /--color-card: color-mix\(in srgb, var\(--zc-src-card\) 75%, transparent\)/);
  assert.doesNotMatch(css, /--color-input:|--color-input-focused:/, "an opaque region is left alone");
  assert.match(css, /#root \.bg-background,\n#root \.bg-panel \{\n {2}backdrop-filter: blur\(12px\)/);
  assert.match(css, /#root \.bg-card \{\n {2}backdrop-filter: blur\(30px\)/);
  assert.doesNotMatch(css, /\.bg-input/);

  const onlyMain = buildCss(resolveLook({ glass: { regions: { main: { opacity: 0.6, blur: 8 } } } }, null, "/home")).css;
  assert.doesNotMatch(onlyMain, /--color-background-win-alt: color-mix/, "global opacity 1 keeps the frame opaque");
  assert.match(onlyMain, /--color-background: color-mix\(in srgb, var\(--zc-src-background\) 60%, transparent\)/);
  assert.match(onlyMain, /#root \.bg-background,\n#root \.bg-panel \{\n {2}backdrop-filter: blur\(8px\)/);
});

test("a region highlight outlines exactly the surfaces its blur is written for", () => {
  assert.equal(regionHighlightCss(null), "");
  const selectorsOf = (rule: string) => rule.slice(0, rule.indexOf(" {")).split(",\n");
  assert.deepEqual(selectorsOf(regionHighlightCss("frame")), ["#root [data-desktop-window-frame]"]);
  for (const region of BLUR_REGIONS) {
    const rule = regionHighlightCss(region);
    assert.deepEqual(selectorsOf(rule), BLURRED_SURFACES[region].map((s) => `#root ${s}`), region);
    // The same selectors the generated sheet blurs, so the two cannot drift apart.
    const { css } = buildCss(resolveLook({ glass: { opacity: 1, blur: 0, regions: { [region]: { opacity: 0.5, blur: 7 } } } }, null, "/home"));
    assert.ok(css.includes(`${selectorsOf(rule).join(",\n")} {\n  backdrop-filter: blur(7px)`), region);
  }
  for (const region of ["frame", ...BLUR_REGIONS] as const) {
    const rule = regionHighlightCss(region);
    assert.match(rule, /outline: 2px solid var\(--color-primary\) !important;\n {2}outline-offset: -2px !important;/, region);
    assert.doesNotMatch(rule, /url\(|@|animation|transition/, "constant, layout-neutral and motionless");
  }
});

test("the focused prompt input stays as translucent as the unfocused one", () => {
  const { css } = buildCss(resolveLook({ glass: { opacity: 0.5 } }, null, "/home"));
  assert.match(css, /--color-input-focused: color-mix\(in srgb, var\(--zc-src-input-focused\) 75%, transparent\)/);
});

test("regions merge region by region and field by field across theme and config", () => {
  const t = theme({ name: "T", glass: { opacity: 0.6, blur: 10, regions: { main: { opacity: 0.8, blur: 4 }, card: { opacity: 0.9 } } } });
  const look = resolveLook({ glass: { regions: { main: { blur: 20 }, frame: { opacity: 0.3 } } } }, t, "/home");
  assert.deepEqual(look.glass.regions, {
    frame: { opacity: 0.3, blur: 0 },
    main: { opacity: 0.8, blur: 20 },
    card: { opacity: 0.9, blur: 10 },
    input: { opacity: 0.6, blur: 10 },
  });
  assert.equal(resolveLook({ glass: { regions: { main: { opacity: 7 } } } }, null, "/home").glass.regions.main.opacity, 1, "clamped");
});

test("a palette recolors the layers below it and is refined by colors of its own layer and above", () => {
  const t = theme({ name: "T", colors: { dark: { background: "#101010", "--color-card": "#202020" } } });
  const user = resolveLook({ palette: { seed: "#ff4d6d" } }, t, "/home");
  const generated = generatePalette({ seed: "#ff4d6d" })!.colors.dark;
  assert.equal(user.colors.dark.background, generated.background, "a user palette replaces the theme's colors");
  assert.equal(user.palette?.seed, "#ff4d6d");
  assert.equal(user.palette?.variant, "natural");

  const refined = resolveLook({}, theme({ name: "T", palette: { seed: "#ff4d6d" }, colors: { dark: { background: "#101010" } } }), "/home");
  assert.equal(refined.colors.dark.background, "#101010", "a theme's colors refine its own palette");
  assert.equal(refined.colors.dark.card, generated.card);

  const personal = resolveLook({ palette: { seed: "#ff4d6d" }, colors: { dark: { panel: "#333333" } } }, t, "/home");
  assert.equal(personal.colors.dark.panel, "#333333", "user colors refine the user palette");

  const removed = resolveLook({ palette: null }, theme({ name: "T", palette: { seed: "#ff4d6d" } }), "/home");
  assert.equal(removed.palette, null);
  assert.deepEqual(removed.colors, { dark: {}, light: {} });

  const invalid = resolveLook({ palette: { seed: "red" } }, null, "/home");
  assert.equal(invalid.palette, null, "an unusable seed is ignored");

  const accented = buildCss(resolveLook({ palette: { seed: "#ff4d6d" }, accent: "#204080" }, null, "/home")).css;
  assert.match(accented, /--color-primary: #204080/, "a personal accent still wins over the palette's primary");
  assert.deepEqual(buildCss(resolveLook({ palette: { seed: "#ff4d6d", variant: "vivid" } }, null, "/home")).warnings, []);
});

test("the readability check runs only with a backdrop, a wallpaper and a translucent main pane", () => {
  const home = "/home";
  const base = { palette: { seed: "#60a5fa", backdrop: "#e8e8e8" }, wallpaper: { image: "a.png", dim: 0 } };
  assert.equal(resolveLook({ ...base, glass: { opacity: 0.5 } }, null, home).palette?.readability.dark?.ok !== undefined, true);
  assert.deepEqual(resolveLook(base, null, home).palette?.readability, { dark: null, light: null }, "opaque surfaces hide the wallpaper");
  assert.deepEqual(resolveLook({ palette: { seed: "#60a5fa", backdrop: "#e8e8e8" }, glass: { opacity: 0.5 } }, null, home).palette?.readability, { dark: null, light: null }, "no wallpaper, nothing to check");
  const dimmer = resolveLook({ ...base, glass: { opacity: 0.5 }, wallpaper: { image: "a.png", brightness: 0.3 } }, null, home).palette!.readability.dark!;
  const brighter = resolveLook({ ...base, glass: { opacity: 0.5 } }, null, home).palette!.readability.dark!;
  assert.ok(dimmer.contrast >= brighter.contrast, "a darker wallpaper reads better");
});

test("the schema accepts palettes and glass regions and rejects what the runtime would ignore", () => {
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  const ok = [
    { palette: { seed: "#5eead4" } },
    { palette: { seed: "#5EEAD4", variant: "oled", backdrop: "#101010" } },
    { palette: null },
    { glass: { regions: { frame: { opacity: 0.3 }, main: { opacity: 0.5, blur: 12 }, card: {}, input: { blur: 0 } } } },
  ];
  for (const extra of ok) assert.ok(validate({ format: 1, name: "T", ...extra }), `${JSON.stringify(extra)}: ${JSON.stringify(validate.errors)}`);
  const bad = [
    { palette: { seed: "red" } },
    { palette: { seed: "#5eead4", variant: "neon" } },
    { palette: { variant: "soft" } },
    { palette: { seed: "#5eead4", extra: 1 } },
    { glass: { regions: { frame: { blur: 4 } } } },
    { glass: { regions: { sidebar: { opacity: 0.5 } } } },
    { glass: { regions: { main: { opacity: 2 } } } },
  ];
  for (const extra of bad) assert.ok(!validate({ format: 1, name: "T", ...extra }), JSON.stringify(extra));
});
