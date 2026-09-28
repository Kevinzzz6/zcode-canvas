// Matching for the in-window panel shortcut. Kept free of electron imports so it can be tested
// outside ZCode: main.ts wires it to every window's webContents "before-input-event".
//
// The shortcut deliberately lives inside ZCode's windows only. A globalShortcut would be a
// system-wide hotkey: it would steal the combination from other apps and fire while ZCode itself
// is recording a user shortcut.
export interface ShortcutInput {
  type?: string;
  key?: string;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  isAutoRepeat?: boolean;
}

/** CommandOrControl+Alt+Shift+O, as a before-input-event reports it on the given platform. */
export function matchesPanelShortcut(input: ShortcutInput, platform: NodeJS.Platform = process.platform): boolean {
  if (input.type !== "keyDown" || input.isAutoRepeat) return false;
  if (typeof input.key !== "string" || input.key.toLowerCase() !== "o") return false;
  const command = platform === "darwin" ? input.meta : input.control;
  return command === true && input.alt === true && input.shift === true;
}
