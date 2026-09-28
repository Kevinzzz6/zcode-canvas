// Surgical app.asar patching.
//
// The archive format is: [uint32 4][uint32 headerPickleSize][uint32 payloadSize][uint32 jsonLength]
// [header JSON][padding to 4 bytes][file data...]. File offsets in the header are relative to the
// start of the data region, so the data region can be copied verbatim behind a new header.
//
// A patch leaves every original byte of the data region untouched and appends three files:
//   package.json                 same as the original, with "main" pointing at the bootstrap
//   out/zcode-canvas/boot.mjs    loads the Canvas runtime, then the original entry
//   out/zcode-canvas/restore.json  the original package.json entry, data size and archive hash
// Restoring rewrites the original header and truncates the appended bytes, which reproduces the
// original file byte for byte.
//
// Patching is deterministic, so the exact bytes of a Canvas-patched archive can be recomputed from
// its restore record. Before restoring or re-patching, the archive on disk is compared against that
// expectation: if another tool touched it in the meantime, the record no longer describes the file
// and any rewrite could corrupt the archive, so the operation is refused instead.
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { posix } from "node:path";

export const CANVAS_DIR = "zcode-canvas";
export const BOOT_PATH = `out/${CANVAS_DIR}/boot.mjs`;
const BLOCK_SIZE = 4 * 1024 * 1024;

export interface AsarEntry {
  files?: Record<string, AsarEntry>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
  executable?: boolean;
  link?: string;
  integrity?: { algorithm: "SHA256"; hash: string; blockSize: number; blocks: string[] };
}

export interface AsarHeader {
  files: Record<string, AsarEntry>;
}

export interface AsarArchive {
  path: string;
  header: AsarHeader;
  dataOffset: number;
  dataSize: number;
}

export interface RestoreRecord {
  canvasVersion: string;
  originalMain: string;
  originalDataSize: number;
  /** sha256 of the pristine archive, verified after a restore. Absent in records written before this field existed. */
  originalHash?: string;
  packageJson: AsarEntry;
}

export interface PatchState {
  patched: boolean;
  zcodeVersion: string;
  main: string;
  restore: RestoreRecord | null;
}

export function readArchive(path: string): AsarArchive {
  const fd = openSync(path, "r");
  try {
    const prefix = Buffer.alloc(16);
    readSync(fd, prefix, 0, 16, 0);
    const headerPickleSize = prefix.readUInt32LE(4);
    const jsonLength = prefix.readUInt32LE(12);
    const json = Buffer.alloc(jsonLength);
    readSync(fd, json, 0, jsonLength, 16);
    const dataOffset = 8 + headerPickleSize;
    return {
      path,
      header: JSON.parse(json.toString("utf8")) as AsarHeader,
      dataOffset,
      dataSize: fstatSync(fd).size - dataOffset,
    };
  } finally {
    closeSync(fd);
  }
}

function findEntry(header: AsarHeader, file: string): AsarEntry | undefined {
  let node: AsarEntry | undefined = { files: header.files };
  for (const part of file.split("/")) node = node?.files?.[part];
  return node;
}

export function readEntry(archive: AsarArchive, entry: AsarEntry): Buffer {
  if (entry.unpacked || entry.size == null || entry.offset == null) throw new Error("entry is not packed in the archive");
  const fd = openSync(archive.path, "r");
  try {
    const buffer = Buffer.alloc(entry.size);
    readSync(fd, buffer, 0, entry.size, archive.dataOffset + Number(entry.offset));
    return buffer;
  } finally {
    closeSync(fd);
  }
}

export function readFile(archive: AsarArchive, file: string): Buffer {
  const entry = findEntry(archive.header, file);
  if (!entry) throw new Error(`${file} not found in ${archive.path}`);
  return readEntry(archive, entry);
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function sha256File(path: string): string {
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) return hash.digest("hex");
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
}

