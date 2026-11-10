"use server";

import { refresh } from "next/cache";
import { after } from "next/server";
import { appContext } from "@/server/context";
import { AccountError } from "@/server/accounts";
import { requireUser } from "@/server/auth";
import {
  addAsset,
  ASSET_KINDS,
  deleteAsset,
  listAssets,
  recordAddressEstimate,
  updateAsset,
  type AssetDetails,
  type AssetKind,
} from "@/server/finance";
import { lookUpHome, lookupProblem } from "@/server/home-estimates";
import { isZip } from "@/server/home-index";
import { providers } from "@/server/providers";
import type { HomeEstimate } from "@/server/providers/rentcast";
import { syncAssets, syncHomeIndex } from "@/server/sync";
import { dateKey, isDateKey } from "@/lib/local-date";
import { formatCents, parseDecimalToCents } from "@/lib/money";
import type { ValuationMethod } from "@/lib/valuation";

/**
 * Homes, vehicles and other things owned: a value as of a date, and how it
 * moves after that — or, for a home, its address, looked up by RentCast.
 * Updated whenever the person checks a fresher value.
 */

export interface AssetFormState {
  error?: string;
  done?: string;
  /** What was entered, handed back with an error so the form refills rather than resetting to blank. */
  values?: Record<string, string>;
}

const FIELDS = ["name", "kind", "method", "value", "asOf", "rate", "zip", "address"];

function failed(error: AccountError, form: FormData): AssetFormState {
  return { error: error.message, values: Object.fromEntries(FIELDS.map((name) => [name, field(form, name)])) };
}

const METHODS: ValuationMethod[] = ["fixed", "depreciation", "home_index", "address"];

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** The form, checked. For an address, the value comes from the lookup, so it's left at 0 here. */
function parseAsset(form: FormData): AssetDetails {
  const name = field(form, "name").slice(0, 80);
  const kind = field(form, "kind") as AssetKind;
  const method = field(form, "method") as ValuationMethod;
  const rate = parseDecimalToCents(field(form, "rate") || "0"); // "15" → 1500 bps
  const zip = field(form, "zip");
  const address = field(form, "address").replace(/\s+/g, " ").slice(0, 200);
  const asOf = field(form, "asOf") || dateKey(Date.now());

  if (!name) throw new AccountError("Give it a name, e.g. “2021 RAV4” or “House”.");
  if (!ASSET_KINDS.includes(kind)) throw new AccountError("Choose what kind of asset it is.");
  if (!METHODS.includes(method)) throw new AccountError("Choose how the value should change.");
  if (method === "address") {
    if (kind !== "property") throw new AccountError("Only a home can be valued from its address.");
    if (!/\d/.test(address) || address.split(",").length < 3) {
      throw new AccountError("Enter the full address: street, city, state and ZIP — e.g. “12 Elm St, Boston, MA 02134”.");
    }
    return { name, kind, valuation: { valueCents: 0, asOf: dateKey(Date.now()), method, annualRateBps: 0, zip: null, address } };
  }

  const value = parseDecimalToCents(field(form, "value"));
  if (value === null || value <= 0) throw new AccountError("Enter what it's worth, e.g. 24,500.");
  if (method === "depreciation" && (rate === null || rate <= 0 || rate >= 10_000)) {
    throw new AccountError("Enter the yearly depreciation as a percent, e.g. 15.");
  }
  if (method === "home_index" && !isZip(zip)) throw new AccountError("Enter the home's five-digit ZIP code.");
  if (!isDateKey(asOf)) throw new AccountError("The “as of” date isn't a date.");
  if (asOf > dateKey(Date.now())) throw new AccountError("The “as of” date can't be in the future.");

  return {
    name,
    kind,
    valuation: {
      valueCents: value,
      asOf,
      method,
      annualRateBps: method === "depreciation" ? rate! : 0,
      zip: method === "home_index" ? zip : null,
    },
  };
}

