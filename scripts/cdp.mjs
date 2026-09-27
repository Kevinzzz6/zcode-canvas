#!/usr/bin/env node
// Dev-only helper for the sandbox (scripts/sandbox.mjs): evaluate JS or capture a screenshot of
// the ZCode renderer over CDP. ZCode Canvas itself never uses CDP.
//
//   node scripts/cdp.mjs eval "<expression>" [--port 9555]
//   node scripts/cdp.mjs shot <out.png> [--port 9555]
//   node scripts/cdp.mjs reload [--port 9555]
import { writeFileSync } from "node:fs";

const [command, arg] = process.argv.slice(2);
const portIndex = process.argv.indexOf("--port");
const port = portIndex >= 0 ? process.argv[portIndex + 1] : "9555";

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(
  (t) => t.type === "page" && /out\/renderer\/index\.html/.test(t.url) && !/windowKind=/.test(t.url),
);
if (!target) throw new Error("renderer target not found");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

if (command === "eval") {
  const result = await send("Runtime.evaluate", {
    expression: arg,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify(result.result?.result?.value ?? result.result, null, 2));
} else if (command === "shot") {
  const result = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(arg, Buffer.from(result.result.data, "base64"));
  console.log(`saved ${arg}`);
} else if (command === "reload") {
  await send("Page.reload", { ignoreCache: true });
  console.log("reloaded");
} else if (command === "reloadshot") {
  // Capture the startup screen: reload, then screenshot while #loading is still up.
  await send("Page.reload", { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, Number(process.argv[4] ?? 250)));
  const result = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(arg, Buffer.from(result.result.data, "base64"));
  console.log(`saved ${arg}`);
}
ws.close();
