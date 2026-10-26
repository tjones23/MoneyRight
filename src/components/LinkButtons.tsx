"use client";

import { useState, useTransition } from "react";
import {
  linkPlaidAction,
  linkTellerAction,
  plaidLinkTokenAction,
  refreshConnectionAction,
  type LinkResult,
  type TellerEnrollment,
} from "@/app/actions/linking";
import type { PlaidLinkPurpose } from "@/server/providers/plaid";

/**
 * The buttons that open Teller Connect and Plaid Link. Their scripts load
 * only when a button is first pressed, straight from each vendor's CDN (both
 * require that; the CSP allows exactly those two hosts).
 */

interface TellerConnectApi {
  setup(options: Record<string, unknown>): { open(): void };
}
interface PlaidApi {
  create(options: Record<string, unknown>): { open(): void; destroy(): void };
}
declare global {
  interface Window {
    TellerConnect?: TellerConnectApi;
    Plaid?: PlaidApi;
  }
}

const TELLER_SCRIPT = "https://cdn.teller.io/connect/connect.js";
const PLAID_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

const loading = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  let promise = loading.get(src);
  if (!promise) {
    promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => {
        loading.delete(src);
        reject(new Error(`Couldn't load ${new URL(src).host}`));
      };
      document.head.appendChild(script);
    });
    loading.set(src, promise);
  }
  return promise;
}

function Message({ result }: { result: LinkResult | null }) {
  if (!result) return null;
  return result.ok ? (
    result.message ? <p role="status" className="text-sm text-good">{result.message}</p> : null
  ) : (
    <p role="alert" className="text-sm text-danger">{result.error}</p>
  );
}

const buttonStyles = {
  primary: "rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-60",
  quiet: "rounded-full border border-line bg-surface px-3 py-1 text-xs hover:border-muted-dim disabled:opacity-60",
};

// ---------------------------------------------------------------------------
// Teller
// ---------------------------------------------------------------------------

export interface TellerSettings {
  applicationId: string;
  environment: string;
  nonce: string;
}

/** New link, or — with `enrollmentId` and `connectionId` — reconnect an existing one. */
export function TellerButton({
  settings,
  label,
  enrollmentId,
  connectionId,
  tone = "primary",
}: {
  settings: TellerSettings;
  label: string;
  enrollmentId?: string;
  connectionId?: number;
  tone?: keyof typeof buttonStyles;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<LinkResult | null>(null);

  async function open() {
    setResult(null);
    try {
      await loadScript(TELLER_SCRIPT);
    } catch (error) {
      setResult({ ok: false, error: (error as Error).message });
      return;
    }
    window.TellerConnect!.setup({
      applicationId: settings.applicationId,
      environment: settings.environment,
      products: ["balance"],
      nonce: settings.nonce,
      ...(enrollmentId ? { enrollmentId } : {}),
      onSuccess: (enrollment: TellerEnrollment) =>
        startTransition(async () => {
          // A reconnect keeps the same token; a fresh refresh is all it needs.
          setResult(connectionId ? await refreshConnectionAction(connectionId) : await linkTellerAction(enrollment));
        }),
    }).open();
  }

  return (
    <div className="space-y-2">
      <button type="button" onClick={open} disabled={pending} className={buttonStyles[tone]}>
        {pending ? "Saving…" : label}
      </button>
      <Message result={result} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plaid
// ---------------------------------------------------------------------------

async function openPlaid(linkToken: string): Promise<{ publicToken: string; institutionName: string | null } | null> {
  await loadScript(PLAID_SCRIPT);
  return new Promise((resolve) => {
    const handler = window.Plaid!.create({
      token: linkToken,
      onSuccess: (publicToken: string, metadata: { institution?: { name?: string } | null }) => {
        resolve({ publicToken, institutionName: metadata?.institution?.name ?? null });
        handler.destroy();
      },
      onExit: () => {
        resolve(null);
        handler.destroy();
      },
    });
    handler.open();
  });
}

const PURPOSES: { value: PlaidLinkPurpose; label: string }[] = [
  { value: "investments", label: "Brokerage or retirement (Fidelity…)" },
  { value: "liabilities", label: "Mortgage or loan (Rocket Mortgage…)" },
  { value: "bank", label: "Bank Teller doesn't support" },
];

export function PlaidLinkForm({ slotsLeft }: { slotsLeft: number | null }) {
  const [purpose, setPurpose] = useState<PlaidLinkPurpose>("investments");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<LinkResult | null>(null);

  function start() {
    setResult(null);
    startTransition(async () => {
      const token = await plaidLinkTokenAction({ purpose });
      if (!token.ok) return setResult(token);
      let linked;
      try {
        linked = await openPlaid(token.linkToken);
      } catch (error) {
        return setResult({ ok: false, error: (error as Error).message });
      }
      if (linked) setResult(await linkPlaidAction(linked));
    });
  }

  return (
    <div className="space-y-3">
      <label className="block text-sm">
        <span className="font-medium">What are you linking?</span>
        <select
          value={purpose}
          onChange={(e) => setPurpose(e.target.value as PlaidLinkPurpose)}
          className="mt-1 block w-full rounded-lg border border-line bg-surface-2 px-3 py-2"
        >
          {PURPOSES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={start} disabled={pending || slotsLeft === 0} className={buttonStyles.primary}>
        {pending ? "Working…" : "Link with Plaid"}
      </button>
      <Message result={result} />
    </div>
  );
}

export function PlaidReconnectButton({ connectionId }: { connectionId: number }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<LinkResult | null>(null);

  function start() {
    setResult(null);
    startTransition(async () => {
      const token = await plaidLinkTokenAction({ connectionId });
      if (!token.ok) return setResult(token);
      try {
        // Update mode keeps the same Item and token; nothing to exchange.
        if (await openPlaid(token.linkToken)) setResult(await refreshConnectionAction(connectionId));
      } catch (error) {
        setResult({ ok: false, error: (error as Error).message });
      }
    });
  }

  return (
    <div className="space-y-1">
      <button type="button" onClick={start} disabled={pending} className={buttonStyles.quiet}>
        {pending ? "Working…" : "Reconnect"}
      </button>
      <Message result={result} />
    </div>
  );
}

export function RefreshButton({ connectionId }: { connectionId: number }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<LinkResult | null>(null);
  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => startTransition(async () => setResult(await refreshConnectionAction(connectionId)))}
        className={buttonStyles.quiet}
      >
        {pending ? "Refreshing…" : "Refresh"}
      </button>
      <Message result={result} />
    </div>
  );
}
