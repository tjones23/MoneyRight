import type { Metadata } from "next";
import QRCode from "qrcode";
import { AuthShell } from "@/components/AuthShell";
import { EnrollForm, FinishEnrollForm } from "@/components/AuthForms";
import { requireStage } from "@/server/auth";
import { appContext } from "@/server/context";
import { enrollmentRecoveryCodes, pendingTotpSecret } from "@/server/accounts";
import { RecoveryCodes } from "@/components/ui/forms";
import { base32Encode } from "@/lib/base32";
import { otpauthUri } from "@/lib/totp";

export const metadata: Metadata = { title: "Set up your authenticator" };

/**
 * Every account needs a second factor before it sees anything. The QR code
 * is drawn here on the server, so the secret never passes through any
 * third-party service.
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
  const uri = otpauthUri(secret, user.username);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: "M" });
  const typed = base32Encode(secret).match(/.{1,4}/g)!.join(" ");

  return (
    <AuthShell
      title="Set up your authenticator"
      subtitle="Scan this with an authenticator app — Apple Passwords, 1Password, Google Authenticator, Authy — then enter the code it shows."
    >
      <div className="space-y-5">
        {/* eslint-disable-next-line @next/next/no-img-element -- a data: URI, nothing to optimize */}
        <img src={qr} alt="QR code for your authenticator app" width={220} height={220} className="mx-auto rounded-lg bg-white" />
        <details className="text-sm text-muted">
          <summary className="cursor-pointer">Can&apos;t scan? Enter this key instead</summary>
          <p className="mt-2 break-all font-mono text-text">{typed}</p>
        </details>
        <EnrollForm />
      </div>
    </AuthShell>
  );
}
