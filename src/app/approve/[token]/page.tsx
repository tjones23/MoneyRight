import type { Metadata } from "next";
import { connection } from "next/server";
import { AuthShell } from "@/components/AuthShell";
import { ApproveForm } from "@/components/PushButtons";
import { appContext } from "@/server/context";
import { pendingApproval } from "@/server/push";

export const metadata: Metadata = { title: "Approve sign-in" };

const when = new Intl.DateTimeFormat("en-US", { timeStyle: "short" });

/**
 * Where a sign-in request's notification opens, on the phone. Needs no
 * session: the one-time link, sent encrypted to this device alone, is the
 * proof (server/push.ts).
 */
export default async function ApprovePage({ params }: PageProps<"/approve/[token]">) {
  const { token } = await params;
  await connection();
  const request = pendingApproval(appContext().db, token);
  if (!request) {
    return (
      <AuthShell title="Nothing to approve" subtitle="This request has expired or was already answered. Requests last two minutes.">
        <p className="text-sm text-muted">Send a new one from the sign-in screen if you still need it.</p>
      </AuthShell>
    );
  }
  return (
    <AuthShell
      title={`Sign in as ${request.displayName}?`}
      subtitle={
        <>
          {request.detail}, at {when.format(request.createdAt)}. Only approve if that&apos;s you, right now — enter the number
          showing on that screen.
        </>
      }
    >
      <ApproveForm token={token} />
    </AuthShell>
  );
}
