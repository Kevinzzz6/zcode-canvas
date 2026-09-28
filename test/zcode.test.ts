import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeArchive } from "./make-archive.ts";
import {
  applyPatch,
  deployRuntime,
  exeName,
  isPermanentRescueError,
  readState,
  removePatch,
  ResignError,
  runPendingSwap,
  runUpdateRescue,
  sudoOwner,
  type Installation,
} from "../src/installer/zcode.ts";

/** A fake install dir with a real (minimal) app.asar, laid out per the current platform. */
function fakeInstall(): Installation {
  const dir = mkdtempSync(join(tmpdir(), "zc-install-"));
  const resources = join(dir, "resources");
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(dir, exeName(process.platform)), "");
  return { dir, exe: join(dir, exeName(process.platform)), asar: makeArchive(resources) };
}

test("apply patches the archive, then reports it unchanged until the format or bootstrap moves", () => {
  const install = fakeInstall();
  assert.equal(applyPatch(install, "0.0.0-test", import.meta.filename), "replaced");
  assert.equal(applyPatch(install, "0.0.0-test", import.meta.filename), "unchanged");
  // Canvas version bumps alone do not rewrite the archive; only format/bootstrap changes do.
  assert.equal(applyPatch(install, "9.9.9-other", import.meta.filename), "unchanged");
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
  assert.equal(removePatch(install, import.meta.filename, () => null), "replaced");
  assert.equal(applyPatch(install, "0.0.0-test", import.meta.filename, () => null), "replaced");
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

test("rescue errors are permanent only where no retry can ever help", () => {
  const errno = (code: string) => Object.assign(new Error("boom"), { code });
  // POSIX: a root-owned install dir must fail fast, not spin for the whole deadline.
  assert.equal(isPermanentRescueError(errno("EACCES"), "linux"), true);
  assert.equal(isPermanentRescueError(errno("EPERM"), "darwin"), true);
  assert.equal(isPermanentRescueError(errno("EROFS"), "linux"), true);
  // Windows: those same codes are sharing violations while an installer/app still holds the file.
  assert.equal(isPermanentRescueError(errno("EACCES"), "win32"), false);
  assert.equal(isPermanentRescueError(errno("EBUSY"), "linux"), false);
  assert.equal(isPermanentRescueError(errno("EBUSY"), "win32"), false);
  // Parse races and re-sign failures are their own categories.
  assert.equal(isPermanentRescueError(new Error("bad header"), "linux"), false);
  assert.equal(isPermanentRescueError(new ResignError(fakeInstall(), "detail"), "win32"), true);
});

test("update rescue: a quiet, still-patched archive means an ordinary quit", async () => {
  const install = fakeInstall();
  applyPatch(install, "0.0.0-test", import.meta.filename);
  const logged: string[] = [];
  const outcome = await runUpdateRescue(install.dir, install.dir, import.meta.filename, (m) => logged.push(m), {
    pollMs: 1,
    settlePolls: 2,
    deadlineMs: 5_000,
  });
  assert.equal(outcome, "already-patched");
  assert.match(logged.join("\n"), /nothing to do/);
  // And the archive was not rewritten.
  assert.equal(readState(install).patched, true);
});

test("update rescue: re-patches a replaced archive once it settles", async () => {
  const install = fakeInstall();
  applyPatch(install, "0.0.0-test", import.meta.filename);
  const home = mkdtempSync(join(tmpdir(), "zc-rescue-"));
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(join(home, "runtime", "version.json"), JSON.stringify({ version: "0.0.0-test" }));
  // Simulate the official update: a fresh, unpatched archive lands on disk.
  makeArchive(join(install.dir, "resources"));
  const logged: string[] = [];
  const outcome = await runUpdateRescue(install.dir, home, import.meta.filename, (m) => logged.push(m), {
    pollMs: 1,
    settlePolls: 2,
    deadlineMs: 5_000,
  });
  assert.equal(outcome, "re-patched");
  const state = readState(install);
  assert.equal(state.patched, true);
  assert.equal(state.restore?.canvasVersion, "0.0.0-test");
  assert.match(logged.join("\n"), /re-applied the patch/);
  rmSync(home, { recursive: true, force: true });
});

test("update rescue: a pending apply/restore swap owns the archive and wins", async () => {
  const install = fakeInstall();
  parkPending(install, "job-1");
  const outcome = await runUpdateRescue(install.dir, install.dir, import.meta.filename, () => {}, {
    pollMs: 1,
    settlePolls: 1,
    deadlineMs: 1_000,
  });
  assert.equal(outcome, "pending-swap");
  assert.ok(statSync(`${install.asar}.canvas-pending`, { throwIfNoEntry: false }), "the parked file is untouched");
});

test("update rescue: a half-written archive is never patched; it times out instead", async () => {
  const install = fakeInstall();
  writeFileSync(install.asar, "installer is still writing this file");
  const outcome = await runUpdateRescue(install.dir, install.dir, import.meta.filename, () => {}, {
    pollMs: 1,
    settlePolls: 1,
    deadlineMs: 30,
  });
  assert.equal(outcome, "still-busy");
  assert.equal(readFileSync(install.asar, "utf8"), "installer is still writing this file");
});

test("update rescue: a vanished installation reports and does nothing", async () => {
  const outcome = await runUpdateRescue(join(tmpdir(), "zc-nowhere-"), join(tmpdir(), "zc-nowhere-"), import.meta.filename);
  assert.equal(outcome, "no-install");
});

test("deployRuntime ships the CLI copy the rescue helper runs", () => {
  const root = mkdtempSync(join(tmpdir(), "zc-pkg-"));
  const home = mkdtempSync(join(tmpdir(), "zc-home-"));
  mkdirSync(join(root, "dist", "runtime"), { recursive: true });
  writeFileSync(join(root, "dist", "runtime", "main.cjs"), "runtime");
  writeFileSync(join(root, "dist", "cli.js"), "#!/usr/bin/env node\n");
  mkdirSync(join(root, "themes", "t"), { recursive: true });
  writeFileSync(join(root, "themes", "t", "theme.json"), JSON.stringify({ name: "T" }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.0.0-test" }));
  deployRuntime(root, home);
  assert.equal(readFileSync(join(home, "runtime", "cli.mjs"), "utf8"), "#!/usr/bin/env node\n");
  assert.equal(readFileSync(join(home, "runtime", "main.cjs"), "utf8"), "runtime");
  assert.ok(existsSync(join(home, "runtime", "themes", "t", "theme.json")));
  rmSync(root, { recursive: true, force: true });
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
