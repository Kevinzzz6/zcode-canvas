import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BOOT_PATH, bootSource, inspect, readArchive, readFile, writePatched, writeRestored } from "../src/installer/asar.ts";

/** Builds a minimal archive the same way @electron/asar lays it out. */
function makeArchive(dir: string): string {
  const files: Array<[string, Buffer]> = [
    ["package.json", Buffer.from(JSON.stringify({ name: "@zcode/desktop", version: "9.9.9", type: "module", main: "out/main/index.js" }))],
    ["out/main/index.js", Buffer.from("console.log('zcode');\n")],
    ["out/renderer/index.html", Buffer.from("<!doctype html><div id=root></div>")],
  ];
  const header: { files: Record<string, unknown> } = { files: {} };
  let offset = 0;
  for (const [path, data] of files) {
    const parts = path.split("/");
    let node = header as { files: Record<string, unknown> };
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} };
      node = node.files[part] as { files: Record<string, unknown> };
    }
    node.files[parts.at(-1)!] = { size: data.length, offset: String(offset) };
    offset += data.length;
  }
  const json = Buffer.from(JSON.stringify(header));
  const aligned = (json.length + 3) & ~3;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + aligned, 4);
  prefix.writeUInt32LE(4 + aligned, 8);
  prefix.writeUInt32LE(json.length, 12);
  const file = join(dir, "app.asar");
  writeFileSync(file, Buffer.concat([prefix, json, Buffer.alloc(aligned - json.length), ...files.map(([, d]) => d)]));
  return file;
}

test("patch points main at the bootstrap and keeps original files readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "zc-asar-"));
  const original = makeArchive(dir);
  const patched = join(dir, "patched.asar");
  writePatched(readArchive(original), patched, "0.0.0-test");

  const archive = readArchive(patched);
  const state = inspect(archive);
  assert.equal(state.patched, true);
  assert.equal(state.zcodeVersion, "9.9.9");
  assert.equal(state.main, "out/main/index.js");
  assert.equal(JSON.parse(readFile(archive, "package.json").toString()).main, BOOT_PATH);
  assert.equal(readFile(archive, BOOT_PATH).toString(), bootSource("out/main/index.js"));
  assert.equal(readFile(archive, "out/main/index.js").toString(), "console.log('zcode');\n");
  assert.match(bootSource("out/main/index.js"), /await import\("\.\.\/main\/index\.js"\);/);
});

test("restore reproduces the original archive byte for byte", () => {
  const dir = mkdtempSync(join(tmpdir(), "zc-asar-"));
  const original = makeArchive(dir);
  const patched = join(dir, "patched.asar");
  const restored = join(dir, "restored.asar");
  writePatched(readArchive(original), patched, "0.0.0-test");
  writeRestored(readArchive(patched), restored);
  assert.deepEqual(readFileSync(restored), readFileSync(original));
  assert.equal(inspect(readArchive(restored)).patched, false);
});

test("re-patching a patched archive starts from the pristine state", () => {
  const dir = mkdtempSync(join(tmpdir(), "zc-asar-"));
  const original = makeArchive(dir);
  const once = join(dir, "once.asar");
  const twice = join(dir, "twice.asar");
  writePatched(readArchive(original), once, "0.0.0-test");
  writePatched(readArchive(once), twice, "0.0.0-test");
  assert.deepEqual(readFileSync(twice), readFileSync(once));
});

test("an archive modified after patching is refused instead of corrupted", () => {
  const dir = mkdtempSync(join(tmpdir(), "zc-asar-"));
  const original = makeArchive(dir);
  const patched = join(dir, "patched.asar");
  writePatched(readArchive(original), patched, "0.0.0-test");
  const patchedBytes = readFileSync(patched);

  // Another mod appends data after the Canvas patch: restore and re-patch must both refuse rather
  // than truncate the file under a header that still references the addition.
  writeFileSync(patched, Buffer.concat([patchedBytes, Buffer.from("intruder")]));
  assert.throws(() => writeRestored(readArchive(patched), join(dir, "r.asar")), /modified by something else/);
  assert.throws(() => writePatched(readArchive(patched), join(dir, "p2.asar"), "0.0.0-test"), /modified by something else/);

  // An in-place edit in the middle of the file is caught the same way (a byte inside the
  // bootstrap text, so the record on either side of it stays readable).
  const flipped = Buffer.from(patchedBytes);
  const archive = readArchive(patched);
  const inBoot = archive.dataOffset + (inspect(archive).restore?.originalDataSize ?? 0) + 100;
  flipped[inBoot] = (flipped[inBoot] ?? 0) ^ 0x20;
  writeFileSync(patched, flipped);
  assert.throws(() => writeRestored(readArchive(patched), join(dir, "r2.asar")), /modified by something else/);

  // With the modification undone, restoring reproduces the original byte for byte again.
  writeFileSync(patched, patchedBytes);
  const restored = join(dir, "restored.asar");
  writeRestored(readArchive(patched), restored);
  assert.deepEqual(readFileSync(restored), readFileSync(original));
});
