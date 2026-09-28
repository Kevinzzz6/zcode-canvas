import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { readConfig, writeConfigAtomic, type CanvasConfig } from "../src/shared/look.ts";
import { CHANNEL_PANEL_APPLY, CHANNEL_PANEL_GET, CHANNEL_PANEL_PICK_WALLPAPER } from "../src/shared/protocol.ts";
import {
  applyPanelInput,
  importWallpaperFile,
  readPanelData,
  registerPanelHandlers,
  storedWallpaperPath,
  type PanelIpc,
} from "../src/runtime/panel.ts";

/** A fake canvas home with one built-in theme (wallpapered) and one user theme. */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zc-panel-"));
  mkdirSync(join(home, "runtime", "themes", "builtinwp"), { recursive: true });
  writeFileSync(
    join(home, "runtime", "themes", "builtinwp", "theme.json"),
    JSON.stringify({ name: "Builtin WP", wallpaper: { image: "bg.png" } }),
  );
  mkdirSync(join(home, "themes", "mine"), { recursive: true });
  writeFileSync(join(home, "themes", "mine", "theme.json"), JSON.stringify({ name: "Mine", accent: "#123456" }));
  return home;
}

function withWallpaperOverride(home: string): void {
  writeConfigAtomic(home, { theme: "mine", wallpaper: { image: join(home, "imports", "wallpaper", "pic.jpg") } });
}

test("readPanelData lists built-in and user themes and reports the current wallpaper", () => {
  const home = makeHome();
  withWallpaperOverride(home);
  const data = readPanelData(home);
  assert.deepEqual(
    data.themes,
    [
      { id: "builtinwp", name: "Builtin WP", builtin: true },
      { id: "mine", name: "Mine", builtin: false },
    ],
  );
  assert.equal(data.config.theme, "mine");
  assert.equal(data.wallpaper.file, "pic.jpg");
  assert.equal(data.wallpaper.fromTheme, false);

  // Without an override, the active theme's own wallpaper is what shows.
  writeConfigAtomic(home, { theme: "builtinwp" });
  const themed = readPanelData(home);
  assert.equal(themed.wallpaper.file, null);
  assert.equal(themed.wallpaper.fromTheme, true);
  writeConfigAtomic(home, {});
  assert.equal(readPanelData(home).wallpaper.fromTheme, false);
});

test("picking a theme only changes config.theme and never clears the wallpaper override", () => {
  const home = makeHome();
  const before: CanvasConfig = { theme: "mine", wallpaper: { image: "/w/pic.jpg", dim: 0.4 }, accent: "#7c5cff" };
  const after = applyPanelInput(before, { theme: "builtinwp" }, home);
  assert.equal(after.theme, "builtinwp");
  assert.equal(after.wallpaper?.image, "/w/pic.jpg");
  assert.equal(after.wallpaper?.dim, 0.4);
  assert.equal(after.accent, "#7c5cff");
});

test("clearing the theme keeps the user's own wallpaper", () => {
  const home = makeHome();
  const before: CanvasConfig = { theme: "mine", wallpaper: { image: "/w/pic.jpg" } };
  const after = applyPanelInput(before, { theme: null }, home);
  assert.equal(after.theme, null);
  assert.equal(after.wallpaper?.image, "/w/pic.jpg");
});

test("clearing the wallpaper lets the theme's wallpaper show again, theme untouched", () => {
  const home = makeHome();
  const before: CanvasConfig = { theme: "mine", wallpaper: { image: "/w/pic.jpg", blur: 8 } };
  const after = applyPanelInput(before, { wallpaper: null }, home);
  assert.equal(after.wallpaper, null);
  assert.equal(after.theme, "mine");
  // And the panel reports the fallback correctly.
  writeConfigAtomic(home, after);
  writeConfigAtomic(home, { theme: "builtinwp" });
  assert.equal(readPanelData(home).wallpaper.fromTheme, true);
});

test("fit / blur / dim update in place and keep wallpaper.image", () => {
  const home = makeHome();
  const before: CanvasConfig = { theme: "mine", wallpaper: { image: "/w/pic.jpg", fit: "cover" } };
  const after = applyPanelInput(before, { fit: "contain", blur: 12, dim: 0.6 }, home);
  assert.equal(after.wallpaper?.image, "/w/pic.jpg");
  assert.equal(after.wallpaper?.fit, "contain");
  assert.equal(after.wallpaper?.blur, 12);
  assert.equal(after.wallpaper?.dim, 0.6);
  for (const bad of [{ fit: "stretch" }, { blur: -1 }, { blur: 201 }, { blur: "lots" }, { dim: 1.5 }, { dim: -0.1 }] as const) {
    assert.throws(() => applyPanelInput(before, bad, home), Error, JSON.stringify(bad));
  }
});

