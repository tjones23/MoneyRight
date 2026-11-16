import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/AuthShell";
import { VerifyForm } from "@/components/AuthForms";
import { requireStage } from "@/server/auth";
import { appContext } from "@/server/context";
import { hasPasskeyFor } from "@/server/passkeys";
import { hasPushDevice } from "@/server/push";
import { PasskeySignInButton } from "@/components/PasskeyButtons";
import { PushSignInButton } from "@/components/PushButtons";

export const metadata: Metadata = { title: "Sign in" };

export default async function VerifyPage() {
  const { user, request } = await requireStage("password");
  const { db } = appContext();
  const passkey = hasPasskeyFor(db, user.id, request.relyingParty.id);
  const push = hasPushDevice(db, user.id);
  return (
    <AuthShell
      title={`Hi, ${user.displayName}`}
      subtitle={
        passkey || push
          ? "Confirm it's you."
          : "Enter the code from your authenticator app — Apple Passwords, Google Authenticator or another."
      }
    >
      {(passkey || push) && (
        <div className="mb-5 space-y-3">
          {push && <PushSignInButton />}
          {passkey && <PasskeySignInButton />}
          <p className="pt-1 text-center text-xs text-muted">or enter a code from your authenticator app</p>
        </div>
      )}
      <VerifyForm />
      <p className="mt-4 text-xs text-muted">
        Not you? <Link href="/login" className="underline">Start over</Link>
      </p>
    </AuthShell>
  );
}
