import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stagedUpdateCacheDir, stagedUpdateIsPresent, windowsRescueWaiterCommand } from "../src/runtime/rescue.ts";
import { startDetachedPowerShell, windowsPowershellExe } from "../src/shared/windows.ts";

/** A resources dir carrying the updater metadata real installs ship. */
function fakeResources(root: string, cacheName = "@test-updater"): string {
  const resources = join(root, "resources");
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, "app-update.yml"), `provider: generic\nurl: https://example.test\nupdaterCacheDirName: ${cacheName}\n`);
  return resources;
}

function fakeCache(root: string, files: string[]): string {
  const cache = join(root, "cache", "@test-updater");
  mkdirSync(join(cache, "pending"), { recursive: true });
  for (const file of files) writeFileSync(join(cache, "pending", file), "staged");
  return cache;
}

const winEnv = (localAppData: string) => ({ LOCALAPPDATA: localAppData, SystemRoot: "C:\\Windows" });

test("stagedUpdateCacheDir reads the updater cache dir name from app-update.yml", () => {
  const root = mkdtempSync(join(tmpdir(), "zc-rescue-"));
  const resources = fakeResources(root);
  const cache = fakeCache(root, ["installer.exe"]);
  const originalPlatform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    assert.equal(stagedUpdateCacheDir(resources, winEnv(join(root, "cache"))), join(cache));
    assert.equal(stagedUpdateIsPresent(resources, winEnv(join(root, "cache"))), true);
    // An empty or missing pending dir means nothing will install on this quit.
    assert.equal(stagedUpdateIsPresent(resources, winEnv(join(root, "elsewhere"))), false);
    rmSync(join(cache, "pending", "installer.exe"));
    assert.equal(stagedUpdateIsPresent(resources, winEnv(join(root, "cache"))), false);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
  // No updater metadata: never trigger.
  const bare = join(root, "bare");
  mkdirSync(bare, { recursive: true });
  assert.equal(stagedUpdateCacheDir(bare), null);
});

test("the waiter command escapes its paths and hands over as Node", () => {
  const command = windowsRescueWaiterCommand({
    updaterCacheDir: "C:\\Cache\\@up'dater",
    rescueExe: "C:\\Apps\\ZCode\\Z'Code.exe",
    cliCopy: "C:\\home\\cli.mjs",
    installDir: "C:\\Apps\\ZCode",
    canvasHome: "C:\\home",
    logFile: "C:\\home\\runtime.log",
  });
  // Single quotes in paths are doubled per PowerShell rules.
  assert.ok(command.includes("'C:\\Cache\\@up''dater\\'"), command);
  assert.ok(command.includes("'C:\\Apps\\ZCode\\Z''Code.exe'"), command);
  assert.ok(command.includes("$env:ELECTRON_RUN_AS_NODE = '1'"));
  assert.ok(command.includes("'__rescue' 'C:\\Apps\\ZCode' 'C:\\home'"));
  // The waiter never counts itself as the installer.
  assert.ok(command.includes("-and $_.Id -ne $PID"));
  assert.ok(command.includes("no installer appeared; ordinary quit"));
});

const canRunPowerShell = existsSync(windowsPowershellExe());

test("the waiter exits quietly when no installer ever appears", { skip: !canRunPowerShell }, async () => {
  const root = mkdtempSync(join(tmpdir(), "zc-waiter-"));
  const logFile = join(root, "runtime.log");
  const probe = join(root, "probe.mjs");
  writeFileSync(probe, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(root, "launched.txt"))}, "spawned");\n`);
  const command = windowsRescueWaiterCommand({
    updaterCacheDir: join(root, "no-such-cache"),
    rescueExe: process.execPath,
    cliCopy: probe,
    installDir: root,
    canvasHome: root,
    logFile,
    waitForInstallerSeconds: 1,
    pollMilliseconds: 200,
  });
  const child = spawn(windowsPowershellExe(), ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "ignore", windowsHide: true });
  const code = await new Promise<number>((resolve) => child.on("exit", resolve));
  assert.equal(code, 0);
  const log = readFileSync(logFile, "utf8");
  assert.match(log, /no installer appeared; ordinary quit/);
  assert.equal(existsSync(join(root, "launched.txt")), false, "nothing must be handed over on an ordinary quit");
});

test("the waiter waits the installer out, then hands over", { skip: !canRunPowerShell }, async () => {
  const root = mkdtempSync(join(tmpdir(), "zc-waiter-"));
  const logFile = join(root, "runtime.log");
  const probe = join(root, "probe.mjs");
  writeFileSync(
    probe,
    `import { writeFileSync } from "node:fs";\n` +
      `const argv = process.argv.slice(2);\n` +
      `writeFileSync(${JSON.stringify(join(root, "launched.txt"))}, argv.join(" "));\n`,
  );
  // A stand-in installer: any process whose exe lives under the "cache" dir. Use the PowerShell
  // home itself, with a sleeper we spawn (the waiter excludes its own PID).
  const powerShellHome = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0");
  const sleeper = spawn(windowsPowershellExe(), ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 3"], { stdio: "ignore", windowsHide: true });
  const command = windowsRescueWaiterCommand({
    updaterCacheDir: powerShellHome,
    rescueExe: process.execPath,
    cliCopy: probe,
    installDir: root,
    canvasHome: root,
    logFile,
    waitForInstallerSeconds: 10,
    pollMilliseconds: 200,
  });
  const child = spawn(windowsPowershellExe(), ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "ignore", windowsHide: true });
  const code = await new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? -1)));
  sleeper.kill();
  assert.equal(code, 0);
  const log = readFileSync(logFile, "utf8");
  assert.match(log, /installer is running/);
  assert.match(log, /handing over to the rescue helper/);
  // The handover happened with the exact __rescue argv (Node flips argv[0]; the args follow).
  assert.equal(readFileSync(join(root, "launched.txt"), "utf8"), `__rescue ${root} ${root}`);
});

test("startDetachedPowerShell starts a worker that outlives this process", { skip: !canRunPowerShell }, async () => {
  const root = mkdtempSync(join(tmpdir(), "zc-launch-"));
  const scriptFile = join(root, "worker.ps1");
  const marker = join(root, "marker.txt");
  // The worker only writes after a delay, so the marker proves the process kept running well
  // after startDetachedPowerShell (and its brief outer launcher) had both returned.
  writeFileSync(scriptFile, `Start-Sleep -Seconds 2\nAdd-Content -LiteralPath ${JSON.stringify(marker).replace(/"/g, "'")} -Value done\n`);
  const { started, error } = startDetachedPowerShell(scriptFile);
  assert.equal(started, true, error ?? "startDetachedPowerShell failed");
  for (let i = 0; i < 40 && !existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(readFileSync(marker, "utf8").trim(), "done");
});
