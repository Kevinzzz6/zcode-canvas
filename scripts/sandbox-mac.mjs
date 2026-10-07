#!/usr/bin/env node
// macOS counterpart of sandbox.mjs: launch a copy of the official ZCode with fully isolated
// identity and data, for testing ZCode Canvas without touching the real installation, its running
// instance or the real user profile.
//
//   node scripts/sandbox-mac.mjs <sandbox-dir> [--port 9555] [--from /Applications/ZCode.app]
//
// <sandbox-dir>/ZCode.app is copied from --from with ditto the first time (the copy, never the
// original, is what Canvas patches and re-signs). home/ is created next to it.
// ZCODE_DESKTOP_USER_DATA_DIR is what keeps the copy off the real instance's single-instance lock:
// ZCode sets its own userData path, overriding a bare --user-data-dir.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.platform !== "darwin") {
  console.error("sandbox-mac.mjs is for macOS; on Windows use scripts/sandbox.mjs.");
  process.exit(1);
}

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const dir = resolve(args[0] && !args[0].startsWith("--") ? args[0] : "../_sandbox");
const port = option("--port", "9555");
const from = resolve(option("--from", "/Applications/ZCode.app"));
const app = join(dir, "ZCode.app");
if (resolve(app) === from) {
  console.error(`refusing to run the original ${from} as the sandbox copy`);
  process.exit(1);
}

const home = join(dir, "home");
const canvasHome = join(home, ".zcode-canvas");
const userData = join(home, "Library", "Application Support", "ZCode Canvas Sandbox");
for (const p of [home, userData]) mkdirSync(p, { recursive: true });

if (!existsSync(app)) {
  console.log(`copying ${from} -> ${app}`);
  execFileSync("ditto", [from, app], { stdio: "inherit" });
}

const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (/^(ZCODE_|ELECTRON_|NODE_OPTIONS$)/i.test(key)) continue;
  env[key] = value;
}
Object.assign(env, {
  HOME: home,
  ZCODE_CANVAS_HOME: canvasHome,
  ZCODE_DESKTOP_APPLICATION_NAME: "ZCode Canvas Sandbox",
  ZCODE_DESKTOP_HOME_DIR: home,
  ZCODE_DESKTOP_USER_DATA_DIR: userData,
});

const child = spawn(join(app, "Contents", "MacOS", "ZCode"), [`--remote-debugging-port=${port}`], {
  env,
  detached: true,
  stdio: ["ignore", "ignore", "ignore"],
});
child.unref();
console.log(`sandbox pid=${child.pid} cdp=http://127.0.0.1:${port} home=${home}`);
// Its helpers exit with it. A path pattern (pkill -f "_sandbox/ZCode.app") also works when typed,
// but kills any script or agent whose own command line contains it.
console.log(`stop it: kill ${child.pid}`);
console.log(`install a build into it: HOME="${home}" ZCODE_CANVAS_HOME="${canvasHome}" node dist/cli.js apply --zcode "${app}"`);
