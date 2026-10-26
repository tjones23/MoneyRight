import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/AuthShell";
import { VerifyForm } from "@/components/AuthForms";
import { requireStage } from "@/server/auth";

export const metadata: Metadata = { title: "Sign in" };

export default async function VerifyPage() {
  const { user } = await requireStage("password");
  return (
    <AuthShell title={`Hi, ${user.displayName}`} subtitle="Enter the code from your authenticator app.">
      <VerifyForm />
      <p className="mt-4 text-xs text-muted">
        Not you? <Link href="/login" className="underline">Start over</Link>
      </p>
    </AuthShell>
  );
}
