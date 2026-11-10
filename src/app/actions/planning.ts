"use server";

import { refresh } from "next/cache";
import { appContext } from "@/server/context";
import { AccountError } from "@/server/accounts";
import { requireUser } from "@/server/auth";
import { setAssetLoans } from "@/server/finance";
import { addGoal, deleteGoal, saveForecastSettings } from "@/server/planning";
import { dateKey, isDateKey } from "@/lib/local-date";
import { parseDecimalToCents } from "@/lib/money";

/** Equity links, goals and the forecast's assumptions. */

export interface PlanFormState {
  error?: string;
  done?: string;
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function attempt(fn: () => string): PlanFormState {
  try {
    const done = fn();
    refresh();
    return { done };
  } catch (error) {
    if (error instanceof AccountError) return { error: error.message };
    throw error;
  }
}

/** The loans set against an asset: one checkbox per loan, named `loan`. */
export async function setAssetLoansAction(_prev: PlanFormState, form: FormData): Promise<PlanFormState> {
  const { user } = await requireUser();
  return attempt(() => {
    const loans = form.getAll("loan").map((v) => Number(v)).filter(Number.isInteger);
    setAssetLoans(appContext().db, user.id, Number(field(form, "accountId")), loans);
    return loans.length ? "Saved — equity is its value less those loans." : "Saved — no loans against it.";
  });
}

export async function addGoalAction(_prev: PlanFormState, form: FormData): Promise<PlanFormState> {
  const { user } = await requireUser();
  return attempt(() => {
    const name = field(form, "name").slice(0, 80);
    const target = parseDecimalToCents(field(form, "target"));
    const account = field(form, "accountId");
    const date = field(form, "targetDate");
    if (!name) throw new AccountError("Give the goal a name, e.g. “Emergency fund”.");
    if (target === null || target < 0) throw new AccountError("Enter a target amount (0 to pay a debt off).");
    if (date && !isDateKey(date)) throw new AccountError("The target date isn't a date.");
    if (date && date <= dateKey(Date.now())) throw new AccountError("The target date should be in the future.");
    addGoal(
      appContext().db,
      user.id,
      { name, targetCents: target, accountId: account ? Number(account) : null, targetDate: date || null },
      Date.now(),
    );
    return `Added ${name}.`;
  });
}

export async function deleteGoalAction(form: FormData) {
  const { user } = await requireUser();
  deleteGoal(appContext().db, user.id, Number(form.get("goalId")));
  refresh();
}

export async function saveAssumptionsAction(_prev: PlanFormState, form: FormData): Promise<PlanFormState> {
  const { user } = await requireUser();
  return attempt(() => {
    const rate = parseDecimalToCents(field(form, "investmentReturn") || "0"); // "5" → 500 bps
    const savingsText = field(form, "monthlySavings");
    const savings = savingsText ? parseDecimalToCents(savingsText.replace(/^−/, "-")) : null;
    if (rate === null || rate < -2000 || rate > 2000) throw new AccountError("Enter the yearly investment return as a percent, e.g. 5.");
    if (savingsText && savings === null) throw new AccountError("Monthly savings should be a dollar amount, or blank.");
    saveForecastSettings(appContext().db, user.id, { investmentReturnBps: rate, monthlySavingsCents: savings }, Date.now());
    return "Saved — the forecast uses these now.";
  });
}
