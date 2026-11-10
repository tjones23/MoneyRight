"use client";

import { useActionState } from "react";
import { addGoalAction, saveAssumptionsAction, setAssetLoansAction } from "@/app/actions/planning";
import { Field, FormMessage, Submit } from "@/components/ui/forms";

/** Equity links, goals and the forecast's assumptions. */

export function AssetLoansForm({
  accountId,
  loans,
}: {
  accountId: number;
  loans: { id: number; label: string; checked: boolean; elsewhere: string | null }[];
}) {
  const [state, action] = useActionState(setAssetLoansAction, {});
  return (
    <form action={action} className="space-y-3">
      <FormMessage error={state.error} done={state.done} />
      <input type="hidden" name="accountId" value={accountId} />
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Loans against it</legend>
        {loans.map((loan) => (
          <label key={loan.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="loan" value={loan.id} defaultChecked={loan.checked} className="accent-accent" />
            <span>
              {loan.label}
              {loan.elsewhere && <span className="text-muted"> · now against {loan.elsewhere}</span>}
            </span>
          </label>
        ))}
      </fieldset>
      <Submit tone="quiet">Save loans</Submit>
    </form>
  );
}

export function AddGoalForm({ accounts }: { accounts: { id: number; label: string }[] }) {
  const [state, action] = useActionState(addGoalAction, {});
  return (
    <form action={action} className="space-y-4">
      <FormMessage error={state.error} done={state.done} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" name="name" placeholder="Emergency fund" required maxLength={80} />
        <label className="block">
          <span className="text-sm font-medium">Of</span>
          <select
            name="accountId"
            defaultValue=""
            className="mt-1 block w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-base outline-none focus:border-accent"
          >
            <option value="">Net worth</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="Target"
          name="target"
          inputMode="decimal"
          placeholder="25,000"
          required
          hint="For a debt, what's owed — 0 to pay it off."
        />
        <Field label="By (optional)" name="targetDate" type="date" hint="Shows whether the forecast gets there in time." />
      </div>
      <Submit>Add goal</Submit>
    </form>
  );
}

export function AssumptionsForm({ investmentReturn, monthlySavings, measured }: { investmentReturn: string; monthlySavings: string; measured: string | null }) {
  const [state, action] = useActionState(saveAssumptionsAction, {});
  return (
    <form action={action} className="space-y-4">
      <FormMessage error={state.error} done={state.done} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Investment return per year (%)"
          name="investmentReturn"
          inputMode="decimal"
          defaultValue={investmentReturn}
          required
          hint="After inflation, a long-run stock and bond mix has returned roughly 4–6%."
        />
        <Field
          label="Monthly savings"
          name="monthlySavings"
          inputMode="decimal"
          defaultValue={monthlySavings}
          placeholder={measured ?? "1,000"}
          hint={
            measured
              ? `Blank uses your last six months' average from transactions (${measured}).`
              : "Blank uses your recent average once transactions come in; until then, 0."
          }
        />
      </div>
      <Submit tone="quiet">Save assumptions</Submit>
    </form>
  );
}
