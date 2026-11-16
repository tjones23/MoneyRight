import type { Metadata } from "next";
import { AuthShell } from "@/components/AuthShell";
import { EnrollForm, FinishEnrollForm } from "@/components/AuthForms";
import { requireStage } from "@/server/auth";
import { appContext } from "@/server/context";
import { enrollmentRecoveryCodes, pendingTotpSecret } from "@/server/accounts";
import { RecoveryCodes } from "@/components/ui/forms";
import { TotpSetup } from "@/components/TotpSetup";

export const metadata: Metadata = { title: "Set up your authenticator" };

/**
 * Every account needs a second factor before it sees anything: an
 * authenticator app, set up from TotpSetup's QR code or link.
 */
export default async function EnrollPage() {
  const { session, user } = await requireStage("enroll");
  if (user.hasTotp) {
    const codes = enrollmentRecoveryCodes(appContext(), session);
    return (
      <AuthShell
        title="Save your recovery codes"
        subtitle="If you lose your phone, each of these signs you in once in place of a code. They won't be shown again after this — keep them in your password manager or on paper."
      >
        <div className="space-y-4">
          {codes ? (
            <RecoveryCodes codes={codes} />
          ) : (
            <p className="text-sm text-muted">Make a new set of recovery codes in Settings.</p>
          )}
          <FinishEnrollForm label="I've saved them — continue" />
        </div>
      </AuthShell>
    );
  }
  const secret = pendingTotpSecret(appContext(), session);

  return (
    <AuthShell
      title="Set up your authenticator"
      subtitle="Add MoneyRight to an authenticator app — Apple Passwords, Google Authenticator, 1Password, Authy — then enter the code it shows."
    >
      <div className="space-y-5">
        <TotpSetup secret={secret} account={user.username} />
        <EnrollForm />
      </div>
    </AuthShell>
  );
}
