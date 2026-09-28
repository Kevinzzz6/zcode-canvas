// Hot reload for the Canvas runtime: config and theme edits under the Canvas home re-style the
// running ZCode. Kept free of electron imports so it can be tested outside ZCode.
import { watch, type FSWatcher } from "node:fs";

/**
 * Watches `home` recursively and calls `onChange` (debounced) when anything but the runtime's own
 * log changes. Watch errors — the home deleted by `zcode-canvas restore --purge`, a filesystem
 * that drops a recursive watch, permissions — are logged and close the watcher: hot reload quietly
 * stops instead of surfacing an unhandled 'error' event, which would crash ZCode's main process.
 */
export function watchHome(home: string, onChange: () => void, log: (message: string) => void, debounceMs = 150): FSWatcher {
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(home, { recursive: true }, (_event, file) => {
    if (file && /runtime\.log/.test(String(file))) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  });
  watcher.on("error", (error) => {
    log(`watch failed, hot reload disabled until ZCode restarts: ${String(error)}`);
    watcher.close();
  });
  return watcher;
}
