import { daysBetween, nthMonthDay, type DateKey } from "./local-date";

/**
 * A federal student loan's balance, projected from one known point.
 *
 * Federal Direct Loans accrue *simple* daily interest — principal × rate ÷
 * 365.25 per day, never compounding — and each payment goes to accrued
 * interest first, then principal. So from a balance on an anchor date, the
 * rate, and the monthly payment, every later balance follows. When reality
 * drifts (forbearance, an IDR recalculation, an extra payment), the person
 * re-anchors with the servicer's current balance and the projection resumes
 * from there.
 *
 * Pure: takes the date to project to rather than reading the clock.
 */

export interface LoanSchedule {
  /** Principal outstanding on the anchor date, in cents. */
  principalCents: number;
  /** Interest accrued but unpaid on the anchor date, in cents. */
  accruedInterestCents: number;
  /** e.g. 6.53% → 653. */
  annualRateBps: number;
  monthlyPaymentCents: number;
  /** Day of the month payments land, 1–31 (clamped in short months). */
  paymentDay: number;
  /** The date the balances above were true. */
  anchorDate: DateKey;
}

export interface LoanPosition {
  principalCents: number;
  accruedInterestCents: number;
  /** What the servicer would show as the balance: principal + unpaid interest. */
  balanceCents: number;
  paymentsMade: number;
  paidOff: boolean;
}

const DAYS_PER_YEAR = 365.25;

function interestFor(principalCents: number, annualRateBps: number, days: number): number {
  return (principalCents * (annualRateBps / 10_000) * days) / DAYS_PER_YEAR;
}

/** Payment dates strictly after `from`, up to and including `to`. */
export function paymentDates(from: DateKey, to: DateKey, paymentDay: number): DateKey[] {
  const dates: DateKey[] = [];
  for (let m = 0; ; m++) {
    const date = nthMonthDay(from, m, paymentDay);
    if (daysBetween(to, date) > 0) break;
    if (daysBetween(from, date) > 0) dates.push(date);
    if (m > 1200) break; // a hundred years: something is wrong with the inputs
  }
  return dates;
}

export function projectLoan(schedule: LoanSchedule, to: DateKey): LoanPosition {
  let principal = schedule.principalCents;
  // Kept fractional between payments; rounded only when shown.
  let accrued = schedule.accruedInterestCents;
  let last = schedule.anchorDate;
  let paymentsMade = 0;

  if (daysBetween(last, to) < 0) {
    return position(principal, accrued, 0);
  }

  for (const date of paymentDates(schedule.anchorDate, to, schedule.paymentDay)) {
    if (principal <= 0) break;
    accrued += interestFor(principal, schedule.annualRateBps, daysBetween(last, date));
    let payment = schedule.monthlyPaymentCents;
    const toInterest = Math.min(payment, accrued);
    accrued -= toInterest;
    payment -= toInterest;
    principal = Math.max(0, principal - payment);
    last = date;
    paymentsMade++;
  }
  if (principal > 0) accrued += interestFor(principal, schedule.annualRateBps, daysBetween(last, to));
  return position(principal, accrued, paymentsMade);
}

function position(principal: number, accrued: number, paymentsMade: number): LoanPosition {
  const principalCents = Math.round(principal);
  const accruedInterestCents = principal > 0 ? Math.round(accrued) : 0;
  return {
    principalCents,
    accruedInterestCents,
    balanceCents: principalCents + accruedInterestCents,
    paymentsMade,
    paidOff: principalCents === 0,
  };
}

/** Whether the payment even covers a month's interest — if not, the balance only grows. */
export function paymentCoversInterest(schedule: LoanSchedule): boolean {
  const monthly = interestFor(schedule.principalCents, schedule.annualRateBps, DAYS_PER_YEAR / 12);
  return schedule.monthlyPaymentCents > monthly;
}
