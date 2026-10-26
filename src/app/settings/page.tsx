import type { Metadata } from "next";
import { PageBody, SiteHeader } from "@/components/SiteHeader";
import { ChangePasswordForm, CreateInviteForm, RegenerateCodesForm } from "@/components/SettingsForms";
import { requireUser } from "@/server/auth";
import { appContext } from "@/server/context";
import { listOpenInvites, listSessions, listUsers, recentEvents, unusedRecoveryCodeCount } from "@/server/accounts";
import { resetTotpAction, revokeInviteAction, revokeSessionAction, signOutOthersAction } from "@/app/actions/settings";

export const metadata: Metadata = { title: "Settings" };

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5">
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Unknown browser";
  const os = /iPhone|iPad/.test(userAgent) ? "iOS" : /Mac OS X/.test(userAgent) ? "Mac" : /Android/.test(userAgent) ? "Android" : /Windows/.test(userAgent) ? "Windows" : "";
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Firefox\//.test(userAgent) ? "Firefox" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  return os ? `${browser} on ${os}` : browser;
}

export default async function SettingsPage() {
  const { user, session } = await requireUser();
  const { db, secondFactorRequired } = appContext();
  const sessions = listSessions(db, user.id);
  const codesLeft = unusedRecoveryCodeCount(db, user.id);
  const events = recentEvents(db, user.id);

  return (
    <>
      <SiteHeader user={user} />
      <PageBody title="Settings" subtitle={`Signed in as ${user.username}${user.isAdmin ? " · admin" : ""}`}>
        <Section title="Password">
          <ChangePasswordForm />
        </Section>

        {secondFactorRequired && (
          <Section title="Recovery codes">
            <p className="mb-4 text-sm text-muted">
              {codesLeft} of 10 unused. Each signs you in once if you don&apos;t have your authenticator.
            </p>
            <RegenerateCodesForm />
          </Section>
        )}

        <Section title="Where you're signed in">
          <ul className="divide-y divide-line-soft text-sm">
            {sessions.map((s) => (
              <li key={s.idHash} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p>
                    {describeDevice(s.userAgent)}
                    {s.idHash === session.idHash && <span className="ml-2 text-xs text-accent">this browser</span>}
                  </p>
                  <p className="text-xs text-muted">
                    {s.tailnetLogin ?? "this Mac"} · signed in {when.format(s.createdAt)}
                  </p>
                </div>
                {s.idHash !== session.idHash && (
                  <form action={revokeSessionAction}>
                    <input type="hidden" name="id" value={s.idHash} />
                    <button type="submit" className="rounded-full border border-line px-3 py-1 text-xs hover:border-muted-dim">
                      Sign out
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          {sessions.length > 1 && (
            <form action={signOutOthersAction} className="mt-3">
              <button type="submit" className="text-sm text-danger underline">
                Sign out everywhere else
              </button>
            </form>
          )}
        </Section>

        {user.isAdmin && <AdminSections adminId={user.id} />}

        <Section title="Recent activity">
          <ul className="space-y-1 text-sm">
            {events.map((e, i) => (
              <li key={i} className="flex gap-3">
                <span className="w-40 shrink-0 text-muted">{when.format(e.at)}</span>
                <span>
                  {e.event.replaceAll("-", " ")}
                  {e.detail && <span className="text-muted"> — {e.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      </PageBody>
    </>
  );
}

function AdminSections({ adminId }: { adminId: number }) {
  const { db } = appContext();
  const users = listUsers(db);
  const invites = listOpenInvites(db);
  return (
    <>
      <Section title="People">
        <ul className="divide-y divide-line-soft text-sm">
          {users.map((u) => (
            <li key={u.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p>
                  {u.displayName} <span className="text-muted">({u.username})</span>
                  {u.isAdmin && <span className="ml-2 text-xs text-accent">admin</span>}
                </p>
                <p className="text-xs text-muted">{u.hasTotp ? "Authenticator set up" : "Hasn't set up an authenticator yet"}</p>
              </div>
              {u.id !== adminId && u.hasTotp && (
                <form action={resetTotpAction}>
                  <input type="hidden" name="userId" value={u.id} />
                  <button type="submit" className="rounded-full border border-danger/50 px-3 py-1 text-xs text-danger hover:bg-danger/10">
                    Reset authenticator
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Invite someone">
        <CreateInviteForm />
        {invites.length > 0 && (
          <ul className="mt-5 divide-y divide-line-soft text-sm">
            {invites.map((inv) => (
              <li key={inv.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p>{inv.note || "Unlabeled invite"}</p>
                  <p className="text-xs text-muted">Expires {when.format(inv.expiresAt)}</p>
                </div>
                <form action={revokeInviteAction}>
                  <input type="hidden" name="id" value={inv.id} />
                  <button type="submit" className="rounded-full border border-line px-3 py-1 text-xs hover:border-muted-dim">
                    Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
