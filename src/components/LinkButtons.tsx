"use client";

import { useState, useTransition } from "react";
import {
  linkPlaidAction,
  plaidLinkTokenAction,
  refreshConnectionAction,
  type LinkResult,
} from "@/app/actions/linking";
import type { PlaidLinkPurpose } from "@/server/providers/plaid";

/**
 * The buttons that open Plaid Link. Its script loads only when a button is
 * first pressed, straight from Plaid's CDN (Plaid requires that; the CSP
 * allows exactly that host).
 */

interface PlaidApi {
  create(options: Record<string, unknown>): { open(): void; destroy(): void };
}
declare global {
  interface Window {
    Plaid?: PlaidApi;
  }
}

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
  { value: "bank", label: "Bank or credit card (Chase, PNC…)" },
  { value: "investments", label: "Brokerage or retirement (Fidelity…)" },
  { value: "liabilities", label: "Mortgage or loan (Rocket Mortgage…)" },
];

export function PlaidLinkForm({ slotsLeft }: { slotsLeft: number | null }) {
  const [purpose, setPurpose] = useState<PlaidLinkPurpose>("bank");
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
