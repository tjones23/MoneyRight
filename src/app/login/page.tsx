import type { Metadata } from "next";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/AuthShell";
import { LoginForm } from "@/components/AuthForms";
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
    </AuthShell>
  );
}
