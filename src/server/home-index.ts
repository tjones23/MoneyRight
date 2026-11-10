import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db";
import type { IndexPoint } from "@/lib/valuation";

/**
 * Home values by ZIP code: Zillow's Home Value Index (ZHVI — typical
 * single-family and condo value, middle tier, smoothed and seasonally
 * adjusted), one free public CSV, monthly, updated around the 16th.
 *
 * The whole national file is downloaded (~125 MB, a few seconds) and only
 * the ZIP codes someone here has a home in are kept — so the request itself
 * says nothing about where anyone lives. No key, no account; Zillow asks
 * that the data be credited to it, which the pages do.
 *
 * Zillow occasionally moves its CSVs; MONEYRIGHT_HOME_INDEX_URL overrides
 * the address.
 */

export const ZHVI_ZIP_URL =
  "https://files.zillowstatic.com/research/public_csvs/zhvi/Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv";

export function homeIndexUrl(): string {
  return process.env.MONEYRIGHT_HOME_INDEX_URL || ZHVI_ZIP_URL;
}

const DAY = 24 * 60 * 60_000;
/** Zillow publishes monthly; looking weekly catches each release within days. */
export const HOME_INDEX_EVERY_MS = 7 * DAY;
/** After a failure, or for a ZIP with no data yet, try again in a few hours. */
export const HOME_INDEX_RETRY_MS = 6 * 60 * 60_000;

const TIMEOUT_MS = 5 * 60_000;
const MAX_BYTES = 512 * 1024 * 1024;

export function isZip(value: string): boolean {
  return /^\d{5}$/.test(value);
}

/** One CSV record's fields: commas inside double quotes, and "" for a quote, survive. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      fields.push(field);
      field = "";
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

/**
 * Reads the ZHVI file line by line, keeping each wanted ZIP's monthly
 * readings. Columns: RegionID, SizeRank, RegionName (the ZIP), …, then one
 * per month named by its last day ("2026-09-30").
 */
export async function readZhvi(lines: AsyncIterable<string>, wanted: Set<string>): Promise<Map<string, IndexPoint[]>> {
  const found = new Map<string, IndexPoint[]>();
  let months: { column: number; month: string }[] | null = null;
  let zipColumn = -1;
  for await (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line) continue;
    if (!months) {
      const header = parseCsvLine(line);
      zipColumn = header.indexOf("RegionName");
      if (zipColumn < 0) throw new Error("Home index file has no RegionName column");
      months = header
        .map((name, column) => ({ column, name }))
        .filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.name))
        .map((h) => ({ column: h.column, month: h.name.slice(0, 7) }));
      continue;
    }
    // The ZIP sits in the leading unquoted columns; parse the rest only for a wanted one.
    const zip = line.split(",", zipColumn + 1)[zipColumn];
    if (!wanted.has(zip)) continue;
    const fields = parseCsvLine(line);
    const points: IndexPoint[] = [];
    for (const { column, month } of months) {
      const value = Number(fields[column]);
      if (fields[column] && Number.isFinite(value) && value > 0) points.push({ month, value });
    }
    found.set(zip, points);
  }
  if (!months) throw new Error("Home index file was empty");
  return found;
}

/** The file's lines, streamed: it's too big to hold as one string. */
export async function* fetchLines(url: string): AsyncGenerator<string> {
  if (new URL(url).protocol !== "https:") throw new Error("The home index is only fetched over HTTPS");
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`Home index download failed: HTTP ${res.status}`);
  const decoder = new TextDecoder();
  let size = 0;
  let rest = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error("Home index file is larger than expected");
    const text = rest + decoder.decode(chunk, { stream: true });
    const lines = text.split("\n");
    rest = lines.pop()!;
    yield* lines;
  }
  rest += decoder.decode();
  if (rest) yield rest;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** ZIP codes of homes valued by the index, across everyone. */
