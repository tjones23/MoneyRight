"use client";

import { useState, type KeyboardEvent } from "react";
import { niceTicks } from "@/lib/history";
import { formatCents } from "@/lib/money";
import { seriesColor } from "@/lib/series-color";

/**
 * Money in per period as stacked columns, a segment per source. Columns are
 * capped at 24px with a 4px rounded top, segments split by a 2px surface
 * gap, and gridlines stay recessive. Hover or arrow keys read a column out
 * in a tooltip; the legend above names every color, and the page's table
 * carries every value, so nothing depends on telling hues apart.
 */

export interface IncomeChartSource {
  key: string;
  label: string;
  /** −1 for "Everything else". */
  slot: number;
}

export interface IncomeChartPeriod {
  key: string;
  /** Under the column: "Nov", "Q4 '26". */
  short: string;
  /** In the tooltip: "November 2026", "Week of Nov 9". */
  long: string;
  bySource: Record<string, number>;
  totalCents: number;
  /** "so far", "from Nov 20" — why the column isn't a whole period. */
  note?: string;
  empty: boolean;
}

const compact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });

/** Bottom of the stack first: in color order, so neighbours are the pairs the palette was checked for. */
function stackOrder(sources: IncomeChartSource[]): IncomeChartSource[] {
  return [...sources].sort((a, b) => (a.slot < 0 ? 1 : b.slot < 0 ? -1 : a.slot - b.slot));
}

export function IncomeLegend({ sources }: { sources: IncomeChartSource[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {stackOrder(sources).map((s) => (
        <li key={s.key} className="flex min-w-0 items-center gap-1.5">
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: seriesColor(s.slot) }} aria-hidden />
          <span className="max-w-[14rem] truncate">{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function IncomeChart({ periods, sources, label }: { periods: IncomeChartPeriod[]; sources: IncomeChartSource[]; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  const stack = stackOrder(sources);
  const max = Math.max(0, ...periods.map((p) => p.totalCents));
  if (max <= 0) {
    return (
      <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">
        No money in over these {label.toLowerCase()} yet.
      </p>
    );
  }
  const ticks = niceTicks(0, max);
  const hi = ticks[ticks.length - 1];
  // About six labels along the bottom, counted back from the newest.
  const every = Math.ceil(periods.length / 6);
  const labelled = (i: number) => (periods.length - 1 - i) % every === 0;
  const shown = active === null ? null : periods[active];

  function onKey(e: KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const from = active ?? periods.length - 1;
    const last = periods.length - 1;
    setActive(e.key === "Home" ? 0 : e.key === "End" ? last : Math.min(last, Math.max(0, from + (e.key === "ArrowRight" ? 1 : -1))));
  }

  const newest = periods[periods.length - 1];
  const summary = `Money in by source, ${periods.length} ${label.toLowerCase()} from ${periods[0].long} to ${newest.long}, peaking at ${formatCents(max, { whole: true })}. Use the arrow keys to read each one.`;

  return (
    <div className="select-none">
      <div
        role="img"
        aria-label={summary}
        tabIndex={0}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive(periods.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
        className="relative ml-10 h-56 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {/* Gridlines, with their values in the gutter to the left. */}
        {ticks.map((t) => (
          <div key={t} className="pointer-events-none absolute inset-x-0" style={{ bottom: `${(t / hi) * 100}%` }}>
            <div className={`h-px ${t === 0 ? "bg-line" : "bg-line-soft"}`} />
            <span className="absolute -left-10 w-9 -translate-y-1/2 text-right text-[11px] tabular-nums text-muted-dim">
              {compact.format(t / 100)}
            </span>
          </div>
        ))}

        <div className="absolute inset-0 flex">
          {periods.map((p, i) => (
            <div
              key={p.key}
              onPointerEnter={() => setActive(i)}
              onPointerDown={() => setActive(i)}
              className="relative flex h-full flex-1 items-end justify-center"
            >
              <div
                className="flex w-[60%] max-w-6 flex-col-reverse gap-[2px] overflow-hidden rounded-t transition-opacity"
                style={{ height: `${(Math.max(0, p.totalCents) / hi) * 100}%`, opacity: active === null || active === i ? 1 : 0.45 }}
              >
                {stack.map((s) => {
                  const cents = p.bySource[s.key] ?? 0;
                  return cents > 0 ? (
                    <div key={s.key} style={{ flex: `${cents} 1 0`, background: seriesColor(s.slot) }} className="min-h-px" />
                  ) : null;
                })}
              </div>
            </div>
          ))}
        </div>

        {shown && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-56 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm shadow-lg"
            style={
              active! >= periods.length / 2
                ? { right: `calc(${((periods.length - active!) / periods.length) * 100}% + 4px)` }
                : { left: `calc(${((active! + 1) / periods.length) * 100}% + 4px)` }
            }
          >
            <p className="text-xs text-muted">
              {shown.long}
              {shown.note && ` · ${shown.note}`}
            </p>
            <p className="font-semibold tabular-nums">{shown.empty ? "Before your transactions" : formatCents(shown.totalCents, { whole: true })}</p>
            <ul className="mt-1 space-y-0.5 text-xs">
              {[...stack].reverse().map((s) =>
                shown.bySource[s.key] ? (
                  <li key={s.key} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: seriesColor(s.slot) }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-muted">{s.label}</span>
                    <span className="tabular-nums">{formatCents(shown.bySource[s.key], { whole: true })}</span>
                  </li>
                ) : null,
              )}
            </ul>
          </div>
        )}
      </div>
      <div className="ml-10 mt-1 flex text-[11px] text-muted-dim">
        {periods.map((p, i) => (
          <span key={p.key} className="flex-1 whitespace-nowrap text-center">
            {labelled(i) ? p.short : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
