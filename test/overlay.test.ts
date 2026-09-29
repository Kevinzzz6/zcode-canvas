import assert from "node:assert/strict";
import { test } from "node:test";
import { createPreviewController } from "../src/runtime/preview-controller.ts";
import { diagnose, displayNumber, formatKnob, fromSlider, inputKey, parseKnobInput, positionSlack, positionValue, SLIDER_SPAN, stepKnob, toSlider, trackFraction, type DiagnosisInput } from "../src/runtime/overlay-preview.ts";
import type { ResolvedWallpaper } from "../src/shared/look.ts";
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

test("position percentages and brightness ratios use their respective display scales", () => {
  assert.equal(formatKnob("positionX", 25), "25%");
  assert.equal(formatKnob("positionY", 75), "75%");
  assert.equal(formatKnob("brightness", .61), "61%");
  assert.equal(formatKnob("transparency", 55), "55%");
  assert.equal(formatKnob("glassBlur", 18), "18px");
});

test("position controls preserve CSS keyword axis semantics", () => {
  for (const [value, x, y] of [["top", 50, 0], ["right", 100, 50], ["top left", 0, 0], ["center bottom", 50, 100], ["25% 75%", 25, 75]] as const) {
    assert.equal(positionValue(value, 0), x);
    assert.equal(positionValue(value, 1), y);
  }
});

test("blur and zoom tracks give the common low range most of their length", () => {
  assert.equal(fromSlider("blur", SLIDER_SPAN / 2), 50, "half the track is only a quarter of the blur range");
  assert.ok(fromSlider("blur", SLIDER_SPAN * .1) <= 2, "the first tenth stays within a couple of pixels");
  assert.equal(fromSlider("scale", SLIDER_SPAN * .25), 1, "100% zoom sits at the knee");
  assert.ok(fromSlider("scale", SLIDER_SPAN * .68) <= 2.05, "100–200% takes almost half of the track");
  // Curved tracks move in whole positions; every value a user can type must still be reachable.
  for (const [key, value] of [["blur", 37], ["glassBlur", 18], ["scale", 1.5], ["scale", .4]] as const)
    assert.equal(fromSlider(key, Math.round(toSlider(key, value))), value, `${key} ${value} round-trips through the slider`);
  assert.equal(toSlider("brightness", .61), .61, "linear controls keep their own units");
  assert.equal(trackFraction("scale", 1), .25);
  assert.equal(trackFraction("transparency", 55), .55);
});

test("typed values use the displayed unit and are clamped to the control's range", () => {
  assert.deepEqual(parseKnobInput("brightness", "100"), { value: 1, clamped: false });
  assert.deepEqual(parseKnobInput("brightness", "61%"), { value: .61, clamped: false });
  assert.deepEqual(parseKnobInput("glassBlur", " 18px "), { value: 18, clamped: false });
  assert.deepEqual(parseKnobInput("scale", "150"), { value: 1.5, clamped: false });
  assert.deepEqual(parseKnobInput("radius", "1,5×"), { value: 1.5, clamped: false });
  assert.deepEqual(parseKnobInput("transparency", "55"), { value: 55, clamped: false });
  assert.deepEqual(parseKnobInput("blur", "999"), { value: 200, clamped: true });
  assert.deepEqual(parseKnobInput("scale", "0"), { value: .1, clamped: true });
  for (const text of ["", "abc", "1e3", "--1"]) assert.equal(parseKnobInput("blur", text), null, text);
  assert.equal(displayNumber("brightness", .61), 61);
  assert.equal(displayNumber("positionY", 75), 75);
  assert.equal(stepKnob("blur", 3, 1, false), 4, "keyboard steps stay 1px on a curved track");
  assert.equal(stepKnob("scale", 1, -1, true), .9);
  assert.equal(stepKnob("blur", 199, 1, true), 200);
  assert.equal(inputKey("transparency"), "glassOpacity");
  assert.equal(inputKey("blur"), "blur");
});

