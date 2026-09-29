import type { PanelInput } from "./panel.ts";

/** One complete stylesheet at a time: omitted rules (e.g. blur=0) really disappear.
 * Coalesce pending requests; a late preview may never overwrite a commit or another window's CSS. */
export function createPreviewController(fetch: (input: PanelInput) => Promise<{ css: string }>, apply: (css: string) => void) {
  let base = "";
  let version = 0;
  let active = false;
  let running = false;
  type Request = { input: PanelInput; version: number; resolve: () => void; reject: (error: unknown) => void };
  let queued: Request | undefined;
  async function drain() {
    if (running || !queued) return;
    const request = queued;
    queued = undefined;
    running = true;
    try {
      const result = await fetch(request.input);
      if (active && request.version === version) {
        if (typeof result?.css !== "string") throw new Error("invalid preview response");
        apply(result.css);
      }
      request.resolve();
    } catch (error) {
      if (active && request.version === version) {
        active = false;
        let failure = error;
        try { apply(base); } catch (restoreError) { failure = restoreError; }
        request.reject(failure);
      } else request.resolve();
    } finally {
      running = false;
      void drain();
    }
  }
  return {
    setBase(css: string) { base = css; if (!active) apply(css); },
    preview(input: PanelInput): Promise<void> {
      active = true;
      const nextVersion = ++version;
      queued?.resolve();
      return new Promise((resolve, reject) => {
        queued = { input: { ...input }, version: nextVersion, resolve, reject };
        void drain();
      });
    },
    clear() {
      ++version;
      active = false;
      queued?.resolve(); queued = undefined;
      apply(base);
    },
  };
}
