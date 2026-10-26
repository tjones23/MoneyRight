import type { Metadata } from "next";
import { connection } from "next/server";
import { AuthShell } from "@/components/AuthShell";
import { InviteForm } from "@/components/AuthForms";
import { appContext } from "@/server/context";
import { inviteIsUsable } from "@/server/accounts";

export const metadata: Metadata = { title: "Join" };

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  await connection();
  if (!inviteIsUsable(appContext().db, token)) {
    return (
      <AuthShell title="This invite has expired" subtitle="Invite links work once, for seven days. Ask for a new one.">
        <p className="text-sm text-muted">Nothing else to do here.</p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Join MoneyRight" subtitle="You've been invited. Create your account.">
      <InviteForm token={token} />
    </AuthShell>
  );
}