function fileEntry(data: Buffer, offset: number): AsarEntry {
  const blocks: string[] = [];
  for (let i = 0; i < data.length; i += BLOCK_SIZE) blocks.push(sha256(data.subarray(i, i + BLOCK_SIZE)));
  if (blocks.length === 0) blocks.push(sha256(Buffer.alloc(0)));
  return {
    size: data.length,
    offset: String(offset),
    integrity: { algorithm: "SHA256", hash: sha256(data), blockSize: BLOCK_SIZE, blocks },
  };
}

export function inspect(archive: AsarArchive): PatchState {
  const pkg = JSON.parse(readFile(archive, "package.json").toString("utf8")) as { version: string; main: string };
  const restoreEntry = findEntry(archive.header, `out/${CANVAS_DIR}/restore.json`);
  const restore = restoreEntry ? (JSON.parse(readEntry(archive, restoreEntry).toString("utf8")) as RestoreRecord) : null;
  return { patched: restore != null, zcodeVersion: pkg.version, main: restore?.originalMain ?? pkg.main, restore };
}

/** The archive as it was before any Canvas patch: header and length of the original data region. */
function pristine(archive: AsarArchive, restore: RestoreRecord | null): { header: AsarHeader; dataSize: number } {
  if (!restore) return { header: archive.header, dataSize: archive.dataSize };
  const header = structuredClone(archive.header);
  header.files["package.json"] = restore.packageJson;
  delete header.files.out?.files?.[CANVAS_DIR];
  return { header, dataSize: restore.originalDataSize };
}

export function bootSource(originalMain: string): string {
  const specifier = posix.relative(posix.dirname(BOOT_PATH), originalMain);
  return `// ZCode Canvas bootstrap: loads the appearance runtime from the user's profile, then ZCode.
// Set ZCODE_CANVAS_DISABLE=1 to start ZCode without it. Undo with \`zcode-canvas restore\`.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

if (process.env.ZCODE_CANVAS_DISABLE !== "1") {
  try {
    const home = process.env.ZCODE_CANVAS_HOME || join(homedir(), ".zcode-canvas");
    const runtime = join(home, "runtime", "main.cjs");
    if (existsSync(runtime)) createRequire(import.meta.url)(runtime);
  } catch (error) {
    console.error("[zcode-canvas] runtime failed to load:", error);
  }
}

await import(${JSON.stringify(specifier.startsWith(".") ? specifier : `./${specifier}`)});
`;
}

function headerBytes(header: AsarHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const aligned = (json.length + 3) & ~3;
  const buffer = Buffer.alloc(16 + aligned);
  buffer.writeUInt32LE(4, 0);
  buffer.writeUInt32LE(8 + aligned, 4);
  buffer.writeUInt32LE(4 + aligned, 8);
  buffer.writeUInt32LE(json.length, 12);
  json.copy(buffer, 16);
  return buffer;
}

function writeHeader(fd: number, header: AsarHeader): number {
  const bytes = headerBytes(header);
  writeSync(fd, bytes, 0, bytes.length, 0);
  return bytes.length;
}

interface PatchPlan {
  header: AsarHeader;
  dataSize: number;
  extra: Buffer[];
  record: RestoreRecord;
}

/** Everything a Canvas patch of `source`'s pristine state consists of. Fully deterministic, so
 *  running it twice — once here, once when the patch was written — yields identical bytes. */
function planPatch(source: AsarArchive, base: { header: AsarHeader; dataSize: number }, canvasVersion: string, originalHash?: string): PatchPlan {
  const originalPackage = readEntry(source, base.header.files["package.json"]!);
  const pkg = JSON.parse(originalPackage.toString("utf8")) as { main?: string };
  const originalMain = pkg.main ?? "index.js";

  const packageJson = Buffer.from(JSON.stringify({ ...pkg, main: BOOT_PATH }, null, 2), "utf8");
  const boot = Buffer.from(bootSource(originalMain), "utf8");
  const record: RestoreRecord = {
    canvasVersion,
    originalMain,
    originalDataSize: base.dataSize,
    originalHash,
    packageJson: base.header.files["package.json"]!,
  };
  const restore = Buffer.from(JSON.stringify(record, null, 2), "utf8");

  const header = structuredClone(base.header);
  let offset = base.dataSize;
  const place = (data: Buffer) => {
    const entry = fileEntry(data, offset);
    offset += data.length;
    return entry;
  };
  header.files["package.json"] = place(packageJson);
  const out = (header.files.out ??= { files: {} });
  out.files![CANVAS_DIR] = { files: { "boot.mjs": place(boot), "restore.json": place(restore) } };
  return { header, dataSize: base.dataSize, extra: [packageJson, boot, restore], record };
}