export function wantedZips(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare("SELECT DISTINCT zip FROM asset_valuations WHERE method = 'home_index' AND zip IS NOT NULL")
    .all() as { zip: string }[];
  return new Set(rows.map((r) => r.zip));
}

export function homeIndex(db: DatabaseSync, zip: string): IndexPoint[] {
  return db
    .prepare("SELECT month, value FROM home_value_index WHERE zip = ? ORDER BY month")
    .all(zip)
    .map((r) => ({ month: r.month as string, value: r.value as number }));
}

/** Replaces the readings for each ZIP found; a ZIP the file lacks keeps what it had. */
export function saveHomeIndex(db: DatabaseSync, found: Map<string, IndexPoint[]>) {
  transaction(db, () => {
    const clear = db.prepare("DELETE FROM home_value_index WHERE zip = ?");
    const insert = db.prepare("INSERT INTO home_value_index (zip, month, value) VALUES (?, ?, ?)");
    for (const [zip, points] of found) {
      clear.run(zip);
      for (const p of points) insert.run(zip, p.month, p.value);
    }
  });
}

/** Forgets ZIP codes no home here uses any more: the list of them says where people live. */
export function pruneHomeIndex(db: DatabaseSync) {
  db.prepare(
    `DELETE FROM home_value_index WHERE zip NOT IN
       (SELECT zip FROM asset_valuations WHERE method = 'home_index' AND zip IS NOT NULL)`,
  ).run();
}

export interface HomeIndexStatus {
  lastFetchedAt: number | null;
  lastAttemptAt: number | null;
  /** Null after a success; a short reason after a failure. */
  error: string | null;
  /** The newest month any ZIP has. */
  latestMonth: string | null;
}

function meta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setMeta(db: DatabaseSync, key: string, value: string | null) {
  if (value === null) db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  else db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function homeIndexStatus(db: DatabaseSync): HomeIndexStatus {
  const fetched = meta(db, "home_index_fetched_at");
  const attempt = meta(db, "home_index_attempt_at");
  const latest = db.prepare("SELECT MAX(month) AS month FROM home_value_index").get() as { month: string | null };
  return {
    lastFetchedAt: fetched ? Number(fetched) : null,
    lastAttemptAt: attempt ? Number(attempt) : null,
    error: meta(db, "home_index_error"),
    latestMonth: latest.month,
  };
}

/**
 * Whether to download again: someone has a home on the index, and either
 * the last success is a week old or a ZIP still has no readings — each
 * retried no sooner than every few hours.
 */
export function homeIndexDue(db: DatabaseSync, now: number): boolean {
  const zips = wantedZips(db);
  if (zips.size === 0) return false;
  const status = homeIndexStatus(db);
  if (status.lastAttemptAt !== null && now - status.lastAttemptAt < HOME_INDEX_RETRY_MS) return false;
  if (status.lastFetchedAt === null || now - status.lastFetchedAt >= HOME_INDEX_EVERY_MS) return true;
  const have = db.prepare("SELECT 1 FROM home_value_index WHERE zip = ? LIMIT 1");
  return [...zips].some((zip) => !have.get(zip));
}

export type LineSource = (url: string) => AsyncIterable<string>;

/** Downloads the index and keeps the wanted ZIPs. Returns how many were found. */
export async function refreshHomeIndex(db: DatabaseSync, now: number, source: LineSource = fetchLines): Promise<number> {
  const zips = wantedZips(db);
  if (zips.size === 0) return 0;
  setMeta(db, "home_index_attempt_at", String(now));
  try {
    const found = await readZhvi(source(homeIndexUrl()), zips);
    saveHomeIndex(db, found);
    setMeta(db, "home_index_fetched_at", String(now));
    setMeta(db, "home_index_error", null);
    return found.size;
  } catch (error) {
    setMeta(db, "home_index_error", error instanceof Error ? error.message.slice(0, 200) : "unexpected");
    throw error;
  }
}
