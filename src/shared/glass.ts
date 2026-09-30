// The translucency model shared by the CSS generator, the palette's readability check, the panel and
// the session preload. Pure: no node or DOM imports.
//
// ZCode paints in layers: the window frame (which is also what the sidebar shows, it has no background
// of its own), the main pane on top of it, and cards / the prompt input on top of that. Each region
// can have its own opacity; a region without one follows the global glass.opacity.

export type GlassRegion = "frame" | "main" | "card" | "input";

export const GLASS_REGIONS: readonly GlassRegion[] = ["frame", "main", "card", "input"];

/** Regions whose surfaces take a backdrop blur. The frame never does: a backdrop-filter there would
 *  become the backdrop root of everything inside it and cut the main pane's blur off the wallpaper. */
export const BLUR_REGIONS: readonly GlassRegion[] = ["main", "card", "input"];

/** Tailwind background utilities of each region's surfaces, which take its backdrop blur. */
export const BLURRED_SURFACES: Record<GlassRegion, readonly string[]> = {
  frame: [],
  main: [".bg-background", ".bg-panel"],
  card: [".bg-card"],
  input: [".bg-input"],
};

/**
 * Outline for the surfaces a region's controls act on, inserted by the session preload while one is in
 * use; "" for none. Built from the blur's own selectors, plus the window frame the frame region is.
 * Lives here, not in css.ts, because the sandboxed preload cannot load node modules. The outline is
 * drawn inside each box, so nothing moves.
 */
export function regionHighlightCss(region: GlassRegion | null): string {
  if (!region) return "";
  const selectors = region === "frame" ? ["[data-desktop-window-frame]"] : BLURRED_SURFACES[region];
  return `${selectors.map((s) => `#root ${s}`).join(",\n")} {\n  outline: 2px solid var(--color-primary) !important;\n  outline-offset: -2px !important;\n}\n`;
}

export interface GlassRegionSpec {
  /** Opacity of this region, 0..1, used instead of glass.opacity. */
  opacity?: number;
  /** Backdrop blur of this region, px, used instead of glass.blur. Not for the frame. */
  blur?: number;
}

export interface ResolvedRegion {
  opacity: number;
  blur: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Alpha (0..1) of each region's own surfaces; 1 leaves the official color untouched. A region behaves
 * as if glass.opacity were its own opacity: the frame stays clearer (×0.7), the main pane's alpha is
 * derived so that frame and main together show exactly its opacity, and raised surfaces keep half of
 * the remaining opacity so text stays readable. A main pane asked to be clearer than the frame under
 * it bottoms out at alpha 0: it cannot show less than the frame does.
 */
export function regionAlphas(regions: Record<GlassRegion, ResolvedRegion>): Record<GlassRegion, number> {
  const frame = regions.frame.opacity >= 1 ? 1 : regions.frame.opacity * 0.7;
  const main = regions.main.opacity;
  const raised = (opacity: number) => (opacity >= 1 ? 1 : 1 - (1 - opacity) * 0.5);
  return {
    frame,
    main: main >= 1 ? 1 : frame >= 1 ? main : clamp01(1 - (1 - main) / (1 - frame)),
    card: raised(regions.card.opacity),
    input: raised(regions.input.opacity),
  };
}

/** True when the main pane is set clearer than the frame under it lets it look. */
export function mainCappedByFrame(regions: Record<GlassRegion, ResolvedRegion>): boolean {
  const frame = regionAlphas(regions).frame;
  return regions.main.opacity < 1 && frame < 1 && regions.main.opacity < frame - 1e-9;
}
