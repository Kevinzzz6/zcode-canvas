import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Builds a minimal archive the same way @electron/asar lays it out. */
export function makeArchive(dir: string, extraFiles: Array<[string, Buffer]> = []): string {
  const files: Array<[string, Buffer]> = [
    ["package.json", Buffer.from(JSON.stringify({ name: "@zcode/desktop", version: "9.9.9", type: "module", main: "out/main/index.js" }))],
    ["out/main/index.js", Buffer.from("console.log('zcode');\n")],
    ["out/renderer/index.html", Buffer.from("<!doctype html><div id=root></div>")],
    ...extraFiles,
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
