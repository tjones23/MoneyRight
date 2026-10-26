"use client";

import { useActionState, useSyncExternalStore } from "react";
import {
  backupNowAction,
  changePasswordAction,
  createInviteAction,
  deleteAccountAction,
  deleteFinancialDataAction,
  regenerateCodesAction,
  removePersonAction,
} from "@/app/actions/settings";
import type { SettingsState } from "@/app/actions/settings";
import { Field, FormMessage, RecoveryCodes, Submit } from "@/components/ui/forms";
import { PASSWORD_MIN } from "@/lib/password-rules";

const initial: SettingsState = {};

export function ChangePasswordForm() {
  const [state, action] = useActionState(changePasswordAction, initial);
  return (
    <form action={action} className="space-y-4">
      <FormMessage error={state.error} done={state.done} />
      <Field label="Current password" name="current" type="password" autoComplete="current-password" required />
      <Field
        label="New password"
        name="next"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN}
        required
        hint={`At least ${PASSWORD_MIN} characters.`}
      />
      <Field label="New password again" name="confirm" type="password" autoComplete="new-password" required />
      <Submit>Change password</Submit>
    </form>
  );
}

export function RegenerateCodesForm() {
  const [state, action] = useActionState(regenerateCodesAction, initial);
  if (state.recoveryCodes) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted">Your old codes no longer work. These won&apos;t be shown again.</p>
        <RecoveryCodes codes={state.recoveryCodes} />
      </div>
    );
  }
  return (
    <form action={action}>
      <FormMessage error={state.error} />
      <Submit tone="quiet">Make new recovery codes</Submit>
    </form>
  );
}

// The page's own origin, for showing a full invite link. Empty during the
// server render; filled in on the client.
const noop = () => () => {};
function useOrigin() {
  return useSyncExternalStore(noop, () => window.location.origin, () => "");
}

export function CreateInviteForm() {
  const [state, action] = useActionState(createInviteAction, initial);
  const origin = useOrigin();
  const link = state.inviteToken ? `${origin}/invite/${state.inviteToken}` : null;
  return (
    <form action={action} className="space-y-4">
      <FormMessage error={state.error} />
      {link && (
        <div className="space-y-2 rounded-lg border border-good/40 bg-good/10 p-3 text-sm">
          <p>Send this link to the person you&apos;re inviting. It works once, for seven days, and only on the tailnet:</p>
          <p className="break-all font-mono">{link}</p>
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(link)}
            className="rounded-full border border-line bg-surface px-3 py-1 hover:border-muted-dim"
          >
            Copy link
          </button>
        </div>
      )}
      <Field label="Who it's for" name="note" placeholder="e.g. Sam" maxLength={80} hint="Just a label for the list below." />
      <Submit tone="quiet">Create invite link</Submit>
    </form>
  );
}

export function BackupNowForm() {
  const [state, action] = useActionState(backupNowAction, initial);
  return (
    <form action={action} className="space-y-3">
      <FormMessage error={state.error} done={state.done} />
      <Submit tone="quiet">Back up now</Submit>
    </form>
  );
}

export function DeleteFinancialDataForm() {
  const [state, action] = useActionState(deleteFinancialDataAction, initial);
  return (
    <form action={action} className="space-y-3">
      <FormMessage error={state.error} done={state.done} />
      <Field label="Type “delete” to confirm" name="confirm" autoComplete="off" required />
      <Submit tone="danger">Remove all my financial data</Submit>
    </form>
  );
}

export function DeleteAccountForm() {
  const [state, action] = useActionState(deleteAccountAction, initial);
  return (
    <form action={action} className="space-y-3">
      <FormMessage error={state.error} />
      <Field label="Your password" name="password" type="password" autoComplete="current-password" required />
      <Submit tone="danger">Delete my account</Submit>
    </form>
  );
}

export function RemovePersonForm({ userId, username }: { userId: number; username: string }) {
  const [state, action] = useActionState(removePersonAction, initial);
  return (
    <form action={action} className="mt-2 flex flex-wrap items-end gap-2">
      <input type="hidden" name="userId" value={userId} />
      <div className="min-w-0 flex-1">
        <Field label={`Type “${username}” to remove them and all their data`} name="confirm" autoComplete="off" required />
      </div>
      <Submit tone="danger">Remove</Submit>
      <div className="w-full">
        <FormMessage error={state.error} done={state.done} />
      </div>
    </form>
  );
}
