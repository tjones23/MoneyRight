import { PageBody, SiteHeader } from "@/components/SiteHeader";
import { requireUser } from "@/server/auth";

/**
 * The overview. Linked accounts (Teller, Plaid), the student-loan schedule and
 * the net-worth history arrive in phase 2; for now it confirms you're in.
 */
export default async function OverviewPage() {
  const { user } = await requireUser();
  return (
    <>
      <SiteHeader user={user} />
      <PageBody title={`Hi, ${user.displayName}`} subtitle="Your balances and net worth will live here.">
        <section className="rounded-2xl border border-dashed border-line p-6 text-sm text-muted">
          <p className="font-medium text-text">No accounts linked yet</p>
          <p className="mt-2">
            Linking banks and cards (Teller), brokerages and loans (Plaid), and the student-loan schedule comes next.
            Until then, Settings is where you manage your sign-in and invite others.
          </p>
        </section>
      </PageBody>
    </>
  );
}