/** Looks the address up, before anything is saved: a typo should be fixable, not stored. */
async function lookUp(address: string): Promise<HomeEstimate> {
  const client = providers().rentcast;
  if (!client) throw new AccountError("Address lookup isn't set up on this server: set RENTCAST_API_KEY (see the README).");
  try {
    return await lookUpHome(appContext().db, client, address, Date.now());
  } catch (error) {
    throw new AccountError(lookupProblem(error));
  }
}

function withEstimate(asset: AssetDetails, estimate: HomeEstimate): AssetDetails {
  return { ...asset, valuation: { ...asset.valuation, valueCents: estimate.valueCents, zip: estimate.zip } };
}

function saveEstimate(accountId: number, estimate: HomeEstimate) {
  recordAddressEstimate(appContext().db, accountId, { ...estimate, day: dateKey(Date.now()) }, Date.now());
}

function estimateText(estimate: HomeEstimate): string {
  const range =
    estimate.lowCents && estimate.highCents
      ? ` (likely ${formatCents(estimate.lowCents, { whole: true })}–${formatCents(estimate.highCents, { whole: true })})`
      : "";
  return `${formatCents(estimate.valueCents, { whole: true })}${range}`;
}

/** Today's estimate now; home values, if a new ZIP needs them, fetched in the background. */
function afterChange(userId: number) {
  const ctx = appContext();
  syncAssets(ctx, Date.now(), userId);
  after(() => syncHomeIndex(ctx, Date.now()));
}

export async function addAssetAction(_prev: AssetFormState, form: FormData): Promise<AssetFormState> {
  const { user } = await requireUser();
  try {
    let asset = parseAsset(form);
    let done = `Added ${asset.name}.`;
    if (asset.valuation.method === "address") {
      const estimate = await lookUp(asset.valuation.address!);
      asset = withEstimate(asset, estimate);
      const id = addAsset(appContext().db, user.id, asset, Date.now());
      saveEstimate(id, estimate);
      done = `Added ${asset.name}: estimated at ${estimateText(estimate)}${estimate.formattedAddress ? ` for ${estimate.formattedAddress}` : ""}.`;
    } else {
      addAsset(appContext().db, user.id, asset, Date.now());
      if (asset.valuation.method === "home_index") {
        done = `Added ${asset.name}. ZIP ${asset.valuation.zip}'s home values are being fetched — the estimate follows them from here.`;
      }
    }
    afterChange(user.id);
    refresh();
    return { done };
  } catch (error) {
    if (error instanceof AccountError) return failed(error, form);
    throw error;
  }
}

export async function updateAssetAction(_prev: AssetFormState, form: FormData): Promise<AssetFormState> {
  const { user } = await requireUser();
  try {
    const accountId = Number(field(form, "accountId"));
    let asset = parseAsset(form);
    let done = "Updated — estimating from the new value.";
    if (asset.valuation.method === "address") {
      const current = listAssets(appContext().db, user.id).find((a) => a.accountId === accountId);
      if (!current) throw new AccountError("That asset doesn't exist.");
      const same = current.valuation.method === "address" && current.valuation.address === asset.valuation.address;
      if (same) {
        // Nothing to look up: keep the last estimate, so renaming doesn't spend a lookup.
        asset = { ...asset, valuation: { ...current.valuation } };
        updateAsset(appContext().db, user.id, accountId, asset, Date.now(), { keepHistory: true });
        done = "Saved.";
      } else {
        const estimate = await lookUp(asset.valuation.address!);
        asset = withEstimate(asset, estimate);
        updateAsset(appContext().db, user.id, accountId, asset, Date.now());
        saveEstimate(accountId, estimate);
        done = `Updated: estimated at ${estimateText(estimate)}.`;
      }
    } else {
      updateAsset(appContext().db, user.id, accountId, asset, Date.now());
    }
    afterChange(user.id);
    refresh();
    return { done };
  } catch (error) {
    if (error instanceof AccountError) return failed(error, form);
    throw error;
  }
}

export async function deleteAssetAction(form: FormData) {
  const { user } = await requireUser();
  deleteAsset(appContext().db, user.id, Number(form.get("accountId")));
  refresh();
}
