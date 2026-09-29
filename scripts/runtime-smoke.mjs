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
writeFileSync(page, '<!doctype html><html class="dark"><body class="zcode-startup-ready"><input aria-label="Editor" value="Continue coding"></body></html>');
writeFileSync(join(home, "imports", "wallpaper", "sample.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#8ba888"/></svg>');
writeFileSync(join(home, "config.json"), JSON.stringify({ enabled: true, wallpaper: { image: join(home, "imports", "wallpaper", "sample.svg"), dim: .35 } }));
const preload = join(root, "test-preload.cjs");
writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('testCanvas',{
  get:()=>ipcRenderer.invoke('zcode-canvas:panel-get'),
  apply:v=>ipcRenderer.invoke('zcode-canvas:panel-apply',v),
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
  console.log(JSON.stringify({ passed: true, mainWindows: 2, auxiliaryExcluded: true, untrustedSenderRefused: true, globalWriteAndWatcherSynced: true }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const win of windows) win.destroy();
  app.exit(process.exitCode ?? 0);
}
}).catch((error) => { console.error(error); app.exit(1); });
