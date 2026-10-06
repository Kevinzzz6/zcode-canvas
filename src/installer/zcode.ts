import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chownSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { BOOT_PATH, inspect, isPatchCurrent, readArchive, readFile, recordHashIsSound, writePatched, writeRestored, type PatchState } from "./asar.ts";

export interface Installation {
  dir: string;
  exe: string;
  asar: string;
}

/** The packaged executable name per platform: ZCode.exe (win), zcode (linux), ZCode (darwin). */
export function exeName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "ZCode.exe" : platform === "linux" ? "zcode" : "ZCode";
}

/** Resolves an install dir to its layout. On darwin the dir is the ZCode.app bundle (or its parent). */
export function installationAt(input: string | undefined | null, platform: NodeJS.Platform = process.platform): Installation | null {
  if (!input) return null;
  const dir = platform === "darwin" && basename(input) !== "ZCode.app" ? join(input, "ZCode.app") : input;
  const exe = platform === "darwin" ? join(dir, "Contents", "MacOS", "ZCode") : join(dir, exeName(platform));
  const asar = platform === "darwin" ? join(dir, "Contents", "Resources", "app.asar") : join(dir, "resources", "app.asar");
  return existsSync(exe) && existsSync(asar) ? { dir, exe, asar } : null;
}

/** AppImages mount read-only, so their app.asar cannot be patched; the rpm/deb/pacman packages can. */
function isAppImageInstall(install: Installation): boolean {
  return install.asar.includes("/.mount_") || /\.appimage$/i.test(install.dir);
}

function findAppImage(): string | undefined {
  for (const dir of [join(homedir(), "Applications"), join(homedir(), ".local", "bin")]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) if (/^zcode.*\.appimage$/i.test(name)) return join(dir, name);
  }
  return undefined;
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

