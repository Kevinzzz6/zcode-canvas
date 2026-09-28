import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesPanelShortcut, type ShortcutInput } from "../src/runtime/shortcut.ts";

const press = (overrides: Partial<ShortcutInput>): ShortcutInput => ({ type: "keyDown", key: "o", control: true, alt: true, shift: true, ...overrides });

test("the panel shortcut matches CommandOrControl+Alt+Shift+O per platform", () => {
  assert.equal(matchesPanelShortcut(press({}), "win32"), true);
  assert.equal(matchesPanelShortcut(press({ control: false, meta: true }), "darwin"), true);
  assert.equal(matchesPanelShortcut(press({}), "darwin"), false); // plain Ctrl is not Command on macOS
  assert.equal(matchesPanelShortcut(press({ meta: true }), "linux"), true);
  // Shift makes the delivered key uppercase; that still counts.
  assert.equal(matchesPanelShortcut(press({ key: "O" }), "win32"), true);
});

test("nothing else fires it", () => {
  const wrong: ShortcutInput[] = [
    press({ type: "keyUp" }),
    press({ isAutoRepeat: true }),
    press({ key: "p" }),
    press({ control: false }),
    press({ alt: false }),
    press({ shift: false }),
    { type: "keyDown" },
    {},
  ];
  for (const input of wrong) {
    assert.equal(matchesPanelShortcut(input, "win32"), false, JSON.stringify(input));
    assert.equal(matchesPanelShortcut(input, "darwin"), false, JSON.stringify(input));
  }
});
