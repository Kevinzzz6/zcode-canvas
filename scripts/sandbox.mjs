#!/usr/bin/env node
// Launch a copy of the official ZCode with fully isolated identity/data, for testing
// ZCode Canvas without touching the real installation or the real user profile.
//
//   node scripts/sandbox.mjs <sandbox-dir> [--port 9555]
//
// <sandbox-dir> must contain ZCode/ (a copy of the official install). home/ is created next to it.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const dir = resolve(args[0] ?? "../_sandbox");
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? args[portIndex + 1] : "9555";

const home = join(dir, "home");
const appData = join(home, "AppData", "Roaming");
const localAppData = join(home, "AppData", "Local");
for (const p of [home, appData, localAppData]) mkdirSync(p, { recursive: true });

const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (/^(ZCODE_|ELECTRON_|NODE_OPTIONS$)/i.test(key)) continue;
  env[key] = value;
}
Object.assign(env, {
  USERPROFILE: home,
  HOME: home,
  APPDATA: appData,
  LOCALAPPDATA: localAppData,
  ZCODE_DESKTOP_APPLICATION_NAME: "ZCode Canvas Sandbox",
  ZCODE_DESKTOP_HOME_DIR: home,
  ZCODE_DESKTOP_USER_DATA_DIR: join(appData, "ZCode Canvas Sandbox"),
});

const exe = join(dir, "ZCode", "ZCode.exe");
const child = spawn(exe, [`--remote-debugging-port=${port}`], {
  env,
  detached: true,
  stdio: ["ignore", "ignore", "ignore"],
});
child.unref();
console.log(`sandbox pid=${child.pid} cdp=http://127.0.0.1:${port} home=${home}`);
