/** Shared preload/main gate. No host DOM knowledge; auxiliary pages must never get Canvas UI. */
export function isMainWindowUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:" && /\/out\/renderer\/index\.html$/.test(parsed.pathname) &&
      !parsed.searchParams.has("windowKind");
  } catch { return false; }
}
