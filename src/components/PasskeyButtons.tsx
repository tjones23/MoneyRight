"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import {
  addPasskeyAction,
  passkeyRegistrationOptionsAction,
  passkeySignInAction,
  passkeySignInOptionsAction,
} from "@/app/actions/passkeys";

/** The browser half of passkeys: the OS's own passkey prompt, then the server checks the result. */

const noop = () => () => {};

function cancelled(error: unknown) {
  return error instanceof Error && (error.name === "NotAllowedError" || error.name === "AbortError");
}

export function AddPasskeyForm() {
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function add() {
    setMessage(null);
    startTransition(async () => {
      try {
        const optionsJSON = await passkeyRegistrationOptionsAction();
        const response = await startRegistration({ optionsJSON });
        const result = await addPasskeyAction(response, name || "Passkey");
        setMessage(result.ok ? { ok: true, text: "Passkey added." } : { ok: false, text: result.error });
        if (result.ok) setName("");
      } catch (error) {
        setMessage({ ok: false, text: cancelled(error) ? "Cancelled." : "This browser couldn't make a passkey." });
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          placeholder="Name, e.g. iPhone"
          aria-label="Passkey name"
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-base outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={add}
          disabled={pending}
          className="rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium hover:border-muted-dim disabled:opacity-60"
        >
          {pending ? "Waiting…" : "Add a passkey"}
        </button>
      </div>
      {message && <p className={`text-sm ${message.ok ? "text-good" : "text-danger"}`}>{message.text}</p>}
    </div>
  );
}

export function PasskeySignInButton() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Decided on the client — it's the browser's support that matters — and
  // hidden in the server render, so the two never disagree.
  const supported = useSyncExternalStore(noop, browserSupportsWebAuthn, () => false);
  if (!supported) return null;

  function signIn() {
    setError(null);
    startTransition(async () => {
      try {
        const optionsJSON = await passkeySignInOptionsAction();
        if (!optionsJSON) {
          setError("You have no passkey for this address — use your authenticator code.");
          return;
        }
        const result = await passkeySignInAction(await startAuthentication({ optionsJSON }));
        // On success the action redirects; only a failure comes back.
        if (result && !result.ok) setError(result.error);
      } catch (e) {
        // A redirect from the action surfaces here as a navigation, not an error to show.
        if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e;
        setError(cancelled(e) ? "Cancelled." : "That passkey didn't work. Use your authenticator code.");
      }
    });
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={signIn}
        disabled={pending}
        className="w-full rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium hover:border-muted-dim disabled:opacity-60"
      >
        {pending ? "Waiting for your passkey…" : "Use a passkey"}
      </button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
