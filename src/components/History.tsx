import Link from "next/link";
import { RANGES, type Range } from "@/lib/history";
import { formatCents } from "@/lib/money";

/** The range presets above a chart, and the table view beneath it. */

export function RangeFilter({ range, basePath }: { range: Range; basePath: string }) {
  return (
    <nav aria-label="Date range" className="flex flex-wrap gap-2">
      {RANGES.map((r) => (
        <Link
          key={r.value}
          href={r.value === "30d" ? basePath : `${basePath}?range=${r.value}`}
          aria-current={r.value === range ? "true" : undefined}
          scroll={false}
          className={`rounded-full border px-3 py-1 text-xs ${
            r.value === range ? "border-text bg-text font-semibold text-ink" : "border-line text-muted hover:border-muted-dim"
          }`}
        >
          {r.label}
        </Link>
      ))}
    </nav>
  );
}

/** Under a chart with estimated days: what the dashes mean, for the kinds of account among them. */
export function EstimateNote({ cards, investments }: { cards: boolean; investments: boolean }) {
  return (
    <p className="text-xs text-muted">
      Dashed days are estimates from before an account was linked.
      {cards && " Bank and card balances are worked back from their transactions."}
      {investments &&
        " Investment accounts are rougher: money put in and taken out is known, and the rest is put down to growth at the forecast's assumed return, as it was when the account was linked."}
    </p>
  );
}

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Every day in the chart, newest first — the chart's values without hovering. */
export function HistoryTable({ rows, label }: { rows: { day: string; cents: number | null; estimated?: boolean }[]; label: string }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted">Show as a table</summary>
      <div className="mt-3 max-h-80 overflow-y-auto rounded-lg border border-line-soft">
        <table className="w-full">
          <thead className="sticky top-0 bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Day</th>
              <th className="px-3 py-2 text-right font-medium">{label}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {[...rows].reverse().map((r) => (
              <tr key={r.day}>
                <td className="px-3 py-1.5">{dayFormat.format(new Date(`${r.day}T12:00:00Z`))}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.estimated && <span className="mr-2 text-xs text-muted">est.</span>}
                  {r.cents === null ? "—" : formatCents(r.cents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