test("unknown themes and renderer-supplied wallpaper paths are rejected", () => {
  const home = makeHome();
  const config: CanvasConfig = { theme: null };
  assert.throws(() => applyPanelInput(config, { theme: "nope" }, home), /unknown theme/);
  assert.throws(() => applyPanelInput(config, { theme: 42 }, home), /unknown theme/);
  // The panel renderer never gets to name a file: only the native dialog (main process) does.
  assert.throws(() => applyPanelInput(config, { wallpaper: "/etc/passwd" }, home), /file dialog/);
  assert.throws(() => applyPanelInput(config, "nonsense" as unknown as Record<string, unknown>, home), /invalid panel request/);
});

test("importWallpaperFile copies picked images into the store under a whitelisted name", () => {
  const home = makeHome();
  const source = join(home, "picker", "My Wallpaper.png");
  mkdirSync(join(home, "picker"), { recursive: true });
  writeFileSync(source, "png-data");
  const destination = importWallpaperFile(source, home);
  assert.equal(destination, join(home, "imports", "wallpaper", "My-Wallpaper.png"));
  assert.equal(readFileSync(destination, "utf8"), "png-data");
  // Re-picking the same name replaces the stored copy instead of piling up files.
  writeFileSync(source, "png-data-2");
  assert.equal(importWallpaperFile(source, home), destination);
  assert.equal(readFileSync(destination, "utf8"), "png-data-2");
  assert.deepEqual(readdirSync(join(home, "imports", "wallpaper")), ["My-Wallpaper.png"]);
  // A name with no safe characters left falls back to a fixed one.
  writeFileSync(join(home, "picker", "壁纸.png"), "x");
  assert.equal(basename(importWallpaperFile(join(home, "picker", "壁纸.png"), home)), "wallpaper.png");
});

test("importWallpaperFile rejects non-image formats", () => {
  const home = makeHome();
  mkdirSync(join(home, "picker"), { recursive: true });
  for (const name of ["a.txt", "b.exe", "c.mp4", "d.pkg", "e.scene", "f.gif", "noext"]) {
    writeFileSync(join(home, "picker", name), "x");
    assert.throws(() => importWallpaperFile(join(home, "picker", name), home), { message: /不支持的壁纸格式/ }, name);
  }
  writeFileSync(join(home, "picker", "UPPER.PNG"), "x");
  assert.ok(importWallpaperFile(join(home, "picker", "UPPER.PNG"), home).endsWith("UPPER.png"));
  assert.throws(() => importWallpaperFile(join(home, "picker", "missing.png"), home), /不可用/);
});

test("storedWallpaperPath rejects traversal and anything but a flat whitelisted name", () => {
  const home = makeHome();
  for (const name of ["../config.json", "..\\config.json", "a/b.png", "a\\b.png", "..", "...", ".hidden.png", "a..b.png", "", "x y.png"]) {
    assert.throws(() => storedWallpaperPath(home, name), { message: /invalid wallpaper file name/ }, JSON.stringify(name));
  }
  assert.equal(storedWallpaperPath(home, "ok.png"), join(home, "imports", "wallpaper", "ok.png"));
});

test("a symlink inside the store pointing out of it is refused, not written through", (t: TestContext) => {
  const home = makeHome();
  mkdirSync(join(home, "imports", "wallpaper"), { recursive: true });
  writeFileSync(join(home, "secret.txt"), "config data");
  try {
    symlinkSync(join(home, "secret.txt"), join(home, "imports", "wallpaper", "evil.png"));
  } catch (error) {
    return t.skip(`symlinks need privileges here: ${String(error)}`);
  }
  assert.throws(() => storedWallpaperPath(home, "evil.png"), { message: /escapes the store/ });
  // Importing a file whose stored name collides with the symlink fails closed.
  const source = join(home, "picker", "evil.png");
  mkdirSync(join(home, "picker"), { recursive: true });
  writeFileSync(source, "x");
  assert.throws(() => importWallpaperFile(source, home), { message: /escapes the store/ });
  assert.equal(readFileSync(join(home, "secret.txt"), "utf8"), "config data");
});

