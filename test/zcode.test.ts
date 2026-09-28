import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeArchive } from "./make-archive.ts";
import {
  applyPatch,
  exeName,
  removePatch,
  ResignError,
  runPendingSwap,
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

test("restoreOwnership is a harmless no-op for the platforms it cannot apply to", async () => {
  // On win32 (and for any non-root process) it must simply return without touching anything.
  const home = mkdtempSync(join(tmpdir(), "zc-home-"));
  writeFileSync(join(home, "config.json"), "{}");
  const { restoreOwnership } = await import("../src/installer/zcode.ts");
  restoreOwnership(home);
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), "{}");
  rmSync(home, { recursive: true, force: true });
});