/** sha256 of the archive writeArchive(source, target, header, dataSize, extra) would produce. */
function plannedArchiveHash(source: AsarArchive, plan: { header: AsarHeader; dataSize: number; extra: Buffer[] }): string {
  const hash = createHash("sha256");
  hash.update(headerBytes(plan.header));
  const fd = openSync(source.path, "r");
  try {
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    for (let copied = 0; copied < plan.dataSize; ) {
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, plan.dataSize - copied), source.dataOffset + copied);
      if (read === 0) throw new Error("unexpected end of archive");
      hash.update(chunk.subarray(0, read));
      copied += read;
    }
  } finally {
    closeSync(fd);
  }
  for (const buffer of plan.extra) hash.update(buffer);
  return hash.digest("hex");
}

/** True when the archive on disk is exactly the patch its restore record describes. */
function untouchedSincePatch(source: AsarArchive, base: { header: AsarHeader; dataSize: number }, restore: RestoreRecord): boolean {
  const plan = planPatch(source, base, restore.canvasVersion, restore.originalHash);
  return sha256File(source.path) === plannedArchiveHash(source, plan);
}

function modifiedAfterPatchError(path: string): Error {
  return new Error(
    `${path} was modified by something else after the Canvas patch. Rewriting it could corrupt the archive, ` +
      "so Canvas refuses to continue. Reinstall ZCode (or put back its official app.asar) first.",
  );
}

function writeArchive(source: AsarArchive, target: string, header: AsarHeader, dataSize: number, extra: Buffer[]) {
  const input = openSync(source.path, "r");
  const output = openSync(target, "w");
  try {
    let position = writeHeader(output, header);
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    for (let copied = 0; copied < dataSize; ) {
      const read = readSync(input, chunk, 0, Math.min(chunk.length, dataSize - copied), source.dataOffset + copied);
      if (read === 0) throw new Error("unexpected end of archive");
      writeSync(output, chunk, 0, read, position);
      position += read;
      copied += read;
    }
    for (const buffer of extra) {
      writeSync(output, buffer, 0, buffer.length, position);
      position += buffer.length;
    }
  } finally {
    closeSync(input);
    closeSync(output);
  }
}

/** Writes a patched copy of `source` to `target`. Re-patching an already patched archive starts from the pristine state. */
export function writePatched(source: AsarArchive, target: string, canvasVersion: string) {
  const previous = inspect(source).restore;
  const base = pristine(source, previous);
  if (previous && !untouchedSincePatch(source, base, previous)) throw modifiedAfterPatchError(source.path);
  const originalHash = previous?.originalHash ?? sha256File(source.path);
  const plan = planPatch(source, base, canvasVersion, originalHash);
  writeArchive(source, target, plan.header, plan.dataSize, plan.extra);
}

/** Writes the original, unpatched archive to `target`. */
export function writeRestored(source: AsarArchive, target: string) {
  const previous = inspect(source).restore;
  if (!previous) throw new Error(`${source.path} carries no Canvas patch`);
  const base = pristine(source, previous);
  if (!untouchedSincePatch(source, base, previous)) throw modifiedAfterPatchError(source.path);
  writeArchive(source, target, base.header, base.dataSize, []);
  // The caller only moves the result over the real app.asar once this function returned.
  if (previous.originalHash && sha256File(target) !== previous.originalHash)
    throw new Error(`restoring ${source.path} did not reproduce the original archive byte for byte`);
}
