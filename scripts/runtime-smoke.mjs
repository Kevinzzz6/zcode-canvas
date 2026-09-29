#!/usr/bin/env node
// Isolated Electron integration fixture, no installed ZCode, user profile, network, or debug port.
// Run after build: node scripts/runtime-smoke.mjs
import electron from "electron";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (typeof electron === "string") {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electron, [fileURLToPath(import.meta.url)], { env, encoding: "utf8", timeout: 30000, windowsHide: true });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = electron;
console.log("runtime smoke: isolated Electron started");
const root = mkdtempSync(join(tmpdir(), "canvas-runtime-smoke-"));
const home = join(root, "canvas");
const page = join(root, "out", "renderer", "index.html");
mkdirSync(join(root, "out", "renderer"), { recursive: true });
mkdirSync(join(home, "imports", "wallpaper"), { recursive: true });
writeFileSync(page, '<!doctype html><html class="dark"><body class="zcode-startup-ready"><div id="root"><div id="surface" class="bg-background"><input aria-label="Editor" value="Continue coding"></div></div></body></html>');
writeFileSync(join(home, "imports", "wallpaper", "sample.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#8ba888"/></svg>');
for (const [id, primary, opacity, blur] of [["theme-a", "#112233", .64, 16], ["theme-b", "#445566", .78, 7]]) {
  const dir = join(home, "themes", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "theme.json"), JSON.stringify({ name: id, colors: { dark: { primary } }, glass: { opacity, blur } }));
}
const image = join(home, "imports", "wallpaper", "sample.svg");
writeFileSync(join(home, "config.json"), JSON.stringify({ enabled: true, theme: "theme-a", wallpaper: { image, dim: .35 } }));
const preload = join(root, "test-preload.cjs");
writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('testCanvas',{
  get:()=>ipcRenderer.invoke('zcode-canvas:panel-get'),
  apply:v=>ipcRenderer.invoke('zcode-canvas:panel-apply',v),
  preview:v=>ipcRenderer.invoke('zcode-canvas:panel-preview',v),
  select:id=>ipcRenderer.invoke('zcode-canvas:panel-select-wallpaper',id)
});`);
process.env.ZCODE_CANVAS_HOME = home;
app.setPath("userData", join(root, "profile"));
app.setPath("sessionData", join(root, "session"));
createRequire(import.meta.url)(resolve("dist/runtime/main.cjs"));
console.log("runtime smoke: runtime loaded");
// Do not top-level-await ready: Electron waits for its ESM entry to finish evaluating first.
void app.whenReady().then(async () => {
console.log("runtime smoke: app ready");
const windows = [];
try {
  for (const kind of [null, null, "settings"]) {
    const win = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { preload, sandbox: true, nodeIntegration: false, contextIsolation: true } });
    windows.push(win);
    await win.loadFile(page, kind ? { query: { windowKind: kind } } : {});
    console.log(`runtime smoke: page ready ${kind ?? "main"}`);
  }
  const [first, second, auxiliary] = windows;
  const evaluate = (win, code) => win.webContents.executeJavaScript(code);
  assert.equal(await evaluate(first, "!!document.querySelector('zcode-canvas-overlay')"), true);
  assert.equal(await evaluate(second, "!!document.querySelector('zcode-canvas-overlay')"), true);
  assert.equal(await evaluate(auxiliary, "!!document.querySelector('zcode-canvas-overlay')"), false);
  await assert.rejects(evaluate(auxiliary, "testCanvas.apply({dim:0.9})"), /refused/);
  await evaluate(first, "testCanvas.apply({dim:0.53})");
  for (const win of [first, second]) {
    assert.equal(await evaluate(win, "testCanvas.get().then(d=>d.config.wallpaper.dim)"), .53);
    assert.match(await evaluate(win, 'getComputedStyle(document.body,"::after").backgroundColor'), /0\.53/);
  }
  assert.equal(await evaluate(auxiliary, 'getComputedStyle(document.body,"::after").backgroundColor'), "rgba(0, 0, 0, 0)");
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  config.wallpaper.dim = .27;
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  await new Promise((resolve) => setTimeout(resolve, 600));
  for (const win of [first, second]) assert.match(await evaluate(win, 'getComputedStyle(document.body,"::after").backgroundColor'), /0\.27/);
  await assert.rejects(evaluate(first, "testCanvas.select('../outside.png')"), /invalid/);
  assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).wallpaper.dim, .27);

  // A preview request is a pure computation in the main process. It must not alter the config or
  // broadcast CSS to the other main window; committing the same request must produce that CSS.
  const previewInput = { glassOpacity: 1, glassBlur: 0, accent: "#d0387c" };
  const configBeforePreview = readFileSync(join(home, "config.json"), "utf8");
  const secondBeforePreview = await evaluate(second, `({
    primary: getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim(),
    blur: getComputedStyle(document.getElementById('surface')).backdropFilter
  })`);
  assert.equal(secondBeforePreview.blur, "blur(16px)");
  assert.equal(secondBeforePreview.primary, "#112233");
  const preview = await evaluate(first, `testCanvas.preview(${JSON.stringify(previewInput)})`);
  assert.match(preview.css, /--color-primary:\s*#d0387c/i);
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), configBeforePreview);
  assert.deepEqual(await evaluate(second, `({
    primary: getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim(),
    blur: getComputedStyle(document.getElementById('surface')).backdropFilter
  })`), secondBeforePreview);
  await evaluate(first, `testCanvas.apply(${JSON.stringify(previewInput)})`);
  assert.equal((await evaluate(first, "testCanvas.preview({})")).css, preview.css);
  assert.equal(await evaluate(second, "getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim()"), "#d0387c");
  assert.equal(await evaluate(second, "getComputedStyle(document.getElementById('surface')).backdropFilter"), "none", "opacity 1 and blur 0 must clear the old blur");

  await evaluate(first, "testCanvas.apply({ positionX: 22, positionY: 74, radius: 2 })");
  assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).wallpaper.position, "22% 74%");
  await evaluate(first, "testCanvas.apply({ theme: 'theme-b' })");
  let saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(saved.theme, "theme-b");
  assert.equal(saved.accent, "#d0387c");
  assert.equal(saved.glass.opacity, 1);
  assert.equal(saved.wallpaper.position, "22% 74%");
  assert.equal(await evaluate(second, "getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim()"), "#d0387c");

  await evaluate(first, "testCanvas.apply({ reset: 'theme' })");
  saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(saved.accent, undefined);
  assert.equal(saved.glass, undefined);
  assert.equal(saved.radius, undefined);
  assert.equal(saved.wallpaper.image, image);
  assert.equal(saved.wallpaper.position, "22% 74%");
  assert.equal(await evaluate(second, "getComputedStyle(document.getElementById('surface')).backdropFilter"), "blur(7px)");
  assert.equal(await evaluate(second, "getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim()"), "#445566");

  await evaluate(first, "testCanvas.apply({ blur: 9, unset: ['radius'] })");
  await evaluate(first, "testCanvas.apply({ unset: ['blur', 'positionX'] })");
  saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(saved.wallpaper.blur, undefined, "single reset removes one override");
  assert.equal(saved.wallpaper.position, "50% 74%", "one position axis follows the theme again");
  await assert.rejects(evaluate(first, "testCanvas.apply({ unset: ['image'] })"), /invalid unset/);
  assert.match(await evaluate(first, "testCanvas.get().then(d=>d.imageUrl.dark)"), /^file:.*sample\.svg$/);

  await evaluate(first, "testCanvas.apply({ reset: 'wallpaper' })");
  saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(saved.wallpaper.image, image);
  assert.equal(saved.wallpaper.position, undefined);
  assert.equal(saved.wallpaper.dim, undefined);
  assert.equal(saved.theme, "theme-b");
  console.log(JSON.stringify({ passed: true, mainWindows: 2, auxiliaryExcluded: true, untrustedSenderRefused: true, globalWriteAndWatcherSynced: true, previewPureAndExact: true, personalControlsAndResets: true, singleResets: true }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const win of windows) win.destroy();
  app.exit(process.exitCode ?? 0);
}
}).catch((error) => { console.error(error); app.exit(1); });
