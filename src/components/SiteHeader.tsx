import Link from "next/link";
import { signOutAction } from "@/app/actions/auth";
import type { User } from "@/server/accounts";

export function SiteHeader({ user }: { user: User }) {
  return (
    <header className="border-b border-line-soft">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="font-semibold tracking-tight text-accent">
          MoneyRight
        </Link>
        <nav className="flex flex-1 items-center gap-4 text-sm text-muted">
          <Link href="/" className="hover:text-text">
            Overview
          </Link>
          <Link href="/accounts" className="hover:text-text">
            Accounts
          </Link>
          <Link href="/settings" className="hover:text-text">
            Settings
          </Link>
        </nav>
        <form action={signOutAction} className="flex items-center gap-3 text-sm">
          <span className="hidden text-muted sm:inline">{user.displayName}</span>
          <button type="submit" className="rounded-full border border-line px-3 py-1 hover:border-muted-dim">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}

export function PageBody({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-12 pt-6 sm:px-6">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      <div className="mt-6 space-y-6">{children}</div>
    </main>
  );
}
