import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { makeArchive } from "./make-archive.ts";
import {
  applyPatch,
  deployRuntime,
  exeName,
  installationAt,
  macZCodeRunning,
  removePatch,
  replaceDirectory,
  ResignError,
  runPendingSwap,
  sudoOwner,
  type Installation,
} from "../src/installer/zcode.ts";

/**
 * A fake install with a real (minimal) app.asar in the layout installationAt resolves on this
 * platform (a ZCode.app bundle on darwin), so code that looks the install up again by its dir —
 * the pending swap helper — finds it everywhere.
 */
function fakeInstall(): Installation {
  const root = mkdtempSync(join(tmpdir(), "zc-install-"));
  const mac = process.platform === "darwin";
  const dir = mac ? join(root, "ZCode.app") : root;
  const exe = mac ? join(dir, "Contents", "MacOS", "ZCode") : join(dir, exeName(process.platform));
  const resources = mac ? join(dir, "Contents", "Resources") : join(dir, "resources");
  mkdirSync(dirname(exe), { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFileSync(exe, "");
  makeArchive(resources);
  const install = installationAt(dir);
  assert.ok(install, "the fixture matches the platform's install layout");
  return install;
}

/** Stands in for codesign: a temp dir is no bundle macOS would sign. */
const resigned = () => null;

test("apply patches the archive, then reports it unchanged until the format or bootstrap moves", () => {
  const install = fakeInstall();
  assert.equal(applyPatch(install, "0.0.0-test", import.meta.filename, resigned), "replaced");
  assert.equal(applyPatch(install, "0.0.0-test", import.meta.filename, resigned), "unchanged");
  // Canvas version bumps alone do not rewrite the archive; only format/bootstrap changes do.
  assert.equal(applyPatch(install, "9.9.9-other", import.meta.filename, resigned), "unchanged");
});

test("a failed re-sign after the swap throws, but the patch itself stays applied", () => {
  const install = fakeInstall();
  assert.throws(
    () => applyPatch(install, "0.0.0-test", import.meta.filename, () => "codesign: internal error"),
    (error: unknown) => {
      assert.ok(error instanceof ResignError);
      assert.match(error.message, /app\.asar 已替换/);
      assert.match(error.message, /codesign --force --deep --sign -/);
      assert.match(error.message, /codesign: internal error/);
      return true;
    },
  );
  // The rename happened before the resign: the archive on disk is patched and clean to restore.
  assert.equal(removePatch(install, import.meta.filename, resigned), "replaced");
  assert.equal(applyPatch(install, "0.0.0-test", import.meta.filename, resigned), "replaced");
});

function parkPending(install: Installation, id: string): void {
  writeFileSync(`${install.asar}.canvas-pending`, "patched-by-canvas");
  const stat = statSync(install.asar);
  writeFileSync(`${install.asar}.canvas-pending.json`, JSON.stringify({ id, asarSize: stat.size, asarMtimeMs: stat.mtimeMs }));
}

test("the pending helper swaps the parked file in once it can", async () => {
  const install = fakeInstall();
  parkPending(install, "job-1");
  await runPendingSwap(install.dir, "job-1");
  assert.equal(readFileSync(install.asar, "utf8"), "patched-by-canvas");
  assert.equal(statSync(`${install.asar}.canvas-pending`, { throwIfNoEntry: false }), undefined);
  assert.equal(statSync(`${install.asar}.canvas-pending.json`, { throwIfNoEntry: false }), undefined);
});

test("a ZCode update in the meantime cancels the pending swap instead of clobbering it", async () => {
  const install = fakeInstall();
  parkPending(install, "job-1");
  writeFileSync(install.asar, readFileSync(install.asar).toString("utf8") + "updated-by-installer");
  await runPendingSwap(install.dir, "job-1");
  assert.match(readFileSync(install.asar, "utf8"), /updated-by-installer$/);
  assert.equal(statSync(`${install.asar}.canvas-pending`, { throwIfNoEntry: false }), undefined);
  assert.equal(statSync(`${install.asar}.canvas-pending.json`, { throwIfNoEntry: false }), undefined);
});

test("a pending record superseded by a newer apply is left alone", async () => {
  const install = fakeInstall();
  parkPending(install, "job-2");
  const asarBefore = readFileSync(install.asar);
  await runPendingSwap(install.dir, "job-1");
  assert.deepEqual(readFileSync(install.asar), asarBefore);
  assert.ok(statSync(`${install.asar}.canvas-pending`, { throwIfNoEntry: false }));
});

test("sudoOwner resolves the invoking user, never root, and never without evidence", () => {
  assert.equal(sudoOwner({}), null);
  assert.equal(sudoOwner({ SUDO_USER: "root", SUDO_UID: "0", SUDO_GID: "0" }), null);
  assert.deepEqual(sudoOwner({ SUDO_USER: "alice", SUDO_UID: "1000", SUDO_GID: "1000" }), { uid: 1000, gid: 1000 });
  // sudo that did not export the ids: fall back to the owner of the invoking user's home.
  assert.deepEqual(sudoOwner({ SUDO_USER: "alice" }, { uid: 1000, gid: 1000 }), { uid: 1000, gid: 1000 });
  assert.equal(sudoOwner({ SUDO_USER: "alice" }), null);
  assert.equal(sudoOwner({ SUDO_USER: "alice", SUDO_UID: "not-a-number", SUDO_GID: "10" }), null);
  assert.equal(sudoOwner({ SUDO_USER: "alice", SUDO_UID: "0", SUDO_GID: "0" }, { uid: 0, gid: 0 }), null);
});

test("deployRuntime ships the runtime, built-in themes and the pet into the Canvas home", () => {
  const root = mkdtempSync(join(tmpdir(), "zc-pkg-"));
  const home = mkdtempSync(join(tmpdir(), "zc-home-"));
  mkdirSync(join(root, "dist", "runtime"), { recursive: true });
  writeFileSync(join(root, "dist", "runtime", "main.cjs"), "runtime");
  mkdirSync(join(root, "themes", "t"), { recursive: true });
  writeFileSync(join(root, "themes", "t", "theme.json"), JSON.stringify({ name: "T" }));
  mkdirSync(join(root, "pets", "fox"), { recursive: true });
  writeFileSync(join(root, "pets", "fox", "fox.png"), "png");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.0.0-test" }));
  deployRuntime(root, home);
  assert.equal(readFileSync(join(home, "runtime", "main.cjs"), "utf8"), "runtime");
  assert.ok(existsSync(join(home, "runtime", "themes", "t", "theme.json")));
  assert.equal(readFileSync(join(home, "runtime", "pets", "fox", "fox.png"), "utf8"), "png");
  assert.equal(JSON.parse(readFileSync(join(home, "runtime", "version.json"), "utf8")).version, "0.0.0-test");
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("replacing the runtime never leaves it missing when Windows refuses the rename", () => {
  const home = mkdtempSync(join(tmpdir(), "zc-replace-"));
  const from = join(home, "runtime.next");
  const to = join(home, "runtime");
  mkdirSync(join(from, "pets"), { recursive: true });
  writeFileSync(join(from, "pets", "fox.png"), "new");
  mkdirSync(to);
  writeFileSync(join(to, "old.cjs"), "old");
  let tries = 0;
  const lingering = () => {
    tries++;
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  };
  replaceDirectory(from, to, lingering, 2);
  assert.equal(tries, 2, "retried before falling back");
  assert.equal(readFileSync(join(to, "pets", "fox.png"), "utf8"), "new");
  assert.equal(existsSync(join(to, "old.cjs")), false);
  assert.equal(existsSync(from), false);

  mkdirSync(from);
  writeFileSync(join(from, "main.cjs"), "renamed");
  replaceDirectory(from, to);
  assert.equal(readFileSync(join(to, "main.cjs"), "utf8"), "renamed");
  assert.equal(existsSync(from), false);
  rmSync(home, { recursive: true, force: true });
});

test("restoreOwnership is a harmless no-op for the platforms it cannot apply to", async () => {
  // On win32 (and for any non-root process) it must simply return without touching anything.
  const home = mkdtempSync(join(tmpdir(), "zc-home-"));
  writeFileSync(join(home, "config.json"), "{}");
  const { restoreOwnership } = await import("../src/installer/zcode.ts");
  restoreOwnership(home);
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), "{}");
  rmSync(home, { recursive: true, force: true });
});

test("macZCodeRunning only counts processes whose executable is this install", () => {
  const exe = "/Applications/ZCode.app/Contents/MacOS/ZCode";
  const other = "/Users/k/Desktop/ZCode.app/Contents/MacOS/ZCode"; // e.g. a copy left running from a DMG
  const run = (command: string, args: string[]) => {
    if (command === "pgrep") return "501 502\n";
    return args[args.length - 1] === "501" ? `${other}\n` : `${exe}\n`;
  };
  assert.equal(macZCodeRunning(exe, run), true);
});

test("macZCodeRunning sees a ZCode it runs inside of, and the main process's bare command name", () => {
  const exe = "/Applications/ZCode.app/Contents/MacOS/ZCode";
  const calls: string[] = [];
  // As measured on macOS: from ZCode's own terminal, plain pgrep hides ZCode (an ancestor), and
  // ps gives the Electron main process as "ZCode"; lsof lists its executable first among txt files.
  const run = (command: string, args: string[]) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "pgrep") {
      if (!args.includes("-a")) throw new Error("exit 1");
      return "86255\n";
    }
    if (command === "ps") return "ZCode\n";
    if (command === "lsof") return `p86255\nftxt\nn${exe}\nftxt\nn/usr/lib/dyld\n`;
    throw new Error(`unexpected ${command}`);
  };
  assert.equal(macZCodeRunning(exe, run), true);
  assert.deepEqual(calls, ["pgrep -a -x ZCode", "ps -o comm= -p 86255", "lsof -w -a -p 86255 -d txt -Fn"]);
  // A bare-named main process from another copy (a mounted DMG) still does not count.
  const dmg = (command: string, args: string[]) => (command === "lsof" ? "p86255\nftxt\nn/Volumes/ZCode/ZCode.app/Contents/MacOS/ZCode\n" : run(command, args));
  assert.equal(macZCodeRunning(exe, dmg), false);
  // lsof failing (the process just exited) is no evidence either way.
  const gone = (command: string, args: string[]) => {
    if (command === "lsof") throw new Error("lsof: no process");
    return run(command, args);
  };
  assert.equal(macZCodeRunning(exe, gone), false);
});

test("macZCodeRunning reports false when every same-named process is another install", () => {
  const run = (command: string) =>
    command === "pgrep" ? "501\n" : "/Users/k/Desktop/ZCode.app/Contents/MacOS/ZCode\n";
  assert.equal(macZCodeRunning("/Applications/ZCode.app/Contents/MacOS/ZCode", run), false);
});

test("macZCodeRunning reports false when pgrep finds nothing", () => {
  const run = () => {
    throw new Error("pgrep: no processes found");
  };
  assert.equal(macZCodeRunning("/Applications/ZCode.app/Contents/MacOS/ZCode", run), false);
});

test("macZCodeRunning survives a process exiting mid-check and matches the canonical path", () => {
  const dir = mkdtempSync(join(tmpdir(), "zc-exe-"));
  const exe = join(dir, "ZCode");
  writeFileSync(exe, "");
  const canonical = realpathSync(exe);
  const run = (command: string, args: string[]) => {
    if (command === "pgrep") return "1 2\n";
    if (args[args.length - 1] === "1") throw new Error("process gone"); // exited between pgrep and ps
    return `${canonical}\n`;
  };
  assert.equal(macZCodeRunning(exe, run), true);
  rmSync(dir, { recursive: true, force: true });
});
