"use client";

import { useActionState } from "react";
import { addLoanAction, updateLoanAction, type LoanFormState } from "@/app/actions/loans";
import { Field, FormMessage, Submit } from "@/components/ui/forms";

/**
 * A federal loan's numbers, as the servicer shows them. Entered once; edited
 * only when something changes (forbearance, a new IDR payment, an extra
 * payment) — the projection then resumes from the new "as of" date.
 */

export interface LoanDefaults {
  accountId?: number;
  name: string;
  servicer: string;
  principal: string;
  interest: string;
  rate: string;
  payment: string;
  paymentDay: string;
  anchorDate: string;
}

function LoanFields({ defaults }: { defaults: LoanDefaults }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Name" name="name" defaultValue={defaults.name} placeholder="Direct Unsubsidized" required maxLength={80} />
      <Field label="Servicer" name="servicer" defaultValue={defaults.servicer} placeholder="MOHELA" maxLength={80} />
      <Field
        label="Principal balance"
        name="principal"
        inputMode="decimal"
        defaultValue={defaults.principal}
        placeholder="24,310.55"
        required
      />
      <Field
        label="Unpaid interest"
        name="interest"
        inputMode="decimal"
        defaultValue={defaults.interest}
        placeholder="0.00"
        hint="Accrued but not yet paid, if the servicer shows it."
      />
      <Field label="Interest rate (%)" name="rate" inputMode="decimal" defaultValue={defaults.rate} placeholder="6.53" required />
      <Field
        label="Monthly payment"
        name="payment"
        inputMode="decimal"
        defaultValue={defaults.payment}
        placeholder="312.00"
        required
        hint="0 while in forbearance or deferment."
      />
      <Field
        label="Payment day"
        name="paymentDay"
        type="number"
        min={1}
        max={31}
        defaultValue={defaults.paymentDay}
        required
        hint="Day of the month it's paid."
      />
      <Field
        label="Balances as of"
        name="anchorDate"
        type="date"
        defaultValue={defaults.anchorDate}
        required
        hint="The date those numbers were true."
      />
    </div>
  );
}

function Result({ state }: { state: LoanFormState }) {
  return (
    <>
      <FormMessage error={state.error} done={state.done} />
      {state.warning && <p className="text-sm text-muted">{state.warning}</p>}
    </>
  );
}

export function AddLoanForm({ defaults }: { defaults: LoanDefaults }) {
  const [state, action] = useActionState(addLoanAction, {});
  return (
    <form action={action} className="space-y-4">
      <Result state={state} />
      <LoanFields defaults={defaults} />
      <Submit>Add loan</Submit>
    </form>
  );
}

export function EditLoanForm({ defaults }: { defaults: LoanDefaults }) {
  const [state, action] = useActionState(updateLoanAction, {});
  return (
    <form action={action} className="space-y-4">
      <Result state={state} />
      <input type="hidden" name="accountId" value={defaults.accountId} />
      <LoanFields defaults={defaults} />
      <Submit tone="quiet">Save and re-project</Submit>
    </form>
  );
}
