import type { ReactNode } from "react";

/** The narrow centered card every sign-in step sits in. */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
      <p className="text-sm font-semibold tracking-wide text-accent">MoneyRight</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-2 text-sm text-muted">{subtitle}</p>}
      <div className="mt-6 rounded-2xl border border-line bg-surface p-5">{children}</div>
    </main>
  );
}
