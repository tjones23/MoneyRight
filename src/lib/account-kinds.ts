/**
 * What each account is, for grouping and for net worth, from whatever its
 * source calls it. Liabilities are stored as the positive amount owed and
 * subtracted when totalled.
 */

export type AccountKind = "cash" | "investment" | "credit" | "mortgage" | "student_loan" | "loan" | "other";

export const KIND_LABEL: Record<AccountKind, string> = {
  cash: "Cash",
  investment: "Investments",
  credit: "Credit cards",
  mortgage: "Mortgage",
  student_loan: "Student loans",
  loan: "Loans",
  other: "Other",
};

/** Display order on the overview: what you have, then what you owe. */
export const KIND_ORDER: AccountKind[] = ["cash", "investment", "other", "credit", "mortgage", "student_loan", "loan"];

export function isLiability(kind: AccountKind): boolean {
  return kind === "credit" || kind === "mortgage" || kind === "student_loan" || kind === "loan";
}

/** Plaid: depository, credit, loan (with subtypes), investment (and the old brokerage), other. */
export function plaidKind(type: string, subtype: string | null): AccountKind {
  switch (type) {
    case "depository":
      return "cash";
    case "credit":
      return "credit";
    case "investment":
    case "brokerage":
      return "investment";
    case "loan":
      if (subtype === "mortgage" || subtype === "home equity") return "mortgage";
      if (subtype === "student") return "student_loan";
      return "loan";
    default:
      return "other";
  }
}