const wallpaper: ResolvedWallpaper = { image: "/w/a.jpg", fit: "cover", position: "center", blur: 0, dim: 0, overlay: null, scale: 1, saturate: 1, brightness: 1, contrast: 1, grayscale: 0 };
const wide = { width: 1600, height: 900 };
const state = (patch: Partial<DiagnosisInput> = {}): DiagnosisInput =>
  ({ wallpaper, transparency: 40, fit: "cover", scale: 1, blur: 0, image: wide, viewport: { width: 1200, height: 800 }, ...patch });

test("position slack follows how the fit crops the image in this window", () => {
  const viewport = { width: 1200, height: 800 };
  assert.deepEqual(positionSlack("cover", 1, 0, wide, viewport), { x: true, y: false }, "a wide image is cropped left/right only");
  assert.deepEqual(positionSlack("contain", 1, 0, wide, viewport), { x: false, y: true }, "letterboxed top/bottom");
  assert.deepEqual(positionSlack("cover", 1, 0, { width: 600, height: 400 }, viewport), { x: false, y: false }, "same aspect ratio");
  assert.deepEqual(positionSlack("fill", 1, 0, wide, viewport), { x: false, y: false });
  assert.deepEqual(positionSlack("fill", 1.5, 0, wide, viewport), { x: true, y: true }, "a zoom anchors at the position");
  assert.deepEqual(positionSlack("tile", 1, 0, null, viewport), { x: true, y: true });
  assert.equal(positionSlack("cover", 1, 0, null, viewport), null, "unknown size claims nothing");
  assert.deepEqual(positionSlack("center", 1, 0, { width: 1200, height: 400 }, viewport), { x: false, y: true });
});

test("diagnosis explains controls whose effect is hidden instead of leaving them silent", () => {
  const clear = diagnose(state());
  assert.deepEqual(clear.disabled, {});
  assert.equal(clear.hints.primary, null);
  assert.match(clear.hints.wallpaper!, /垂直位置不会变化/);

  const opaque = diagnose(state({ transparency: 0 }));
  assert.ok(opaque.disabled.glassBlur, "glass blur is only emitted for translucent surfaces");
  assert.match(opaque.hints.primary!, /壁纸被遮住.*界面透明/);
  assert.match(opaque.hints.wallpaper!, /遮住/);
  assert.match(opaque.hints.material!, /不透明/);

  const bare = diagnose(state({ wallpaper: null }));
  assert.ok(bare.disabled.brightness && bare.disabled.blur && bare.disabled.positionX);
  assert.equal(bare.disabled.transparency, undefined);
  assert.match(bare.hints.wallpaper!, /先在上方选择/);
  assert.equal(bare.hints.material, null, "nothing covers the material");

  const fill = diagnose(state({ fit: "fill" }));
  assert.ok(fill.disabled.positionX && fill.disabled.positionY);
  assert.equal(diagnose(state({ fit: "fill", scale: 1.2 })).disabled.positionX, undefined);
  assert.match(diagnose(state({ image: { width: 600, height: 400 } })).hints.wallpaper!, /正好铺满/);
  assert.match(diagnose(state({ wallpaper: null, transparency: 0 })).hints.primary!, /界面模糊才生效/);
});

