import type { Metadata } from "next";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/AuthShell";
import { LoginForm } from "@/components/AuthForms";
import { PasskeyLoginButton } from "@/components/PasskeyButtons";
import { appContext, hasUsers } from "@/server/context";
import { currentSession } from "@/server/auth";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  await connection();
  if (!hasUsers(appContext().db)) redirect("/setup");
  if ((await currentSession())?.session.stage === "full") redirect("/");
  return (
    <AuthShell title="Sign in">
      <LoginForm />
      <div className="mt-5 space-y-3">
        <p className="text-center text-xs text-muted">or, with no password</p>
        <PasskeyLoginButton />
      </div>
    </AuthShell>
  );
}
