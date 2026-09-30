import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { debounced } from "../src/runtime/watch.ts";

// The 150ms debounce in the runtime coalesces panel writes with the watcher events they trigger;
// these tests pin the collapsing behavior with a smaller window to keep the suite fast.
test("debounced collapses a burst into one call", async () => {
  let calls = 0;
  const schedule = debounced(() => calls++, 20);
  schedule();
  schedule();
  schedule();
  assert.equal(calls, 0);
  await delay(80);
  assert.equal(calls, 1);
});

test("debounced fires again for a later, separate burst", async () => {
  let calls = 0;
  const schedule = debounced(() => calls++, 20);
  schedule();
  await delay(80);
  schedule();
  await delay(80);
  assert.equal(calls, 2);
});

test("debounced coalesces a direct call with events arriving right after it", async () => {
  // The double-trigger shape: a panel write calls schedule() directly, then the watcher notices
  // the same write milliseconds later. One reload must come out.
  let calls = 0;
  const schedule = debounced(() => calls++, 20);
  schedule();
  await delay(5);
  schedule();
  await delay(80);
  assert.equal(calls, 1);
});
