// Hot reload for the Canvas runtime: config and theme edits under the Canvas home re-style the
// running ZCode. Kept free of electron imports so it can be tested outside ZCode.
import { watch, type FSWatcher } from "node:fs";

/**
 * Collapses reload triggers from every source — panel writes, CLI writes, manual edits, and the
 * watcher's own events — into one delayed call, so a single logical change reloads once instead of
 * once per source that noticed it.
 */
export function debounced(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

/**
 * Watches `home` recursively and calls `onChange` (debounced) when anything but the runtime's own
 * log or the desktop pet's position changes. Watch errors — the home deleted by `zcode-canvas restore --purge`, a filesystem
 * that drops a recursive watch, permissions — are logged and close the watcher: hot reload quietly
 * stops instead of surfacing an unhandled 'error' event, which would crash ZCode's main process.
 */
export function watchHome(home: string, onChange: () => void, log: (message: string) => void, debounceMs = 150): FSWatcher {
  const schedule = debounced(onChange, debounceMs);
  const watcher = watch(home, { recursive: true }, (_event, file) => {
    if (file && /runtime\.log|pet-position\.json/.test(String(file))) return;
    schedule();
  });
  watcher.on("error", (error) => {
    log(`watch failed, hot reload disabled until ZCode restarts: ${String(error)}`);
    watcher.close();
  });
  return watcher;
}
