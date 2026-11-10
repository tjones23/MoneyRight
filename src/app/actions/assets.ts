"use server";

import { refresh } from "next/cache";
import { after } from "next/server";
import { appContext } from "@/server/context";
import { AccountError } from "@/server/accounts";
import { requireUser } from "@/server/auth";
import { addAsset, ASSET_KINDS, deleteAsset, updateAsset, type AssetDetails, type AssetKind } from "@/server/finance";
import { isZip } from "@/server/home-index";
import { syncAssets, syncHomeIndex } from "@/server/sync";
import { dateKey, isDateKey } from "@/lib/local-date";
import { parseDecimalToCents } from "@/lib/money";
import type { ValuationMethod } from "@/lib/valuation";

/**
 * Homes, vehicles and other things owned: a value as of a date, and how it
 * moves after that. Updated whenever the person checks a fresher value.
 */

export interface AssetFormState {
  error?: string;
  done?: string;
}

const METHODS: ValuationMethod[] = ["fixed", "depreciation", "home_index"];

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function parseAsset(form: FormData): AssetDetails {
  const name = field(form, "name").slice(0, 80);
  const kind = field(form, "kind") as AssetKind;
  const method = field(form, "method") as ValuationMethod;
  const value = parseDecimalToCents(field(form, "value"));
  const rate = parseDecimalToCents(field(form, "rate") || "0"); // "15" → 1500 bps
  const zip = field(form, "zip");
  const asOf = field(form, "asOf") || dateKey(Date.now());

  if (!name) throw new AccountError("Give it a name, e.g. “2021 RAV4” or “House”.");
  if (!ASSET_KINDS.includes(kind)) throw new AccountError("Choose what kind of asset it is.");
  if (!METHODS.includes(method)) throw new AccountError("Choose how the value should change.");
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

/** Today's estimate now; home values, if a new ZIP needs them, fetched in the background. */
function afterChange(userId: number) {
  const ctx = appContext();
  syncAssets(ctx, Date.now(), userId);
  after(() => syncHomeIndex(ctx, Date.now()));
}

export async function addAssetAction(_prev: AssetFormState, form: FormData): Promise<AssetFormState> {
  const { user } = await requireUser();
  try {
    const asset = parseAsset(form);
    addAsset(appContext().db, user.id, asset, Date.now());
    afterChange(user.id);
    refresh();
    return {
      done:
        asset.valuation.method === "home_index"
          ? `Added ${asset.name}. ZIP ${asset.valuation.zip}'s home values are being fetched — the estimate follows them from here.`
          : `Added ${asset.name}.`,
    };
  } catch (error) {
    if (error instanceof AccountError) return { error: error.message };
    throw error;
  }
}

export async function updateAssetAction(_prev: AssetFormState, form: FormData): Promise<AssetFormState> {
  const { user } = await requireUser();
  try {
    const asset = parseAsset(form);
    updateAsset(appContext().db, user.id, Number(field(form, "accountId")), asset, Date.now());
    afterChange(user.id);
    refresh();
    return { done: "Updated — estimating from the new value." };
  } catch (error) {
    if (error instanceof AccountError) return { error: error.message };
    throw error;
  }
}

export async function deleteAssetAction(form: FormData) {
  const { user } = await requireUser();
  deleteAsset(appContext().db, user.id, Number(form.get("accountId")));
  refresh();
}
