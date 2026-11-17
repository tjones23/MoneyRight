/**
 * The income chart's colors, by source slot. A plain module rather than the
 * chart's "use client" one, so server components can call it too: on the
 * server, a function exported from a client module is only a reference.
 */

const SERIES = 6;

/** −1 (or past the palette) is "Everything else". */
export function seriesColor(slot: number): string {
  return slot < 0 || slot >= SERIES ? "var(--series-other)" : `var(--series-${slot + 1})`;
}
