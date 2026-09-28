import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BOOT_PATH,
  bootSource,
  inspect,
  isPatchCurrent,
  PATCH_FORMAT,
  readArchive,
  readEntry,
  readFile,
  writePatched,
  writeRestored,
  type PatchState,
} from "../src/installer/asar.ts";
import { makeArchive } from "./make-archive.ts";

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

test("an archive that already ships out/zcode-canvas is refused, not shadowed", () => {
  const dir = mkdtempSync(join(tmpdir(), "zc-asar-"));
  const original = makeArchive(dir, [["out/zcode-canvas/their-file.js", Buffer.from("someone else's payload\n")]]);
  assert.throws(() => writePatched(readArchive(original), join(dir, "p.asar"), "0.0.0-test"), /already contains zcode-canvas/);
  // Nothing was written and the original is untouched.
  assert.equal(inspect(readArchive(original)).patched, false);
});

test("patch records carry the patch format; older records count as outdated", () => {
  const dir = mkdtempSync(join(tmpdir(), "zc-asar-"));
  const patched = join(dir, "patched.asar");
  writePatched(readArchive(makeArchive(dir)), patched, "0.0.0-test");
  const state = inspect(readArchive(patched));
  assert.equal(state.restore?.patchFormat, PATCH_FORMAT);
  assert.equal(isPatchCurrent(readFile(readArchive(patched), BOOT_PATH).toString("utf8"), state), true);

  // A record from before the field existed (undefined) must not pass as current…
  const legacy: PatchState = { ...state, restore: { ...state.restore!, patchFormat: undefined } };
  assert.equal(isPatchCurrent(readFile(readArchive(patched), BOOT_PATH).toString("utf8"), legacy), false);
  // …and neither must a bootstrap this build would no longer write.
  assert.equal(isPatchCurrent("different bootstrap", state), false);
  // An unpatched archive is never current.
  mkdirSync(join(dir, "fresh-"), { recursive: true });
  const pristineState = inspect(readArchive(makeArchive(join(dir, "fresh-"))));
  assert.equal(isPatchCurrent(bootSource(pristineState.main), pristineState), false);
});

test("re-patching a patch from before patchFormat rewrites it with the current format", () => {
  const dir = mkdtempSync(join(tmpdir(), "zc-asar-"));
  const once = join(dir, "once.asar");
  writePatched(readArchive(makeArchive(dir)), once, "0.0.0-test");

  // Rebuild what an older Canvas wrote: same archive, but the restore record lacks patchFormat.
  // The header is re-serialized around the shorter record; data offsets are region-relative, so a
  // header of different length still yields a valid archive.
  const archive = readArchive(once);
  const restoreEntry = archive.header.files.out!.files!["zcode-canvas"]!.files!["restore.json"]!;
  const record = JSON.parse(readEntry(archive, restoreEntry).toString("utf8")) as Record<string, unknown>;
  delete record.patchFormat;
  const legacyContent = Buffer.from(JSON.stringify(record, null, 2), "utf8");
  const hash = createHash("sha256").update(legacyContent).digest("hex");
  const header = structuredClone(archive.header);
  // Re-derive the entry the way a patch plan does, integrity included, for the shorter record.
  header.files.out!.files!["zcode-canvas"]!.files!["restore.json"] = {
    size: legacyContent.length,
    offset: restoreEntry.offset,
    integrity: { algorithm: "SHA256", hash, blockSize: 4194304, blocks: [hash] },
  };
  const json = Buffer.from(JSON.stringify(header));
  const aligned = (json.length + 3) & ~3;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + aligned, 4);
  prefix.writeUInt32LE(4 + aligned, 8);
  prefix.writeUInt32LE(json.length, 12);
  const beforeRestore = readFileSync(once).subarray(archive.dataOffset, archive.dataOffset + archive.dataSize - restoreEntry.size!);
  const legacyAsar = join(dir, "legacy.asar");
  writeFileSync(legacyAsar, Buffer.concat([prefix, json, Buffer.alloc(aligned - json.length), beforeRestore, legacyContent]));

  // The legacy patch still verifies as untouched, and re-patching upgrades its record.
  const legacyState = inspect(readArchive(legacyAsar));
  assert.equal(legacyState.restore?.patchFormat, undefined);
  assert.equal(isPatchCurrent(readFile(readArchive(legacyAsar), BOOT_PATH).toString("utf8"), legacyState), false);
  const updated = join(dir, "updated.asar");
  writePatched(readArchive(legacyAsar), updated, "0.0.0-test");
  assert.equal(inspect(readArchive(updated)).restore?.patchFormat, PATCH_FORMAT);
  // And the upgraded patch still restores to the original bytes.
  const restored = join(dir, "restored.asar");
  writeRestored(readArchive(updated), restored);
  mkdirSync(join(dir, "fresh-"), { recursive: true });
  assert.deepEqual(readFileSync(restored), readFileSync(makeArchive(join(dir, "fresh-"))));
});

