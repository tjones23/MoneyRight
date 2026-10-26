import type { Metadata } from "next";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/AuthShell";
import { SetupForm } from "@/components/AuthForms";
import { appContext, hasUsers } from "@/server/context";

export const metadata: Metadata = { title: "Set up" };

export default async function SetupPage() {
  // At request time only — never let the build open the database.
  await connection();
  if (hasUsers(appContext().db)) redirect("/login");
  return (
    <AuthShell
      title="Set up MoneyRight"
      subtitle="Create the first account. It's the admin: it can invite others from Settings."
    >
      <SetupForm />
    </AuthShell>
  );
}
