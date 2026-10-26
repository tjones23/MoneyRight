import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/AuthShell";
import { VerifyForm } from "@/components/AuthForms";
import { requireStage } from "@/server/auth";
import { appContext } from "@/server/context";
import { hasPasskeyFor } from "@/server/passkeys";
import { PasskeySignInButton } from "@/components/PasskeyButtons";

export const metadata: Metadata = { title: "Sign in" };

export default async function VerifyPage() {
  const { user, request } = await requireStage("password");
  const passkey = hasPasskeyFor(appContext().db, user.id, request.relyingParty.id);
  return (
    <AuthShell title={`Hi, ${user.displayName}`} subtitle="Enter the code from your authenticator app.">
      {passkey && (
        <div className="mb-5 space-y-4">
          <PasskeySignInButton />
          <p className="text-center text-xs text-muted">or enter a code</p>
        </div>
      )}
      <VerifyForm />
      <p className="mt-4 text-xs text-muted">
        Not you? <Link href="/login" className="underline">Start over</Link>
      </p>
    </AuthShell>
  );
}