test("re-patching a patch from before originalHash migrates it to a verifiable record", () => {
  const dir = mkdtempSync(join(tmpdir(), "zc-asar-"));
  const once = join(dir, "once.asar");
  writePatched(readArchive(makeArchive(dir)), once, "0.0.0-test");

  // Rebuild what an older Canvas wrote: the same patch, but the restore record lacks originalHash
  // (same header-shrinking technique as the patchFormat test above).
  const archive = readArchive(once);
  const restoreEntry = archive.header.files.out!.files!["zcode-canvas"]!.files!["restore.json"]!;
  const record = JSON.parse(readEntry(archive, restoreEntry).toString("utf8")) as Record<string, unknown>;
  delete record.originalHash;
  const legacyContent = Buffer.from(JSON.stringify(record, null, 2), "utf8");
  const hash = createHash("sha256").update(legacyContent).digest("hex");
  const header = structuredClone(archive.header);
  header.files.out!.files!["zcode-canvas"]!.files!["restore.json"] = {
    size: legacyContent.length,
    offset: restoreEntry.offset,
    integrity: { algorithm: "SHA256", hash, blockSize: 4194304, blocks: [hash] },
  };
  const json = Buffer.from(JSON.stringify(header));
  const aligned = (json.length + 3) & ~3;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + aligned, 4);
  prefix.writeUInt32LE(4 + aligned, 8);
  prefix.writeUInt32LE(json.length, 12);
  const beforeRestore = readFileSync(once).subarray(archive.dataOffset, archive.dataOffset + archive.dataSize - restoreEntry.size!);
  const legacyAsar = join(dir, "legacy.asar");
  writeFileSync(legacyAsar, Buffer.concat([prefix, json, Buffer.alloc(aligned - json.length), beforeRestore, legacyContent]));
  assert.equal(inspect(readArchive(legacyAsar)).restore?.originalHash, undefined);

  // Re-patching migrates the record: the hash must describe the pristine base, not the patched
  // file it was read from (that value would brick every later restore).
  const updated = join(dir, "updated.asar");
  writePatched(readArchive(legacyAsar), updated, "0.0.0-test");
  mkdirSync(join(dir, "fresh-"), { recursive: true });
  const pristineHash = createHash("sha256").update(readFileSync(makeArchive(join(dir, "fresh-")))).digest("hex");
  assert.equal(inspect(readArchive(updated)).restore?.originalHash, pristineHash);
  const restored = join(dir, "restored.asar");
  writeRestored(readArchive(updated), restored);
  assert.deepEqual(readFileSync(restored), readFileSync(makeArchive(join(dir, "fresh-"))));
});

test("a truncated or non-asar file is rejected with a clear error, not garbage or an OOM", () => {
  const dir = mkdtempSync(join(tmpdir(), "zc-asar-"));
  const stub = join(dir, "app.asar");
  writeFileSync(stub, "not an asar at all");
  assert.throws(() => readArchive(stub), /not a readable asar archive/);

  // A 10-byte truncation of a real archive must fail cleanly too.
  const real = makeArchive(dir, []).slice(0);
  const full = readFileSync(real);
  writeFileSync(stub, full.subarray(0, 10));
  assert.throws(() => readArchive(stub), /not a readable asar archive/);

  // A header claiming a gigantic json length must be refused before the allocation.
  const evil = Buffer.from(full.subarray(0, 16));
  evil.writeUInt32LE(0xffff_0000, 12);
  writeFileSync(stub, Buffer.concat([evil, full.subarray(16)]));
  assert.throws(() => readArchive(stub), /not a readable asar archive/);
});

test("entries pointing outside the data region are refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "zc-asar-"));
  const file = makeArchive(dir);
  const archive = readArchive(file);
  const entry = archive.header.files.out!.files!.main!.files!["index.js"]!;
  assert.throws(() => readEntry(archive, { ...entry, offset: String(archive.dataSize - 2) }), /outside the data/);
  assert.throws(() => readEntry(archive, { ...entry, size: 10_000_000 }), /outside the data/);
  assert.throws(() => readEntry(archive, { ...entry, offset: "NaN" }), /outside the data/);
  // The untouched entry still reads fine.
  assert.equal(readEntry(archive, entry).toString(), "console.log('zcode');\n");
});
