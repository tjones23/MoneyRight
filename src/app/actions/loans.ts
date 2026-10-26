"use server";

import { refresh } from "next/cache";
import { appContext } from "@/server/context";
import { AccountError } from "@/server/accounts";
import { requireUser } from "@/server/auth";
import { addScheduledLoan, deleteScheduledLoan, updateScheduledLoan } from "@/server/finance";
import { syncScheduledLoans } from "@/server/sync";
import type { LoanSchedule } from "@/lib/amortization";
import { paymentCoversInterest } from "@/lib/amortization";
import { dateKey, isDateKey } from "@/lib/local-date";
import { parseDecimalToCents } from "@/lib/money";

/**
 * Federal student loans, worked out from the servicer's numbers: entered
 * once, re-anchored only when something changes.
 */

export interface LoanFormState {
  error?: string;
  done?: string;
  warning?: string;
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function parseLoan(form: FormData): { name: string; servicer: string; schedule: LoanSchedule } {
  const name = field(form, "name").slice(0, 80);
  const servicer = field(form, "servicer").slice(0, 80) || "MOHELA";
  const principal = parseDecimalToCents(field(form, "principal"));
  const interest = parseDecimalToCents(field(form, "interest") || "0");
  const rate = parseDecimalToCents(field(form, "rate")); // "6.53" → 653: hundredths of a percent, i.e. bps
  const payment = parseDecimalToCents(field(form, "payment"));
  const day = Number(field(form, "paymentDay"));
  const anchor = field(form, "anchorDate") || dateKey(Date.now());

  if (!name) throw new AccountError("Give the loan a name, e.g. “Direct Unsubsidized”.");
  if (principal === null || principal <= 0) throw new AccountError("Enter the principal balance, e.g. 24,310.55.");
  if (interest === null || interest < 0) throw new AccountError("Unpaid interest should be a dollar amount, or blank.");
  if (rate === null || rate < 0 || rate > 3000) throw new AccountError("Enter the interest rate as a percent, e.g. 6.53.");
  if (payment === null || payment < 0) throw new AccountError("Enter the monthly payment (0 if paused).");
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new AccountError("Payment day is a day of the month, 1–31.");
  if (!isDateKey(anchor)) throw new AccountError("The “as of” date isn't a date.");
  if (anchor > dateKey(Date.now())) throw new AccountError("The “as of” date can't be in the future.");

  return {
    name,
    servicer,
    schedule: {
      principalCents: principal,
      accruedInterestCents: interest,
      annualRateBps: rate,
      monthlyPaymentCents: payment,
      paymentDay: day,
      anchorDate: anchor,
    },
  };
}

function warningFor(schedule: LoanSchedule): string | undefined {
  if (schedule.monthlyPaymentCents > 0 && !paymentCoversInterest(schedule)) {
    return "That payment doesn't cover a month's interest, so the projected balance will grow — normal on some IDR plans.";
  }
  return undefined;
}

export async function addLoanAction(_prev: LoanFormState, form: FormData): Promise<LoanFormState> {
  const { user } = await requireUser();
  const ctx = appContext();
  try {
    const loan = parseLoan(form);
    addScheduledLoan(ctx.db, user.id, loan, Date.now());
    syncScheduledLoans(ctx, Date.now(), user.id);
    refresh();
    return { done: `Added ${loan.name}.`, warning: warningFor(loan.schedule) };
  } catch (error) {
    if (error instanceof AccountError) return { error: error.message };
    throw error;
  }
}

export async function updateLoanAction(_prev: LoanFormState, form: FormData): Promise<LoanFormState> {
  const { user } = await requireUser();
  const ctx = appContext();
  try {
    const loan = parseLoan(form);
    updateScheduledLoan(ctx.db, user.id, Number(field(form, "accountId")), loan, Date.now());
    syncScheduledLoans(ctx, Date.now(), user.id);
    refresh();
    return { done: "Updated — projecting from the new numbers.", warning: warningFor(loan.schedule) };
  } catch (error) {
    if (error instanceof AccountError) return { error: error.message };
    throw error;
  }
}

export async function deleteLoanAction(form: FormData) {
  const { user } = await requireUser();
  deleteScheduledLoan(appContext().db, user.id, Number(form.get("accountId")));
  refresh();
}
