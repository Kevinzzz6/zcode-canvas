import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function run(home: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { env: { ...process.env, ZCODE_CANVAS_HOME: home }, encoding: "utf8" });
}

test("the CLI sets and clears the pet's desktop mode with the same checks as the panel", () => {
  const home = mkdtempSync(join(tmpdir(), "zc-cli-pet-"));
  const config = () => JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { pet?: Record<string, unknown> };
  assert.equal(run(home, "set", "pet.desktop", "true").status, 0);
  assert.equal(config().pet?.desktop, true);
  const bad = run(home, "set", "pet.desktop", "yes");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /pet\.desktop 的值 "yes" 无效/);
  assert.equal(config().pet?.desktop, true, "a rejected value leaves the config alone");
  assert.equal(run(home, "unset", "pet.desktop").status, 0);
  assert.equal("desktop" in (config().pet ?? {}), false);
});
