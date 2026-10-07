import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exeName, installationAt } from "../src/installer/zcode.ts";
import { canvasHome } from "../src/shared/look.ts";

/** Lays out a fake install dir the way the official packages do on each platform. */
function fakeInstall(root: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    const base = join(root, "ZCode.app", "Contents");
    mkdirSync(join(base, "MacOS"), { recursive: true });
    mkdirSync(join(base, "Resources"), { recursive: true });
    writeFileSync(join(base, "MacOS", "ZCode"), "");
    writeFileSync(join(base, "Resources", "app.asar"), "");
    return join(root, "ZCode.app");
  }
  mkdirSync(join(root, "resources"), { recursive: true });
  writeFileSync(join(root, exeName(platform)), "");
  writeFileSync(join(root, "resources", "app.asar"), "");
  return root;
}

test("windows installs resolve ZCode.exe and resources\\app.asar", () => {
  const root = mkdtempSync(join(tmpdir(), "zc-win-"));
  fakeInstall(root, "win32");
  const install = installationAt(root, "win32");
  assert.ok(install);
  assert.equal(install.exe, join(root, "ZCode.exe"));
  assert.equal(install.asar, join(root, "resources", "app.asar"));
  assert.equal(install.dir, root);
});

test("linux installs resolve the zcode executable from /opt-style dirs", () => {
  const root = mkdtempSync(join(tmpdir(), "zc-linux-"));
  fakeInstall(root, "linux");
  const install = installationAt(root, "linux");
  assert.ok(install);
  assert.equal(install.exe, join(root, "zcode"));
  assert.equal(install.asar, join(root, "resources", "app.asar"));
});

test("darwin installs accept both the bundle path and its parent", () => {
  const root = mkdtempSync(join(tmpdir(), "zc-mac-"));
  const bundle = fakeInstall(root, "darwin");
  for (const input of [bundle, root]) {
    const install = installationAt(input, "darwin");
    assert.ok(install);
    assert.equal(install.dir, bundle);
    assert.equal(install.exe, join(bundle, "Contents", "MacOS", "ZCode"));
    assert.equal(install.asar, join(bundle, "Contents", "Resources", "app.asar"));
  }
});

test("dirs without the expected executable are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "zc-none-"));
  mkdirSync(join(root, "resources"), { recursive: true });
  writeFileSync(join(root, "resources", "app.asar"), "");
  assert.equal(installationAt(root, "win32"), null);
  assert.equal(installationAt(root, "linux"), null);
  assert.equal(installationAt(root, "darwin"), null);
  assert.equal(installationAt(undefined, "linux"), null);
});

test("canvas home follows SUDO_USER so sudo apply still installs for the real user", () => {
  const own = join(homedir(), ".zcode-canvas");
  const alice = join(process.platform === "darwin" ? "/Users/alice" : "/home/alice", ".zcode-canvas");
  assert.equal(canvasHome({ ZCODE_CANVAS_HOME: "/custom" }, 0), "/custom");
  assert.equal(canvasHome({ SUDO_USER: "alice" }, 0), alice, "running as root under sudo");
  assert.equal(canvasHome({ SUDO_USER: "alice" }, undefined), alice, "no uids at all (Windows)");
  assert.equal(canvasHome({ SUDO_USER: "alice" }, 501), own, "a non-root process with a leftover SUDO_USER keeps its own home");
  assert.equal(canvasHome({ SUDO_USER: "root" }, 0), own);
  assert.equal(canvasHome({}, 0), own);
});