test("writeConfigAtomic replaces the config fully and leaves no temp files behind", () => {
  const home = makeHome();
  writeConfigAtomic(home, { theme: "mine", accent: "#111111" });
  writeConfigAtomic(home, { theme: null, wallpaper: { image: "/w/pic.jpg" } });
  assert.deepEqual(
    readdirSync(home).filter((name) => name.startsWith("config.json")),
    ["config.json"],
  );
  assert.deepEqual(readConfig(home), { enabled: true, theme: null, wallpaper: { image: "/w/pic.jpg" } });
});

/** Registers the handlers on a stub ipc and returns the captured listeners. */
function harness(home: string, pickWallpaperFile: () => Promise<string | null>) {
  const listeners = new Map<string, (event: unknown, value?: unknown) => unknown>();
  const ipc: PanelIpc = { handle: (channel, listener) => listeners.set(channel, listener) };
  const reloads: string[] = [];
  const logged: string[] = [];
  registerPanelHandlers({
    home,
    ipc,
    log: (message) => logged.push(message),
    pickWallpaperFile,
    reload: () => reloads.push("reload"),
  });
  return { listeners, reloads, logged };
}

test("the pick handler stores the chosen file as wallpaper.image and keeps the theme", async () => {
  const home = makeHome();
  withWallpaperOverride(home);
  const source = join(home, "picker", "chosen.webp");
  mkdirSync(join(home, "picker"), { recursive: true });
  writeFileSync(source, "webp");
  const { listeners, reloads } = harness(home, async () => source);

  const picked = (await listeners.get(CHANNEL_PANEL_PICK_WALLPAPER)!(undefined)) as { canceled: boolean; file: string };
  assert.deepEqual(picked, { canceled: false, file: "chosen.webp" });
  const config = readConfig(home);
  assert.equal(config.theme, "mine"); // picking a wallpaper must not clear the theme
  assert.equal(config.wallpaper?.image, join(home, "imports", "wallpaper", "chosen.webp"));
  assert.equal(reloads.length, 1);

  // A canceled dialog changes nothing.
  const canceling = harness(home, async () => null);
  assert.deepEqual(await canceling.listeners.get(CHANNEL_PANEL_PICK_WALLPAPER)!(undefined), { canceled: true });
  assert.equal(readConfig(home).wallpaper?.image, join(home, "imports", "wallpaper", "chosen.webp"));
  assert.equal(canceling.reloads.length, 0);
});

test("the apply handler writes the merged config to disk and triggers a reload", async () => {
  const home = makeHome();
  withWallpaperOverride(home);
  const { listeners, reloads } = harness(home, async () => null);
  const result = await listeners.get(CHANNEL_PANEL_APPLY)!(undefined, { theme: null, wallpaper: null });
  assert.deepEqual(result, { ok: true });
  const config = readConfig(home);
  assert.equal(config.theme, null);
  assert.equal(config.wallpaper, null);
  assert.equal(reloads.length, 1);
  // Invalid requests reject (the renderer shows them) without writing anything.
  await assert.rejects(async () => {
    await listeners.get(CHANNEL_PANEL_APPLY)!(undefined, { theme: "nope" });
  });
  assert.equal(readConfig(home).theme, null);
});

test("a channel that cannot be registered is logged and skipped; the rest still works", async () => {
  const home = makeHome();
  const listeners = new Map<string, (event: unknown, value?: unknown) => unknown>();
  const logged: string[] = [];
  // e.g. a second runtime instance already owns the get channel.
  const ipc: PanelIpc = {
    handle: (channel, listener) => {
      if (channel === CHANNEL_PANEL_GET) throw new Error("handler already registered");
      listeners.set(channel, listener);
    },
  };
  const reloads: string[] = [];
  registerPanelHandlers({ home, ipc, log: (m) => logged.push(m), pickWallpaperFile: async () => null, reload: () => reloads.push("r") });
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /panel-get unavailable/);
  assert.ok(listeners.has(CHANNEL_PANEL_APPLY), "apply still registered");
  assert.ok(listeners.has(CHANNEL_PANEL_PICK_WALLPAPER), "pick still registered");
  await listeners.get(CHANNEL_PANEL_APPLY)!(undefined, { theme: "mine" });
  assert.equal(readConfig(home).theme, "mine");
});

test("the panel window stays context-isolated, node-free and sandboxed", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/runtime/main.ts", import.meta.url)), "utf8");
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /sandbox:\s*true/);
});
