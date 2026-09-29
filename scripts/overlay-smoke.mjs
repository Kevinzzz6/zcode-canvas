#!/usr/bin/env node
// Development only, like cdp.mjs: exercise the REAL isolated sandbox and its closed shadow root.
// Never targets an installed/user ZCode. Requires scripts/sandbox.mjs and an imported test library.
// node scripts/overlay-smoke.mjs [sandbox-directory] [port]
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const sandbox = resolve(process.argv[2] ?? "../_sandbox");
const port = Number(process.argv[3] ?? 9555);
const prefix = pathToFileURL(join(sandbox, "ZCode")).href.toLowerCase() + "/";
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((t) => t.type === "page" && t.url.toLowerCase().startsWith(prefix) && /out\/renderer\/index\.html/.test(t.url) && !t.url.includes("windowKind="));
assert.ok(target, "only the explicitly named sandbox may be tested");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = (event) => { const result = JSON.parse(event.data); if (pending.has(result.id)) { pending.get(result.id)(result); pending.delete(result.id); } };
async function send(method, params = {}) {
  const next = ++id;
  const response = await Promise.race([
    new Promise((resolve) => { pending.set(next, resolve); ws.send(JSON.stringify({ id: next, method, params })); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000); timer.unref(); }),
  ]);
  if (response.error) throw new Error(JSON.stringify(response.error));
  return response.result;
}
const pause = (ms = 350) => new Promise((resolve) => setTimeout(resolve, ms));
const doc = await send("DOM.getDocument", { depth: -1, pierce: true });
function find(node) {
  if (node.nodeName === "ZCODE-CANVAS-OVERLAY") return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) { const found = find(child); if (found) return found; }
}
const overlay = find(doc.root);
assert.ok(overlay?.shadowRoots?.[0], "overlay mounted with shadow isolation");
const remote = await send("DOM.resolveNode", { backendNodeId: overlay.shadowRoots[0].backendNodeId });
async function ui(body) {
  const result = await send("Runtime.callFunctionOn", { objectId: remote.object.objectId, functionDeclaration: `function(){${body}}`, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const home = join(sandbox, "home", ".zcode-canvas");
const configFile = join(home, "config.json");
const original = readFileSync(configFile, "utf8");
const prefs = await ui('return localStorage.getItem("zcode-canvas:entry:v1")');
try {
  await ui('if(this.getElementById("panel").hidden)this.querySelector(".entry").click()');
  await pause();
  assert.equal(await ui('return this.getElementById("panel").hidden'), false);
  const count = await ui('return this.querySelectorAll(".tile").length');
  assert.ok(count > 0, "sandbox library is present");
  const selection = await ui('const tile=this.querySelector(".tile"); tile.click(); return tile.dataset.id');
  await pause();
  assert.ok(JSON.parse(readFileSync(configFile, "utf8")).wallpaper.image.endsWith(selection));
  assert.equal(await ui('return this.querySelector(".tile[aria-pressed=true]").dataset.id'), selection);
  const saved = readFileSync(configFile, "utf8");
  await ui('const slider=this.getElementById("dim");slider.value="0.61";slider.dispatchEvent(new Event("input",{bubbles:true}))');
  assert.equal(readFileSync(configFile, "utf8"), saved, "drag preview must not write config");
  assert.match(await ui('return getComputedStyle(document.body,"::after").backgroundColor'), /0\.61/);
  await ui('this.getElementById("dim").dispatchEvent(new Event("change",{bubbles:true}))');
  await pause();
  assert.equal(JSON.parse(readFileSync(configFile, "utf8")).wallpaper.dim, .61);

  // Force a real failed write by making the existing config unreadable to the handler.
  const beforeFailure = readFileSync(configFile, "utf8");
  writeFileSync(configFile, "{");
  await ui('const slider=this.getElementById("dim");slider.value="0.2";slider.dispatchEvent(new Event("input",{bubbles:true}));slider.dispatchEvent(new Event("change",{bubbles:true}))');
  await pause();
  assert.match(await ui('return this.getElementById("status").textContent'), /未能应用|暂时无法/);
  assert.equal(await ui('return this.getElementById("dim").value'), "0.61", "failed save restores slider");
  assert.match(await ui('return getComputedStyle(document.body,"::after").backgroundColor'), /0\.61/, "failed save clears preview CSS");
  writeFileSync(configFile, beforeFailure);
  await pause();

  const sliderPoint = await ui('const r=this.getElementById("dim").getBoundingClientRect();return {x:r.x+r.width*.5,y:r.y+r.height/2}');
  const beforeDrag = readFileSync(configFile, "utf8");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...sliderPoint });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...sliderPoint, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sliderPoint.x - 20, y: sliderPoint.y, button: "left", buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 500, y: sliderPoint.y, button: "left", buttons: 1 });
  assert.equal(readFileSync(configFile, "utf8"), beforeDrag, "real pointer drag still does not save");
  assert.equal(await ui('return this.getElementById("panel").hidden'), false, "drag outside keeps the panel open");
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 500, y: sliderPoint.y, button: "left", clickCount: 1 });
  await pause();
  assert.equal(JSON.parse(readFileSync(configFile, "utf8")).wallpaper.dim, 0, "release outside commits captured slider");
  await ui('const s=this.getElementById("dim");s.value="0.61";s.dispatchEvent(new Event("input",{bubbles:true}));s.dispatchEvent(new Event("change",{bubbles:true}))');
  await pause();

  // Visit all rows: each loaded GIF becomes a static canvas and releases its animated image.
  const scrollHeight = await ui('return this.getElementById("library").scrollHeight');
  for (let top = 0; top < scrollHeight; top += 220) { await ui(`this.getElementById("library").scrollTop=${top}`); await pause(75); }
  await pause(800);
  const thumbs = await ui('return {canvases:this.querySelectorAll(".tile canvas").length,animatedImages:[...this.querySelectorAll(".tile img")].filter(i=>/\\.gif(?:$|\\?)/i.test(i.src)&&i.complete).length}');
  assert.ok(thumbs.canvases > 0, "GIFs frozen to canvas");
  assert.equal(thumbs.animatedImages, 0, "no loaded animated thumbnails remain");
  await ui('this.getElementById("library").scrollTop=0');

  // Hiding cannot strand the user: the regular open request still opens the inline panel.
  await ui('this.getElementById("options").click();this.getElementById("menu").querySelector("button").click();this.getElementById("close").click()');
  assert.equal(await ui('return this.querySelector(".entry").hidden'), true);
  writeFileSync(join(home, ".open-panel"), "open");
  await pause(650);
  assert.equal(await ui('return this.getElementById("panel").hidden'), false);
  await ui('this.getElementById("options").click();this.getElementById("menu").querySelector("button").click()');
  assert.equal(await ui('return this.querySelector(".entry").hidden'), false);
  await ui('this.getElementById("close").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,composed:true}))');
  assert.equal(await ui('return this.getElementById("panel").hidden'), true);
  await ui('const editor=document.createElement("input");editor.id="canvas-smoke-editor";document.body.append(editor);editor.focus()');
  writeFileSync(join(home, ".open-panel"), "open");
  await pause(650);
  await ui('this.getElementById("close").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,composed:true}))');
  assert.equal(await ui('return document.activeElement.id'), "canvas-smoke-editor", "Escape restores the previous editing focus");
  await ui('document.getElementById("canvas-smoke-editor").remove()');

  // Use actual mouse input to exercise pointer capture/edge snapping, not synthetic drag events.
  const point = await ui('const r=this.querySelector(".entry").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}');
  await ui('this._dragEvents=[];for(const kind of ["pointerdown","pointermove","pointerup"])this.querySelector(".entry").addEventListener(kind,e=>this._dragEvents.push([kind,e.clientX,e.clientY]));');
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  await pause(100);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x - 20, y: point.y, button: "left", buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 20, y: 200, button: "left", buttons: 1 });
  await pause(100);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 20, y: 200, button: "left", clickCount: 1 });
  assert.equal(await ui('return this.querySelector(".entry").dataset.side'), "left", JSON.stringify(await ui('const el=this.querySelector(".entry"),r=el.getBoundingClientRect();return {events:this._dragEvents,rect:r.toJSON(),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.tagName,pointer:getComputedStyle(el).pointerEvents,region:getComputedStyle(el).webkitAppRegion,dpr:devicePixelRatio}')));
  assert.equal(await ui('return this.getElementById("panel").hidden'), true, "drag must not open the panel");
  await ui('this.querySelector(".entry").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true}));this.getElementById("menu").querySelectorAll("button")[1].click()');
  assert.equal(await ui('return this.querySelector(".entry").dataset.side'), "right");
  writeFileSync(join(home, ".open-panel"), "open");
  await pause(650);
  await ui('this.getElementById("close").blur()');
  mkdirSync(join(sandbox, "shots"), { recursive: true });
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  const file = join(sandbox, "shots", "canvas-overlay-verified.png");
  writeFileSync(file, Buffer.from(screenshot.data, "base64"));
  console.log(JSON.stringify({ passed: true, wallpapers: count, ...thumbs, screenshot: file }));
} finally {
  writeFileSync(configFile, original);
  await ui(`localStorage.${prefs === null ? 'removeItem("zcode-canvas:entry:v1")' : `setItem("zcode-canvas:entry:v1",${JSON.stringify(prefs)})`}`);
  await ui('document.getElementById("canvas-smoke-editor")?.remove()');
  ws.close();
}
