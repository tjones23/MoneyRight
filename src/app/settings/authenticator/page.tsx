import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageBody, SiteHeader } from "@/components/SiteHeader";
import { ChangeAuthenticatorForm } from "@/components/SettingsForms";
import { TotpSetup } from "@/components/TotpSetup";
import { requireUser } from "@/server/auth";
import { appContext } from "@/server/context";
import { pendingTotpSecret } from "@/server/accounts";

export const metadata: Metadata = { title: "Switch authenticator app" };

/** Moving the six-digit codes to another app — Google Authenticator to Apple Passwords, or back. */
export default async function ChangeAuthenticatorPage() {
  const { user, session } = await requireUser();
  const ctx = appContext();
  if (!ctx.secondFactorRequired) redirect("/settings");
  const secret = pendingTotpSecret(ctx, session);
  return (
    <>
      <SiteHeader user={user} />
      <PageBody title="Switch authenticator app" subtitle="Add MoneyRight to the new app, then confirm with its first code.">
        <section className="max-w-md space-y-6 rounded-2xl border border-line bg-surface p-5">
          <TotpSetup secret={secret} account={user.username} />
          <ChangeAuthenticatorForm />
          <p className="text-xs text-muted">
            Until you confirm, your current app keeps working. Recovery codes, passkeys and sign-in phones stay as they are.{" "}
            <Link href="/settings" className="underline">
              Back to Settings
            </Link>
          </p>
        </section>
      </PageBody>
    </>
  );
}
