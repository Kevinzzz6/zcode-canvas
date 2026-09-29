#!/usr/bin/env node
// Development only, like cdp.mjs: exercise the REAL isolated sandbox and its closed shadow root.
// Never targets an installed/user ZCode. Requires scripts/sandbox.mjs and an imported test library.
// node scripts/overlay-smoke.mjs [sandbox-directory] [port]
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const sandbox = resolve(process.argv[2] ?? "../_sandbox");
const port = Number(process.argv[3] ?? 9555);
// The overlay under test must be this build; otherwise failures only describe an older runtime.
for (const file of ["main.cjs", "preload.cjs"]) {
  const deployed = join(sandbox, "home", ".zcode-canvas", "runtime", file);
  assert.ok(readFileSync(deployed).equals(readFileSync(resolve("dist", "runtime", file))),
    `sandbox runs a stale ${file}: run npm run build, copy dist/runtime/*.cjs to ${dirname(deployed)}, then restart the sandbox ZCode`);
}
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
  await ui('const slider=this.getElementById("brightness");slider.value="0.61";slider.dispatchEvent(new Event("input",{bubbles:true}))');
  await pause(100);
  assert.equal(readFileSync(configFile, "utf8"), saved, "drag preview must not write config");
  assert.match(await ui('return getComputedStyle(document.body,"::before").filter'), /0\.61/);
  await ui('this.getElementById("brightness").dispatchEvent(new Event("change",{bubbles:true}))');
  await pause();
  assert.equal(JSON.parse(readFileSync(configFile, "utf8")).wallpaper.brightness, .61);

  // Force a real failed write by making the existing config unreadable to the handler.
  const beforeFailure = readFileSync(configFile, "utf8");
  writeFileSync(configFile, "{");
  await ui('const slider=this.getElementById("brightness");slider.value="0.2";slider.dispatchEvent(new Event("input",{bubbles:true}));slider.dispatchEvent(new Event("change",{bubbles:true}))');
  await pause();
  assert.match(await ui('return this.getElementById("status").textContent'), /未能应用|暂时无法/);
  assert.equal(await ui('return this.getElementById("brightness").value'), "0.61", "failed save restores slider");
  assert.match(await ui('return getComputedStyle(document.body,"::before").filter'), /0\.61/, "failed save clears preview CSS");
  writeFileSync(configFile, beforeFailure);
  await pause();

  await ui('this.getElementById("brightness").scrollIntoView({block:"nearest"})');
  const sliderPoint = await ui('const r=this.getElementById("brightness").getBoundingClientRect();return {x:r.x+r.width*.5,y:r.y+r.height/2}');
  const beforeDrag = readFileSync(configFile, "utf8");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...sliderPoint });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...sliderPoint, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sliderPoint.x - 20, y: sliderPoint.y, button: "left", buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 500, y: sliderPoint.y, button: "left", buttons: 1 });
  assert.equal(readFileSync(configFile, "utf8"), beforeDrag, "real pointer drag still does not save");
  assert.equal(await ui('return this.getElementById("panel").hidden'), false, "drag outside keeps the panel open");
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 500, y: sliderPoint.y, button: "left", clickCount: 1 });
  await pause();
  assert.equal(JSON.parse(readFileSync(configFile, "utf8")).wallpaper.brightness, 0, "release outside commits captured slider");
  await ui('const s=this.getElementById("brightness");s.value="0.61";s.dispatchEvent(new Event("input",{bubbles:true}));s.dispatchEvent(new Event("change",{bubbles:true}))');
  await pause();

  const change = async (id, value) => {
    await ui(`const input=this.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(String(value))};input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}))`);
    await pause();
  };
  const config = () => JSON.parse(readFileSync(configFile, "utf8"));
  // Curved tracks (blur, zoom) are driven through the typed value, like a user wanting an exact number.
  const type = async (id, text) => {
    await ui(`this.getElementById(${JSON.stringify(`${id}-value`)}).click();const e=this.getElementById(${JSON.stringify(`${id}-edit`)});e.value=${JSON.stringify(String(text))};e.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,composed:true}))`);
    await pause();
  };
  await change("transparency", 55);
  assert.ok(Math.abs(config().glass.opacity - .45) < .00001);
  await type("glassBlur", "18px");
  assert.equal(config().glass.blur, 18);
  // A Canvas-owned probe with the existing contracted CSS class checks the composited surface,
  // without depending on the host's internal editor or notification DOM tree.
  await ui('const frame=document.createElement("div");frame.id="canvas-smoke-frame";frame.innerHTML="<div id=\\"root\\"><div class=\\"bg-background\\" id=\\"canvas-smoke-surface\\"></div></div>";document.body.append(frame)');
  assert.match(await ui('return getComputedStyle(document.getElementById("canvas-smoke-surface")).backdropFilter'), /blur\(18px\)/);
  const savedGlass = readFileSync(configFile, "utf8");
  await ui('const input=this.getElementById("glassBlur");input.value="0";input.dispatchEvent(new Event("input",{bubbles:true}))');
  await pause(100);
  assert.equal(readFileSync(configFile, "utf8"), savedGlass);
  assert.equal(await ui('return getComputedStyle(document.getElementById("canvas-smoke-surface")).backdropFilter'), "none", "preview must remove old blur rules");
  await ui('this.getElementById("glassBlur").dispatchEvent(new Event("change",{bubbles:true}))');
  await pause();
  assert.equal(config().glass.blur, 0);
  await ui('this.getElementById("wallpaper-details").open=true');
  await change("positionX", 25);
  await change("positionY", 75);
  assert.equal(config().wallpaper.position, "25% 75%");
  assert.equal(await ui('return this.getElementById("positionX-value").textContent'), "25%");
  assert.equal(await ui('return this.getElementById("positionX-reset").disabled'), false, "a changed control offers its own reset");
  await ui('this.getElementById("positionX-reset").click()');
  await pause();
  assert.doesNotMatch(config().wallpaper.position ?? "", /^25%/, "single reset returns only the horizontal axis");
  assert.match(config().wallpaper.position ?? "", /75%$/);
  await type("blur", "999");
  assert.equal(config().wallpaper.blur, 200, "typed values are clamped to the range");
  assert.match(await ui('return this.getElementById("status").textContent'), /已限制|已应用|即点即用/);
  await ui('this.getElementById("blur-reset").click()');
  await pause();
  assert.equal(config().wallpaper.blur, undefined, "single reset removes only that override");
  await ui('this.getElementById("blur-value").click();const e=this.getElementById("blur-edit");e.value="7";e.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,composed:true}))');
  await pause(100);
  assert.equal(await ui('return this.getElementById("panel").hidden'), false, "Escape cancels the edit, not the panel");
  assert.equal(config().wallpaper.blur, undefined);
  await change("transparency", 0);
  assert.equal(await ui('return this.getElementById("primary-hint").hidden'), false, "an opaque UI says why the wallpaper is hidden");
  assert.equal(await ui('return this.getElementById("glassBlur").disabled'), true);
  await change("transparency", 55);
  assert.equal(await ui('return this.getElementById("primary-hint").hidden'), true);
  await ui('this.getElementById("center-position").click()');
  await pause();
  assert.equal(config().wallpaper.position, "50% 50%");
  await ui('this.getElementById("theme-details").open=true');
  await change("accent", "#4488cc");
  assert.equal(config().accent, "#4488cc");
  assert.equal(await ui('return getComputedStyle(document.documentElement).getPropertyValue("--color-primary").trim()'), "#4488cc");
  await change("radius", .5);
  await ui('this.querySelector(".theme[data-id=aurora]").click()');
  await pause();
  assert.equal(config().theme, "aurora");
  assert.equal(config().wallpaper.brightness, .61);
  assert.equal(config().radius, .5);
  assert.ok(Math.abs(config().glass.opacity - .45) < .00001, "personal transparency survives theme switches");
  const selectedImage = config().wallpaper.image;
  await ui('this.getElementById("reset-theme").click()');
  await pause();
  assert.equal(config().glass, undefined);
  assert.equal(config().accent, undefined);
  assert.equal(config().radius, undefined);
  assert.equal(config().wallpaper.image, selectedImage);
  assert.equal(await ui('return this.getElementById("glassBlur-value").textContent'), "18px", "reset follows current theme");
  await ui('this.getElementById("reset-tuning").click()');
  await pause();
  assert.equal(config().wallpaper.brightness, undefined);
  assert.equal(config().wallpaper.image, selectedImage);
  assert.equal(await ui('return this.getElementById("overlay-notice").hidden'), false, "theme overlay remains discoverable");
  await ui('this.getElementById("clear-overlay").click()');
  await pause();
  assert.equal(config().wallpaper.dim, 0);
  assert.equal(await ui('return this.getElementById("overlay-notice").hidden'), true);
  await ui('this.getElementById("wallpaper-details").open=false;this.getElementById("theme-details").open=false;this.querySelector(".content").scrollTop=0;document.getElementById("canvas-smoke-frame").remove()');

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
  await ui('document.getElementById("canvas-smoke-frame")?.remove()');
  ws.close();
}