test("region controls map to their requests and say when layering hides their effect", () => {
  assert.equal(inputKey("frameTransparency"), "frameOpacity");
  assert.equal(inputKey("mainBlur"), "mainBlur");
  assert.equal(formatKnob("cardTransparency", 35), "35%");
  assert.deepEqual(parseKnobInput("inputTransparency", "40"), { value: 40, clamped: false });

  const opaqueFrame = diagnose(state({ regions: { frame: 0, main: 40, card: 40, input: 40 } }));
  assert.match(opaqueFrame.hints.region!, /侧栏是整个窗口的底层/);
  assert.match(opaqueFrame.hints.primary!, /侧栏不透明，壁纸被遮住/);
  assert.equal(opaqueFrame.disabled.glassBlur, undefined, "other regions are still translucent");

  const capped = diagnose(state({ regions: { frame: 20, main: 80, card: 40, input: 40 } }));
  assert.match(capped.hints.region!, /最多和侧栏一样透明/);
  assert.equal(diagnose(state({ regions: { frame: 60, main: 40, card: 40, input: 40 } })).hints.region, null);

  const opaqueInput = diagnose(state({ regions: { frame: 40, main: 40, card: 40, input: 0 } }));
  assert.ok(opaqueInput.disabled.inputBlur);
  assert.equal(opaqueInput.disabled.mainBlur, undefined);
  assert.ok(diagnose(state({ regions: { frame: 0, main: 0, card: 0, input: 0 } })).disabled.glassBlur);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("whole-sheet preview restores the newest persisted CSS from any window", async () => {
  const sheets: string[] = [];
  const controller = createPreviewController(async () => ({ css: "preview without blur" }), (css) => sheets.push(css));
  controller.setBase("persisted blur 18");
  await controller.preview({ glassBlur: 0 });
  controller.setBase("another window changed the theme");
  assert.equal(sheets.at(-1), "preview without blur");
  controller.clear();
  assert.equal(sheets.at(-1), "another window changed the theme");
});

test("coalesces slider requests and never paints an outdated response", async () => {
  const responses = [deferred<{ css: string }>(), deferred<{ css: string }>()];
  const inputs: unknown[] = [];
  const sheets: string[] = [];
  const controller = createPreviewController((input) => { inputs.push(input); return responses[inputs.length - 1]!.promise; }, (css) => sheets.push(css));
  controller.setBase("base");
  const first = controller.preview({ glassOpacity: .5 });
  const superseded = controller.preview({ glassOpacity: .6 });
  const latest = controller.preview({ glassOpacity: .7 });
  await superseded;
  assert.equal(inputs.length, 1);
  responses[0]!.resolve({ css: "outdated" });
  await first;
  assert.deepEqual(inputs, [{ glassOpacity: .5 }, { glassOpacity: .7 }]);
  assert.deepEqual(sheets, ["base"]);
  responses[1]!.resolve({ css: "latest" });
  await latest;
  assert.equal(sheets.at(-1), "latest");
});

test("clear invalidates late previews and cancels queued work after a commit", async () => {
  const response = deferred<{ css: string }>();
  const sheets: string[] = [];
  let calls = 0;
  const controller = createPreviewController(() => { calls++; return response.promise; }, (css) => sheets.push(css));
  controller.setBase("base");
  const first = controller.preview({ brightness: .5 });
  const queued = controller.preview({ brightness: .6 });
  controller.setBase("committed brightness .6");
  controller.clear();
  response.resolve({ css: "late brightness .5" });
  await Promise.all([first, queued]);
  assert.equal(calls, 1);
  assert.equal(sheets.at(-1), "committed brightness .6");
  assert.ok(!sheets.includes("late brightness .5"));
});

test("failed or malformed previews restore CSS and allow subsequent requests", async () => {
  const sheets: string[] = [];
  let calls = 0;
  const controller = createPreviewController(async () => {
    calls++;
    if (calls === 1) throw new Error("IPC failed");
    if (calls === 2) return {} as { css: string };
    return { css: "recovered" };
  }, (css) => sheets.push(css));
  controller.setBase("persisted");
  await assert.rejects(controller.preview({ brightness: 1.1 }), /IPC failed/);
  assert.equal(sheets.at(-1), "persisted");
  await assert.rejects(controller.preview({ brightness: 1.2 }), /invalid preview/);
  assert.equal(sheets.at(-1), "persisted");
  await controller.preview({ brightness: 1.3 });
  assert.equal(sheets.at(-1), "recovered");
});

test("failed restore rejects caller without an unhandled drain rejection", async () => {
  const controller = createPreviewController(async () => { throw new Error("IPC failed"); }, () => { throw new Error("style unavailable"); });
  await assert.rejects(controller.preview({ glassBlur: 0 }), /style unavailable/);
});