/** The dir behind a `zcode` executable on PATH (electron-builder symlinks /usr/bin/zcode -> /opt/ZCode/zcode). */
function dirFromPathLookup(): string | undefined {
  try {
    const found = execFileSync("which", ["zcode"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return found ? dirname(realpathSync(found)) : undefined;
  } catch {
    return undefined;
  }
}

function candidatesFor(platform: NodeJS.Platform): string[] {
  const explicit = process.env.ZCODE_CANVAS_ZCODE_DIR;
  if (platform === "linux")
    return [explicit, "/opt/ZCode", dirFromPathLookup()].filter((d): d is string => !!d);
  if (platform === "darwin") return [explicit, "/Applications", join(homedir(), "Applications")].filter((d): d is string => !!d);
  return [
    explicit,
    process.env.ZCODE_WINDOWS_APP_INSTALL_DIR,
    ...registryInstallDirs(),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "ZCode"),
    process.env.ProgramFiles && join(process.env.ProgramFiles, "ZCode"),
  ].filter((d): d is string => !!d);
}

function notFoundMessage(): string {
  if (process.platform === "linux") {
    const appImage = findAppImage();
    return (
      "Could not find a ZCode rpm/deb/pacman installation (looked at /opt/ZCode and the `zcode` executable on PATH)." +
      (appImage ? ` AppImage installs are read-only and not supported (${appImage}); on Fedora install the .rpm package instead.` : "") +
      " Pass --zcode <install dir> to override."
    );
  }
  if (process.platform === "darwin")
    return "Could not find ZCode.app (looked at /Applications and ~/Applications). Pass --zcode <ZCode.app or its parent dir>.";
  return "Could not find ZCode. Pass --zcode <install dir>.";
}

/** Candidates in order: explicit flag, env overrides, the running ZCode (Windows: it exports its own dir), defaults. */
export function locateZCode(explicit?: string): Installation {
  const found = installationAt(explicit) ?? (!explicit ? candidatesFor(process.platform).map((dir) => installationAt(dir)).find(Boolean) ?? null : null);
  if (!found) throw new Error(explicit ? `No ZCode installation at ${explicit}` : notFoundMessage());
  if (isAppImageInstall(found)) throw new Error(`AppImage installs are read-only and cannot be patched (${found.dir}); on Fedora install the .rpm package instead.`);
  return found;
}

export function readState(install: Installation): PatchState {
  return inspect(readArchive(install.asar));
}

function windowsZCodeRunning(exe: string): boolean {
  try {
    const output = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-Process -Name ZCode -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe.replace(/'/g, "''")}' } | Measure-Object).Count`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    return Number(output.trim()) > 0;
  } catch {
    return false;
  }
}

/** Matches /proc/<pid>/exe against the install's executable; falls back to pgrep when /proc is unavailable. */
function linuxZCodeRunning(exe: string): boolean {
  let target = exe;
  try {
    target = realpathSync(exe);
  } catch {
    // Keep the literal path; the executable may have been removed with the package.
  }
  try {
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      let link: string;
      try {
        link = readlinkSync(join("/proc", pid, "exe"));
      } catch {
        continue; // other users' processes are not readable
      }
      if (link === target || link === `${target} (deleted)`) return true;
    }
  } catch {
    // No /proc (non-standard); fall through to pgrep.
  }
  try {
    execFileSync("pgrep", ["-x", "zcode"], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/** pgrep -x only proves that *some* ZCode is running — a copy launched straight from a mounted DMG
 * counts too. ps comm reports each candidate's executable path, so only processes belonging to this
 * install report "running", mirroring the per-install checks on Windows and Linux. */
export function macZCodeRunning(exe: string, run: (command: string, args: string[]) => string = runCapture): boolean {
  let pids: string;
  try {
    pids = run("pgrep", ["-x", basename(exe)]);
  } catch {
    return false; // pgrep exits nonzero when nothing matches
  }
  let canonical = exe;
  try {
    canonical = realpathSync(exe);
  } catch {
    // The executable may be gone (uninstalled); the literal path still identifies the install.
  }
  for (const pid of pids.trim().split(/\s+/).filter(Boolean)) {
    try {
      const comm = run("ps", ["-o", "comm=", "-p", pid]).trim();
      if (comm === exe || comm === canonical) return true;
    } catch {
      continue; // the process may have exited between pgrep and ps
    }
  }
  return false;
}

function runCapture(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export function isZCodeRunning(install: Installation): boolean {
  if (process.platform === "linux") return linuxZCodeRunning(install.exe);
  if (process.platform === "darwin") return macZCodeRunning(install.exe);
  return windowsZCodeRunning(install.exe);
}

export interface SudoEnv {
  SUDO_USER?: string | undefined;
  SUDO_UID?: string | undefined;
  SUDO_GID?: string | undefined;
}

/** uid/gid the Canvas home should belong to when Canvas runs as root: the user who invoked sudo.
 *  Falls back to the owner of that user's home directory when sudo did not export SUDO_UID/SUDO_GID. */
export function sudoOwner(env: SudoEnv, invokingHomeOwner?: { uid: number; gid: number }): { uid: number; gid: number } | null {
  const user = env.SUDO_USER;
  if (!user || user === "root") return null;
  const uid = Number(env.SUDO_UID);
  const gid = Number(env.SUDO_GID);
  if (Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid >= 0) return { uid, gid };
  return invokingHomeOwner && invokingHomeOwner.uid > 0 ? invokingHomeOwner : null;
}

function chownTree(root: string, uid: number, gid: number) {
  chownSync(root, uid, gid);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    // Symlinks (neither file nor directory here) are left alone: chowning them would touch targets.
    const path = join(root, entry.name);
    if (entry.isDirectory()) chownTree(path, uid, gid);
    else if (entry.isFile()) chownSync(path, uid, gid);
  }
}

/**
 * `sudo zcode-canvas apply` installs into the invoking user's home (see canvasHome), but as root —
 * which would leave runtime/, themes/ and config.json owned by root and unwritable by that user.
 * Hands everything under `home` back. Best effort: failures are reported but never fail apply,
 * which already fixed the part that matters (the archive patch).
 */
export function restoreOwnership(home: string, log: (message: string) => void = console.warn): void {
  if (process.platform === "win32" || typeof process.getuid !== "function" || process.getuid() !== 0) return;
  let owner: { uid: number; gid: number } | null = null;
  try {
    const parent = statSync(dirname(home), { throwIfNoEntry: false });
    owner = sudoOwner(process.env, parent ? { uid: parent.uid, gid: parent.gid } : undefined);
  } catch {
    owner = sudoOwner(process.env);
  }
  if (!owner) return;
  try {
    chownTree(home, owner.uid, owner.gid);
  } catch (error) {
    log(`! 无法把 ${home} 归还给当前用户: ${String(error)}\n  请手动执行: sudo chown -R $(whoami): "${home}"`);
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
  cpSync(join(packageRoot, "pets"), join(staging, "pets"), { recursive: true });
  writeFileSync(join(staging, "version.json"), JSON.stringify({ version: packageVersion(packageRoot) }, null, 2));
  replaceDirectory(staging, runtime);
  mkdirSync(join(home, "themes"), { recursive: true });
  restoreOwnership(home);
}

/**
 * Moves `from` over `to`. On Windows a running ZCode holds the old runtime's files open (the pet's
 * picture and sounds, wallpapers), so the deleted folder lingers for a moment and renaming onto
 * its name fails with EPERM. Retries briefly, then copies instead: `to` must never be left missing.
 */
export function replaceDirectory(from: string, to: string, rename: (from: string, to: string) => void = renameSync, attempts = 10) {
  rmSync(to, { recursive: true, force: true });
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") || attempt >= attempts) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  cpSync(from, to, { recursive: true, force: true });
  rmSync(from, { recursive: true, force: true });
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

/** Thrown after app.asar was replaced but the follow-up (re-signing) failed: the patch IS in
 *  place, yet the command must not report success, because ZCode may refuse to start. */
export class ResignError extends Error {
  constructor(install: Installation, detail: string) {
    super(
      `app.asar 已替换，但重新签名失败 — ZCode 可能拒绝启动。\n` +
        `  请手动执行: codesign --force --deep --sign - "${install.dir}"\n${detail}`,
    );
    this.name = "ResignError";
  }
}

/** Re-signs `install` after its archive changed. null = done (or not needed on this platform);
 *  a string = failure detail, reported by the caller once the replacement itself has succeeded. */
type Resigner = (install: Installation) => string | null;

const pendingPath = (install: Installation) => `${install.asar}.canvas-pending`;

/**
 * Moves `prepared` over app.asar. Only Windows locks the archive while ZCode runs (EBUSY) and denies
 * writes in protected dirs (EPERM/EACCES); there the file is parked as app.asar.canvas-pending and a
 * detached helper swaps it in once ZCode has exited. POSIX renames over open files fine, so any
 * failure there is a real permission problem that the caller (running under sudo) must solve.
 */
function replaceArchive(install: Installation, prepared: string, cliPath: string, resign: Resigner): ReplaceOutcome {
  const pending = pendingPath(install);
  rmSync(pending, { force: true });
  rmSync(`${pending}.json`, { force: true });
  try {
    renameSync(prepared, install.asar);
    const resignFailure = resign(install);
    if (resignFailure !== null) throw new ResignError(install, resignFailure);
    return "replaced";
  } catch (error) {
    if (error instanceof ResignError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES")) throw error;
  }
  renameSync(prepared, pending);
  const stat = statSync(install.asar);
  const record: PendingRecord = { id: `${process.pid}-${Date.now()}`, asarSize: stat.size, asarMtimeMs: stat.mtimeMs };
  writeFileSync(`${pending}.json`, JSON.stringify(record));
  spawn(process.execPath, [cliPath, "__swap", install.dir, record.id], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return "pending";
}

/**
 * macOS code signatures seal app.asar, so any patch — or restore, which also changes bytes under the
 * current signature — must be followed by an ad-hoc re-sign or Gatekeeper will call the app damaged.
 * The re-sign is then verified, and a leftover quarantine attribute is cleared as insurance for
 * macOS builds that treat ad-hoc + quarantine as damaged (Tahoe 25.4 launches fine with it).
 * Returns false (instead of throwing) so the caller can report that the archive was already replaced.
 */
const adHocResign: Resigner = (install: Installation): string | null => {
  if (process.platform !== "darwin") return null;
  const result = spawnSync("codesign", ["--force", "--deep", "--sign", "-", install.dir], { encoding: "utf8" });
  if (result.status !== 0) return lastLines(result.stderr);
  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", install.dir], { encoding: "utf8" });
  if (verify.status !== 0) return `signature does not verify after re-sign: ${lastLines(verify.stderr)}`;
  // Best effort: xattr exits nonzero when the attribute is absent, which is the common case.
  spawnSync("xattr", ["-d", "com.apple.quarantine", install.dir], { stdio: "ignore" });
  return null;
};

function lastLines(stderr: string | Buffer | null): string {
  return String(stderr || "").trim().split("\n").slice(-3).join("\n").trim();
}


/** Body of the detached helper started by replaceArchive(). */
export async function runPendingSwap(installDir: string, id: string) {
  const install = installationAt(installDir);
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

// The staleness check above is size + mtime, not a sha256 of app.asar, on purpose: while ZCode
// runs, Windows locks the archive, so it cannot change under the helper's feet — and once ZCode
// exits, any real update (installer, updater) writes a new file with a new size or mtime, which
// the next one-second poll sees. Hashing the archive every retry would instead burn disk and CPU
// for hours while waiting for ZCode to quit.

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

export function applyPatch(install: Installation, canvasVersion: string, cliPath: string, resign: Resigner = adHocResign): ReplaceOutcome | "unchanged" {
  const archive = readArchive(install.asar);
  const state = inspect(archive);
  // "Unchanged" needs the bootstrap this build would write, the patch format it stamps, and a
  // restore record whose hash is trustworthy — otherwise a patch from an older Canvas (old record
  // schema, old header shape, or a hash stamped from the wrong file) must be rewritten.
  if (state.patched && state.restore && isPatchCurrent(readFile(archive, BOOT_PATH).toString("utf8"), state) && recordHashIsSound(archive, state.restore)) {
    cancelPendingSwap(install);
    return "unchanged";
  }
  const prepared = `${install.asar}.canvas-tmp`;
  try {
    writePatched(readArchive(install.asar), prepared, canvasVersion);
    verifyPatched(prepared, true);
    return replaceArchive(install, prepared, cliPath, resign);
  } finally {
    rmSync(prepared, { force: true });
  }
}

export function removePatch(install: Installation, cliPath: string, resign: Resigner = adHocResign): ReplaceOutcome | "not-patched" {
  cancelPendingSwap(install);
  if (!readState(install).patched) return "not-patched";
  const prepared = `${install.asar}.canvas-tmp`;
  try {
    writeRestored(readArchive(install.asar), prepared);
    verifyPatched(prepared, false);
    return replaceArchive(install, prepared, cliPath, resign);
  } finally {
    rmSync(prepared, { force: true });
  }
}
