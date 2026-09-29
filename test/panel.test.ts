import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { loadLook, readConfig, writeConfigAtomic, type CanvasConfig } from "../src/shared/look.ts";
import { CHANNEL_PANEL_APPLY, CHANNEL_PANEL_GET, CHANNEL_PANEL_PICK_WALLPAPER } from "../src/shared/protocol.ts";
import {
  applyPanelInput,
  importWallpaperFile,
  readPanelData,
  registerPanelHandlers,
  storedWallpaperPath,
  wallpaperDisplayName,
  type PanelIpc,
} from "../src/runtime/panel.ts";

/** The content tag importWallpaperFile puts into stored wallpaper names. */
const tag = (data: string): string => createHash("sha256").update(data).digest("hex").slice(0, 12);

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
  assert.equal(after.theme, "mine");
  assert.equal(after.wallpaper, undefined); // the override is gone, not an explicit `null`
  // The flow from the bug report: clear, then switch to a wallpapered theme — its wallpaper must
  // actually resolve, not stay blank until some knob is nudged.
  const switched = applyPanelInput(after, { theme: "builtinwp" }, home);
  writeConfigAtomic(home, switched);
  const { look } = loadLook(home);
  assert.equal(look?.wallpaper.dark?.image, join(home, "runtime", "themes", "builtinwp", "bg.png"));
  assert.equal(look?.wallpaper.light?.image, join(home, "runtime", "themes", "builtinwp", "bg.png"));
  assert.equal(look?.wallpaper.dark?.blur, 0); // the old tuning died with the override
  assert.equal(readPanelData(home).wallpaper.fromTheme, true);
});

