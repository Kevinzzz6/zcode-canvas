import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { watchHome } from "../src/runtime/watch.ts";
import { decodeState, encodeState, PROTOCOL_VERSION } from "../src/shared/protocol.ts";

test("the IPC codec round-trips the current protocol and tolerates its own past", () => {
  assert.deepEqual(encodeState("body { color: red }"), { v: PROTOCOL_VERSION, css: "body { color: red }" });
  assert.equal(decodeState(encodeState("body { color: red }")), "body { color: red }");
  // A main process from before payloads were versioned sent a bare string.
  assert.equal(decodeState("body { color: red }"), "body { color: red }");
  assert.equal(decodeState(""), "");
});

test("payloads from an incompatible newer protocol are ignored, not half-applied", () => {
  assert.equal(decodeState({ v: PROTOCOL_VERSION + 1, css: "x", tokens: {} }), null);
  assert.equal(decodeState({ css: "missing version" }), null);
  assert.equal(decodeState(null), null);
  assert.equal(decodeState(42), null);
});

test("watchHome debounces edits into one reload and skips the runtime's own log", async () => {
  const home = mkdtempSync(join(tmpdir(), "zc-watch-"));
  const events: string[] = [];
  const watcher = watchHome(home, () => events.push("change"), (message) => events.push(message));
  try {
    writeFileSync(join(home, "config.json"), "{}");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(events.filter((e) => e === "change"), ["change"]);
    // The runtime's own log must not trigger a reload, nor the desktop pet saving where she was dropped.
    writeFileSync(join(home, "runtime.log"), "noise");
    writeFileSync(join(home, "pet-position.json.tmp-1"), "{}");
    writeFileSync(join(home, "pet-position.json"), "{}");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(events.filter((e) => e === "change"), ["change"]);
  } finally {
    watcher.close();
  }
});

test("a watch error is logged and closes the watcher instead of crashing the process", async () => {
  const home = mkdtempSync(join(tmpdir(), "zc-watch-"));
  const logged: string[] = [];
  const watcher = watchHome(home, () => {}, (message) => logged.push(message));
  let closed = false;
  watcher.once("close", () => {
    closed = true;
  });
  // E.g. the home deleted by `restore --purge` while ZCode runs. close() settles asynchronously.
  watcher.emit("error", new Error("EPERM: watch"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /watch failed/);
  assert.ok(closed, "the watcher closed itself after the error");
  watcher.close(); // closing twice must stay harmless
});
