import { build } from "esbuild";
import { copyFileSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const common = { bundle: true, platform: "node", target: "node20", logLevel: "info" };

await build({
  ...common,
  entryPoints: ["src/cli/index.ts"],
  outfile: "dist/cli.js",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
});

// Loaded inside ZCode's Electron main process; must be CommonJS so the bootstrap can require() it
// synchronously before ZCode's own entry runs.
await build({
  ...common,
  entryPoints: ["src/runtime/main.ts"],
  outfile: "dist/runtime/main.cjs",
  format: "cjs",
  external: ["electron"],
});

// Session preloads run sandboxed: a single self-contained file, only `electron` may be required.
await build({
  ...common,
  entryPoints: ["src/runtime/preload.ts"],
  outfile: "dist/runtime/preload.cjs",
  format: "cjs",
  platform: "browser",
  external: ["electron"],
});

// Desktop mode's own page: its preload (sandboxed, like the one above) and its page script, a plain
// browser script without any electron access.
await build({
  ...common,
  entryPoints: ["src/runtime/pet-desktop-preload.ts"],
  outfile: "dist/runtime/pet-desktop-preload.cjs",
  format: "cjs",
  platform: "browser",
  external: ["electron"],
});
await build({
  ...common,
  entryPoints: ["src/runtime/pet-desktop-page.ts"],
  outfile: "dist/runtime/pet-desktop.js",
  format: "iife",
  platform: "browser",
});
copyFileSync("src/runtime/pet-desktop.html", "dist/runtime/pet-desktop.html");
