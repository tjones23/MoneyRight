"use client";

import { useActionState, useState, type ReactNode } from "react";
import { addAssetAction, updateAssetAction } from "@/app/actions/assets";
import { Field, FormMessage, Submit } from "@/components/ui/forms";
import type { AssetKind } from "@/server/finance";
import type { ValuationMethod } from "@/lib/valuation";

/**
 * A home, vehicle or other asset: what it was worth on a date, and how the
 * estimate moves after that. Entered once; updated whenever a fresher value
 * is looked up.
 */

export interface AssetDefaults {
  accountId?: number;
  name: string;
  kind: AssetKind;
  value: string;
  asOf: string;
  method: ValuationMethod;
  rate: string;
  zip: string;
}

/** What each kind usually wants, picked when the kind changes. */
const METHOD_FOR: Record<AssetKind, ValuationMethod> = { property: "home_index", vehicle: "depreciation", other: "fixed" };

const VALUE_HINT: Record<AssetKind, ReactNode> = {
  property: "An appraisal, the purchase price, or an online estimate.",
  vehicle: "Private-party value from Kelley Blue Book, Edmunds or Consumer Reports.",
  other: "What it would sell for.",
};

function Select({
  label,
  name,
  value,
  onChange,
  options,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <select
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-base outline-none focus:border-accent"
      >
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function AssetFields({ defaults }: { defaults: AssetDefaults }) {
  const [kind, setKind] = useState<AssetKind>(defaults.kind);
  const [method, setMethod] = useState<ValuationMethod>(defaults.method);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Name" name="name" defaultValue={defaults.name} placeholder="2021 Toyota RAV4" required maxLength={80} />
      <Select
        label="Kind"
        name="kind"
        value={kind}
        onChange={(v) => {
          setKind(v as AssetKind);
          setMethod(METHOD_FOR[v as AssetKind]);
        }}
        options={[
          ["property", "Home or property"],
          ["vehicle", "Vehicle"],
          ["other", "Something else"],
        ]}
      />
      <Field
        label="Worth"
        name="value"
        inputMode="decimal"
        defaultValue={defaults.value}
        placeholder="24,500"
        required
        hint={VALUE_HINT[kind]}
      />
      <Field label="Worth that as of" name="asOf" type="date" defaultValue={defaults.asOf} required hint="When that value was true." />
      <Select
        label="After that"
        name="method"
        value={method}
        onChange={(v) => setMethod(v as ValuationMethod)}
        options={[
          ["home_index", "Follow home values in its ZIP code"],
          ["depreciation", "Lose a share each year"],
          ["fixed", "Stay the same until I update it"],
        ]}
      />
      {method === "depreciation" && (
        <Field
          label="Depreciation per year (%)"
          name="rate"
          inputMode="decimal"
          defaultValue={defaults.rate}
          placeholder="15"
          required
          hint="Cars commonly lose 15–20% a year for the first five, less after."
        />
      )}
      {method === "home_index" && (
        <Field
          label="ZIP code"
          name="zip"
          inputMode="numeric"
          pattern="\d{5}"
          maxLength={5}
          defaultValue={defaults.zip}
          placeholder="43215"
          required
          hint="Zillow's monthly home value index for that ZIP moves the estimate."
        />
      )}
    </div>
  );
}

export function AddAssetForm({ defaults }: { defaults: AssetDefaults }) {
  const [state, action] = useActionState(addAssetAction, {});
  return (
    <form action={action} className="space-y-4">
      <FormMessage error={state.error} done={state.done} />
      <AssetFields defaults={defaults} />
      <Submit>Add asset</Submit>
    </form>
  );
}

export function EditAssetForm({ defaults }: { defaults: AssetDefaults }) {
  const [state, action] = useActionState(updateAssetAction, {});
  return (
    <form action={action} className="space-y-4">
      <FormMessage error={state.error} done={state.done} />
      <input type="hidden" name="accountId" value={defaults.accountId} />
      <AssetFields defaults={defaults} />
      <Submit tone="quiet">Save and re-estimate</Submit>
    </form>
  );
}
