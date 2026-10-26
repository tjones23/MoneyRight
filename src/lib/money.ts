/**
 * Money as integer cents, everywhere. Floats only appear at the edges —
 * Plaid's JSON numbers, the loan rate — and are rounded to cents there.
 */

/** "28575.02", "-12.5", "1,234" → cents; null for anything else. Exact: no float on the way. */
export function parseDecimalToCents(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const clean = value.trim().replace(/,/g, "").replace(/^\$/, "");
  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(clean);
  if (!match || (!match[2] && !match[3])) return null;
  const [, sign, whole, fraction = ""] = match;
  // Half-up on the third decimal, for the rare institution that sends one.
  const padded = (fraction + "000").slice(0, 3);
  let cents = Number(whole || "0") * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) cents += 1;
  return sign ? -cents : cents;
}

/** A JSON number of dollars (Plaid) → cents. */
export function dollarsToCents(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function formatCents(cents: number, { whole = false }: { whole?: boolean } = {}): string {
  return (whole ? usdWhole : usd).format(cents / 100);
}

/** With an explicit sign, for changes: "+$1,204.00", "−$88.10". */
export function formatChange(cents: number): string {
  if (cents === 0) return formatCents(0);
  return `${cents > 0 ? "+" : "−"}${formatCents(Math.abs(cents))}`;
}