test("fit / blur / dim update in place and keep wallpaper.image", () => {
  const home = makeHome();
  const before: CanvasConfig = { theme: "mine", wallpaper: { image: "/w/pic.jpg", fit: "cover" } };
  const after = applyPanelInput(
    before,
    { fit: "contain", blur: 12, dim: 0.6, scale: 1.5, saturate: 0.5, brightness: 1.2, contrast: 0.9, grayscale: 1 },
    home,
  );
  assert.equal(after.wallpaper?.image, "/w/pic.jpg");
  assert.equal(after.wallpaper?.fit, "contain");
  assert.equal(after.wallpaper?.blur, 12);
  assert.equal(after.wallpaper?.dim, 0.6);
  assert.equal(after.wallpaper?.scale, 1.5);
  assert.equal(after.wallpaper?.saturate, 0.5);
  assert.equal(after.wallpaper?.brightness, 1.2);
  assert.equal(after.wallpaper?.contrast, 0.9);
  assert.equal(after.wallpaper?.grayscale, 1);
  for (
    const bad of [
      { fit: "stretch" },
      { blur: -1 },
      { blur: 201 },
      { blur: "lots" },
      { dim: 1.5 },
      { dim: -0.1 },
      { scale: 0.05 },
      { scale: 5 },
      { saturate: -1 },
      { brightness: 3 },
      { contrast: 9 },
      { grayscale: 2 },
    ] as const
  ) {
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

test("importWallpaperFile stores images under content-tagged names", () => {
  const home = makeHome();
  const source = join(home, "picker", "My Wallpaper.png");
  mkdirSync(join(home, "picker"), { recursive: true });
  writeFileSync(source, "png-data");
  const destination = importWallpaperFile(source, home);
  assert.equal(destination, join(home, "imports", "wallpaper", `My-Wallpaper-${tag("png-data")}.png`));
  assert.equal(readFileSync(destination, "utf8"), "png-data");
  // Re-picking the same content reuses the stored file.
  assert.equal(importWallpaperFile(source, home), destination);
  // Different content under the same name never overwrites what is already stored.
  writeFileSync(source, "png-data-2");
  const second = importWallpaperFile(source, home);
  assert.notEqual(second, destination);
  assert.equal(readFileSync(destination, "utf8"), "png-data");
  assert.equal(readFileSync(second, "utf8"), "png-data-2");
  assert.deepEqual(readdirSync(join(home, "imports", "wallpaper")).sort(), [basename(destination), basename(second)].sort());
  // A name with no safe characters left falls back to a fixed one.
  writeFileSync(join(home, "picker", "壁纸.png"), "x");
  assert.equal(basename(importWallpaperFile(join(home, "picker", "壁纸.png"), home)), `wallpaper-${tag("x")}.png`);
});

test("wallpaperDisplayName hides the content tag, old names pass through", () => {
  assert.equal(wallpaperDisplayName(`pic-${tag("z")}.jpg`), "pic.jpg");
  assert.equal(wallpaperDisplayName("old-style.jpg"), "old-style.jpg");
  assert.equal(wallpaperDisplayName("no-extension"), "no-extension");
});

test("importWallpaperFile rejects non-image formats", () => {
  const home = makeHome();
  mkdirSync(join(home, "picker"), { recursive: true });
  for (const name of ["a.txt", "b.exe", "c.mp4", "d.pkg", "e.scene", "f.webm", "noext"]) {
    writeFileSync(join(home, "picker", name), "x");
    assert.throws(() => importWallpaperFile(join(home, "picker", name), home), { message: /不支持的壁纸格式/ }, name);
  }
  writeFileSync(join(home, "picker", "UPPER.PNG"), "x");
  assert.ok(importWallpaperFile(join(home, "picker", "UPPER.PNG"), home).endsWith(`UPPER-${tag("x")}.png`));
  // A picked gif is stored like any other image; Chromium plays its animation in the background.
  writeFileSync(join(home, "picker", "loop.gif"), "gif");
  assert.ok(importWallpaperFile(join(home, "picker", "loop.gif"), home).endsWith(`loop-${tag("gif")}.gif`));
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
  const source = join(home, "picker", "evil.png");
  mkdirSync(join(home, "picker"), { recursive: true });
  writeFileSync(source, "x");
  try {
    symlinkSync(join(home, "secret.txt"), join(home, "imports", "wallpaper", "evil.png"));
    // The name importWallpaperFile will actually compute for this content.
    symlinkSync(join(home, "secret.txt"), join(home, "imports", "wallpaper", `evil-${tag("x")}.png`));
  } catch (error) {
    return t.skip(`symlinks need privileges here: ${String(error)}`);
  }
  assert.throws(() => storedWallpaperPath(home, "evil.png"), { message: /escapes the store/ });
  // Importing a file whose stored (content-tagged) name collides with the symlink fails closed.
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
function harness(
  home: string,
  pickWallpaperFile: () => Promise<string | null>,
  isPanelSender: (event: unknown) => boolean = () => true,
) {
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
    isPanelSender,
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
  const stored = join(home, "imports", "wallpaper", `chosen-${tag("webp")}.webp`);

  const picked = (await listeners.get(CHANNEL_PANEL_PICK_WALLPAPER)!(undefined)) as { canceled: boolean; file: string };
  assert.deepEqual(picked, { canceled: false, file: "chosen.webp" });
  const config = readConfig(home);
  assert.equal(config.theme, "mine"); // picking a wallpaper must not clear the theme
  assert.equal(config.wallpaper?.image, stored);
  assert.equal(reloads.length, 1);

  // A canceled dialog changes nothing.
  const canceling = harness(home, async () => null);
  assert.deepEqual(await canceling.listeners.get(CHANNEL_PANEL_PICK_WALLPAPER)!(undefined), { canceled: true });
  assert.equal(readConfig(home).wallpaper?.image, stored);
  assert.equal(canceling.reloads.length, 0);
});

test("requests that do not come from the panel window are refused and change nothing", async () => {
  const home = makeHome();
  withWallpaperOverride(home);
  const stranger = harness(home, async () => null, () => false);
  for (const channel of [CHANNEL_PANEL_GET, CHANNEL_PANEL_APPLY, CHANNEL_PANEL_PICK_WALLPAPER]) {
    await assert.rejects(
      async () => {
        await stranger.listeners.get(channel)!({ sender: { id: 1 } });
      },
      /refused/,
      channel,
    );
  }
  assert.ok(stranger.logged.length >= 3, "every refusal is logged");
  assert.equal(stranger.reloads.length, 0);
  assert.equal(readConfig(home).theme, "mine"); // nothing was executed
});

test("the apply handler writes the merged config to disk and triggers a reload", async () => {
  const home = makeHome();
  withWallpaperOverride(home);
  const { listeners, reloads } = harness(home, async () => null);
  const result = await listeners.get(CHANNEL_PANEL_APPLY)!(undefined, { theme: null, wallpaper: null });
  assert.deepEqual(result, { ok: true });
  const config = readConfig(home);
  assert.equal(config.theme, null);
  assert.equal(config.wallpaper, undefined);
  assert.equal(reloads.length, 1);
  // After a reset no override lingers: switching to a wallpapered theme shows its wallpaper.
  await listeners.get(CHANNEL_PANEL_APPLY)!(undefined, { theme: "builtinwp" });
  const { look } = loadLook(home);
  assert.equal(look?.wallpaper.dark?.image, join(home, "runtime", "themes", "builtinwp", "bg.png"));
  // Invalid requests reject (the renderer shows them) without writing anything.
  await assert.rejects(async () => {
    await listeners.get(CHANNEL_PANEL_APPLY)!(undefined, { theme: "nope" });
  });
  assert.equal(readConfig(home).theme, "builtinwp");
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
  registerPanelHandlers({
    home,
    ipc,
    log: (m) => logged.push(m),
    pickWallpaperFile: async () => null,
    reload: () => reloads.push("r"),
    isPanelSender: () => true,
  });
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
