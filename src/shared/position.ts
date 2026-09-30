// CSS background-position read back as the panel's two sliders. Pure string math, no node or DOM
// imports: the main process writes positions through it and the preload displays them through it,
// so a slider always shows the axes the next write will keep.

/**
 * The X and Y percentages of a one- or two-part position (keywords or 0..100%), or null when the
 * value is anything the sliders cannot represent (calc(), lengths, three or four parts, >100%).
 */
export function positionAxes(value: string | undefined): [number, number] | null {
  if (!value) return null;
  const keywords: Record<string, number> = { left: 0, top: 0, center: 50, right: 100, bottom: 100 };
  const parts = value.trim().toLowerCase().split(/\s+/);
  const axis = (part: string): number | null => {
    if (part in keywords) return keywords[part]!;
    const match = /^(\d+(?:\.\d+)?)%$/.exec(part);
    if (!match) return null;
    const n = Number(match[1]);
    return n <= 100 ? n : null;
  };
  if (parts.length === 1) {
    const n = axis(parts[0]!);
    if (n === null) return null;
    return parts[0] === "top" || parts[0] === "bottom" ? [50, n] : [n, 50];
  }
  if (parts.length !== 2) return null;
  const vertical = (part: string) => part === "top" || part === "bottom";
  const horizontal = (part: string) => part === "left" || part === "right";
  const reversed = vertical(parts[0]!) && (horizontal(parts[1]!) || parts[1] === "center");
  const x = axis(parts[reversed ? 1 : 0]!);
  const y = axis(parts[reversed ? 0 : 1]!);
  return x === null || y === null ? null : [x, y];
}
