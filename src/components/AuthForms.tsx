"use client";

import { useActionState } from "react";
import { enrollAction, finishEnrollAction, inviteAction, loginAction, setupAction, verifyAction } from "@/app/actions/auth";
import type { FormState } from "@/app/actions/auth";
import { Field, FormMessage, Submit } from "@/components/ui/forms";
import { PASSWORD_MIN } from "@/lib/password-rules";

const initial: FormState = {};

function NewAccountFields() {
  return (
    <>
      <Field label="Your name" name="displayName" autoComplete="name" required />
      <Field
        label="Username"
        name="username"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        required
        hint="What you'll sign in with."
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN}
        required
        hint={`At least ${PASSWORD_MIN} characters. A password manager's suggestion is ideal.`}
      />
      <Field label="Password again" name="confirm" type="password" autoComplete="new-password" required />
    </>
  );
}

export function SetupForm() {
  const [state, action] = useActionState(setupAction, initial);
  return (
    <form action={action} className="space-y-4">
      <FormMessage error={state.error} />
      <Field
        label="Setup code"
        name="setupCode"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        required
        hint="Printed by the launcher when the server starts. It proves you're at this Mac."
      />
      <NewAccountFields />
      <Submit>Create account</Submit>
    </form>
  );
}

export function InviteForm({ token }: { token: string }) {
  const [state, action] = useActionState(inviteAction, initial);
  return (
    <form action={action} className="space-y-4">
      <FormMessage error={state.error} />
      <input type="hidden" name="token" value={token} />
      <NewAccountFields />
      <Submit>Create account</Submit>
    </form>
  );
}

export function LoginForm() {
  const [state, action] = useActionState(loginAction, initial);
  return (
    <form action={action} className="space-y-4">
      <FormMessage error={state.error} />
      <Field label="Username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required />
      <Field label="Password" name="password" type="password" autoComplete="current-password" required />
      <Submit>Continue</Submit>
    </form>
  );
}

export function VerifyForm() {
  const [state, action] = useActionState(verifyAction, initial);
  return (
    <form action={action} className="space-y-4">
      <FormMessage error={state.error} />
      <Field
        label="Code"
        name="code"
        autoComplete="one-time-code"
        inputMode="text"
        autoCapitalize="none"
        spellCheck={false}
        autoFocus
        required
        hint="The six digits in your authenticator app — or one of your recovery codes."
      />
      <Submit>Sign in</Submit>
    </form>
  );
}

export function EnrollForm() {
  const [state, action] = useActionState(enrollAction, initial);
  return (
    <form action={action} className="space-y-4">
      <FormMessage error={state.error} />
      <Field
        label="Code from the app"
        name="code"
        autoComplete="one-time-code"
        inputMode="numeric"
        pattern="[0-9 ]*"
        required
      />
      <Submit>Confirm</Submit>
    </form>
  );
}

export function FinishEnrollForm({ label }: { label: string }) {
  return (
    <form action={finishEnrollAction}>
      <Submit>{label}</Submit>
    </form>
  );
}
