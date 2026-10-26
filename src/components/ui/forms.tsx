"use client";

import { useFormStatus } from "react-dom";
import type { InputHTMLAttributes, ReactNode } from "react";

/** Form building blocks shared by the sign-in and settings pages. */

export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input
        {...input}
        className="mt-1 block w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-base outline-none placeholder:text-muted-dim focus:border-accent"
      />
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Submit({ children, tone = "primary" }: { children: ReactNode; tone?: "primary" | "quiet" | "danger" }) {
  const { pending } = useFormStatus();
  const styles = {
    primary: "bg-accent text-accent-ink",
    quiet: "border border-line bg-surface hover:border-muted-dim",
    danger: "border border-danger/50 text-danger hover:bg-danger/10",
  }[tone];
  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-full px-4 py-2 text-sm font-medium disabled:opacity-60 ${styles}`}
    >
      {pending ? "Working…" : children}
    </button>
  );
}

export function FormMessage({ error, done }: { error?: string; done?: string }) {
  if (error) {
    return (
      <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
        {error}
      </p>
    );
  }
  if (done) {
    return (
      <p role="status" className="rounded-lg border border-good/40 bg-good/10 px-3 py-2 text-sm text-good">
        {done}
      </p>
    );
  }
  return null;
}

/** Recovery codes, shown once, with a way to copy them. */
export function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="space-y-3">
      <ol className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface-2 p-4 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <button
        type="button"
        onClick={() => void navigator.clipboard?.writeText(codes.join("\n"))}
        className="rounded-full border border-line bg-surface px-4 py-2 text-sm hover:border-muted-dim"
      >
        Copy codes
      </button>
    </div>
  );
}
