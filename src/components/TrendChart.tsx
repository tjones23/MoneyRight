"use client";

import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { niceTicks } from "@/lib/history";
import { formatCents } from "@/lib/money";

/**
 * One series over time: a 2px line over a 10% wash, recessive gridlines,
 * a ringed end dot, and a crosshair that snaps to the nearest day with a
 * tooltip (pointer or arrow keys). Lines and fills are SVG stretched to the
 * box with non-scaling strokes; text and dots are HTML laid over it, so
 * nothing distorts at any width. Every value is also in the table view the
 * page puts beside it.
 */

export interface TrendPoint {
  day: string;
  cents: number | null;
}

const W = 1000;
const H = 100;

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const shortDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const compact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });

function utc(day: string) {
  return new Date(`${day}T12:00:00Z`);
}

export function TrendChart({ points, label }: { points: TrendPoint[]; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const geometry = useMemo(() => {
    const values = points.map((p) => p.cents).filter((c): c is number => c !== null);
    if (values.length < 2) return null;
    const ticks = niceTicks(Math.min(...values), Math.max(...values));
    const lo = ticks[0];
    const hi = ticks[ticks.length - 1];
    const x = (i: number) => (points.length === 1 ? 0 : (i / (points.length - 1)) * W);
    const y = (c: number) => H - ((c - lo) / (hi - lo)) * H;

    // A path per unbroken run of days with a value.
    let line = "";
    let area = "";
    let run: [number, number][] = [];
    const flush = () => {
      if (run.length) {
        line += run.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(2)}`).join("");
        area += `M${run[0][0].toFixed(1)},${H}` + run.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(2)}`).join("") + `L${run[run.length - 1][0].toFixed(1)},${H}Z`;
      }
      run = [];
    };
    points.forEach((p, i) => (p.cents === null ? flush() : run.push([x(i), y(p.cents)])));
    flush();

    let last = points.length - 1;
    while (last >= 0 && points[last].cents === null) last--;
    return { ticks, lo, hi, x, y, line, area, last, zero: lo < 0 && hi > 0 ? y(0) : null };
  }, [points]);

  if (!geometry) {
    return (
      <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">
        History builds up from each day&apos;s refresh — check back tomorrow for a trend.
      </p>
    );
  }

  const { ticks, x, y, line, area, last, zero } = geometry;
  const pct = (px: number) => `${(px / W) * 100}%`;
  const pctY = (py: number) => `${(py / H) * 100}%`;
  const shown = active ?? null;
  const shownPoint = shown !== null ? points[shown] : null;

  function nearest(clientX: number) {
    const rect = box.current!.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(ratio * (points.length - 1));
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const from = active ?? last;
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? points.length - 1 : Math.min(points.length - 1, Math.max(0, from + (e.key === "ArrowRight" ? 1 : -1)));
    setActive(next);
  }

  const first = points[0];
  const end = points[points.length - 1];
  const summary = `${label} from ${dayFormat.format(utc(first.day))} to ${dayFormat.format(utc(end.day))}${
    points[last]?.cents != null ? `, ending at ${formatCents(points[last].cents!)}` : ""
  }. Use the arrow keys to read each day.`;

  return (
    <div className="select-none">
      <div
        ref={box}
        role="img"
        aria-label={summary}
        tabIndex={0}
        onPointerMove={(e: PointerEvent) => setActive(nearest(e.clientX))}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive(last)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
        className="relative h-56 w-full cursor-crosshair touch-pan-y rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          {ticks.map((t) => (
            <line key={t} x1={0} x2={W} y1={y(t)} y2={y(t)} stroke="var(--line-soft)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {zero !== null && (
            <line x1={0} x2={W} y1={zero} y2={zero} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          )}
          <path d={area} fill="var(--chart-line)" opacity={0.1} />
          <path
            d={line}
            fill="none"
            stroke="var(--chart-line)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* Y ticks: muted, just above their gridlines. */}
        {ticks.map((t) => (
          <span
            key={t}
            className="pointer-events-none absolute left-0 -translate-y-full pb-0.5 text-[11px] tabular-nums text-muted-dim"
            style={{ top: pctY(y(t)) }}
          >
            {compact.format(t / 100)}
          </span>
        ))}

        {/* The end dot, ringed in the surface color. */}
        {points[last]?.cents != null && (
          <span
            className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              left: pct(x(last)),
              top: pctY(y(points[last].cents!)),
              background: "var(--chart-line)",
              boxShadow: "0 0 0 2px var(--surface)",
            }}
          />
        )}

        {shown !== null && shownPoint && (
          <>
            <span className="pointer-events-none absolute inset-y-0 w-px bg-muted-dim" style={{ left: pct(x(shown)) }} />
            {shownPoint.cents !== null && (
              <span
                className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{
                  left: pct(x(shown)),
                  top: pctY(y(shownPoint.cents)),
                  background: "var(--chart-line)",
                  boxShadow: "0 0 0 2px var(--surface)",
                }}
              />
            )}
            <div
              className="pointer-events-none absolute top-0 z-10 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm shadow-lg"
              style={
                x(shown) > W / 2
                  ? { right: `calc(${100 - (x(shown) / W) * 100}% + 10px)` }
                  : { left: `calc(${pct(x(shown))} + 10px)` }
              }
            >
              <p className="font-semibold tabular-nums">{shownPoint.cents === null ? "No balance yet" : formatCents(shownPoint.cents)}</p>
              <p className="text-xs text-muted">{dayFormat.format(utc(shownPoint.day))}</p>
            </div>
          </>
        )}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted-dim">
        <span>{shortDay.format(utc(first.day))}</span>
        <span>{shortDay.format(utc(end.day))}</span>
      </div>
    </div>
  );
}
