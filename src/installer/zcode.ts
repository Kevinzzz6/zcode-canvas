import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BOOT_PATH, bootSource, inspect, readArchive, readFile, writePatched, writeRestored, type PatchState } from "./asar.ts";

export interface Installation {
  dir: string;
  exe: string;
  asar: string;
}

function asInstallation(dir: string | undefined | null): Installation | null {
  if (!dir) return null;
  const exe = join(dir, "ZCode.exe");
  const asar = join(dir, "resources", "app.asar");
  return existsSync(exe) && existsSync(asar) ? { dir, exe, asar } : null;
}

function registryInstallDirs(): string[] {
  const dirs: string[] = [];
  for (const hive of ["HKCU", "HKLM"]) {
    let output = "";
    try {
      output = execFileSync(
        "reg",
        ["query", `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, "/s", "/f", "ZCode", "/d"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
    } catch {
      continue;
    }
    // electron-builder records no InstallLocation; the uninstaller path gives the directory.
    for (const match of output.matchAll(/UninstallString\s+REG_SZ\s+"([^"]+)"/g)) dirs.push(dirname(match[1]!));
  }
  return dirs;
}

/** Candidates in order: explicit flag, env overrides, the running ZCode (it exports its own dir), registry, defaults. */
export function locateZCode(explicit?: string): Installation {
  if (explicit) {
    const found = asInstallation(explicit);
    if (!found) throw new Error(`No ZCode installation at ${explicit} (expected ZCode.exe and resources\\app.asar)`);
    return found;
  }
  const candidates = [
    process.env.ZCODE_CANVAS_ZCODE_DIR,
    process.env.ZCODE_WINDOWS_APP_INSTALL_DIR,
    ...registryInstallDirs(),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "ZCode"),
    process.env.ProgramFiles && join(process.env.ProgramFiles, "ZCode"),
  ];
  for (const dir of candidates) {
    const found = asInstallation(dir);
    if (found) return found;
  }
  throw new Error("Could not find ZCode. Pass --zcode <install dir>.");
}

export function readState(install: Installation): PatchState {
  return inspect(readArchive(install.asar));
}

export function isZCodeRunning(install: Installation): boolean {
  try {
    const output = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-Process -Name ZCode -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${install.exe.replace(/'/g, "''")}' } | Measure-Object).Count`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    return Number(output.trim()) > 0;
  } catch {
    return false;
  }
}

/** Copies the runtime and built-in themes into the Canvas home. Safe while ZCode runs; takes effect on next launch. */
export function deployRuntime(packageRoot: string, home: string) {
  const runtime = join(home, "runtime");
  const staging = join(home, "runtime.next");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  cpSync(join(packageRoot, "dist", "runtime"), staging, { recursive: true });
  cpSync(join(packageRoot, "themes"), join(staging, "themes"), { recursive: true });
  writeFileSync(join(staging, "version.json"), JSON.stringify({ version: packageVersion(packageRoot) }, null, 2));
  rmSync(runtime, { recursive: true, force: true });
  renameSync(staging, runtime);
  mkdirSync(join(home, "themes"), { recursive: true });
}

export function packageVersion(packageRoot: string): string {
  return (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string }).version;
}

export type ReplaceOutcome = "replaced" | "pending";

interface PendingRecord {
  id: string;
  asarSize: number;
  asarMtimeMs: number;
}

const pendingPath = (install: Installation) => `${install.asar}.canvas-pending`;

/**
 * Moves `prepared` over app.asar. While ZCode runs the archive is locked; then the file is parked as
 * app.asar.canvas-pending and a detached helper swaps it in once ZCode has exited.
 */
function replaceArchive(install: Installation, prepared: string, cliPath: string): ReplaceOutcome {
  const pending = pendingPath(install);
  rmSync(pending, { force: true });
  rmSync(`${pending}.json`, { force: true });
  try {
    renameSync(prepared, install.asar);
    return "replaced";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw error;
  }
  renameSync(prepared, pending);
  const stat = statSync(install.asar);
  const record: PendingRecord = { id: `${process.pid}-${Date.now()}`, asarSize: stat.size, asarMtimeMs: stat.mtimeMs };
  writeFileSync(`${pending}.json`, JSON.stringify(record));
  spawn(process.execPath, [cliPath, "__swap", install.dir, record.id], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  return "pending";
}

/** Body of the detached helper started by replaceArchive(). */
export async function runPendingSwap(installDir: string, id: string) {
  const install = asInstallation(installDir);
  if (!install) return;
  const pending = pendingPath(install);
  const deadline = Date.now() + 7 * 24 * 3600 * 1000;
  while (Date.now() < deadline) {
    if (!existsSync(pending) || !existsSync(`${pending}.json`)) return;
    const record = JSON.parse(readFileSync(`${pending}.json`, "utf8")) as PendingRecord;
    if (record.id !== id) return; // superseded by a newer apply/restore
    const stat = statSync(install.asar);
    if (stat.size !== record.asarSize || stat.mtimeMs !== record.asarMtimeMs) {
      // ZCode was updated in the meantime; the prepared file is based on the old version.
      rmSync(pending, { force: true });
      rmSync(`${pending}.json`, { force: true });
      return;
    }
    try {
      renameSync(pending, install.asar);
      rmSync(`${pending}.json`, { force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export function hasPendingSwap(install: Installation): boolean {
  return existsSync(pendingPath(install));
}

export function cancelPendingSwap(install: Installation) {
  rmSync(pendingPath(install), { force: true });
  rmSync(`${pendingPath(install)}.json`, { force: true });
}

function verifyPatched(file: string, expectPatched: boolean) {
  const state = inspect(readArchive(file));
  if (state.patched !== expectPatched) throw new Error(`verification failed for ${file}`);
}

export function applyPatch(install: Installation, canvasVersion: string, cliPath: string): ReplaceOutcome | "unchanged" {
  const archive = readArchive(install.asar);
  const state = inspect(archive);
  if (state.patched && readFile(archive, BOOT_PATH).toString("utf8") === bootSource(state.main)) {
    cancelPendingSwap(install);
    return "unchanged";
  }
  const prepared = `${install.asar}.canvas-tmp`;
  try {
    writePatched(readArchive(install.asar), prepared, canvasVersion);
    verifyPatched(prepared, true);
    return replaceArchive(install, prepared, cliPath);
  } finally {
    rmSync(prepared, { force: true });
  }
}

export function removePatch(install: Installation, cliPath: string): ReplaceOutcome | "not-patched" {
  cancelPendingSwap(install);
  if (!readState(install).patched) return "not-patched";
  const prepared = `${install.asar}.canvas-tmp`;
  try {
    writeRestored(readArchive(install.asar), prepared);
    verifyPatched(prepared, false);
    return replaceArchive(install, prepared, cliPath);
  } finally {
    rmSync(prepared, { force: true });
  }
}
