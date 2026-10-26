"use server";

import { refresh } from "next/cache";
import { appContext } from "@/server/context";
import { AccountError, logEvent } from "@/server/accounts";
import { allowAttempt, requireUser } from "@/server/auth";
import {
  connectionToken,
  countPlaidItem,
  deleteConnection,
  getConnection,
  PLAID_TRIAL_ITEMS,
  plaidItemsUsed,
  saveConnection,
  setIncludeInNetWorth,
} from "@/server/finance";
import { plaidConfig, tellerConfig } from "@/server/providers/config";
import { providers } from "@/server/providers";
import { ProviderError } from "@/server/providers/http";
import { tellerNonce, verifyTellerSignatures } from "@/server/providers/teller";
import type { PlaidLinkPurpose } from "@/server/providers/plaid";
import { syncConnection } from "@/server/sync";

/**
 * Linking, refreshing and removing connections. The browser runs Teller
 * Connect or Plaid Link and hands the result here; everything that touches a
 * token happens on the server.
 */

export type LinkResult = { ok: true; message?: string } | { ok: false; error: string };

function short(value: unknown, max = 200): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function failure(error: unknown): LinkResult {
  if (error instanceof AccountError) return { ok: false, error: error.message };
  if (error instanceof ProviderError) {
    console.warn(`[moneyright] ${error.provider} link step failed: ${error.code}`);
    return { ok: false, error: `${error.provider === "teller" ? "Teller" : "Plaid"} said no (${error.code}). Try again in a minute.` };
  }
  throw error;
}

function linked(count: number, institution: string): string {
  return `Linked ${institution}: ${count} account${count === 1 ? "" : "s"}.`;
}

// ---------------------------------------------------------------------------
// Teller
// ---------------------------------------------------------------------------

export interface TellerEnrollment {
  accessToken: string;
  user: { id: string };
  enrollment: { id: string; institution: { name: string } };
  signatures?: string[];
}

export async function linkTellerAction(enrollment: TellerEnrollment): Promise<LinkResult> {
  const { user, session, request } = await requireUser();
  if (!allowAttempt("link", user.username, request)) return { ok: false, error: "Too many tries. Wait a few minutes." };
  const config = tellerConfig();
  if (!config) return { ok: false, error: "Teller isn't set up on this server." };
  const ctx = appContext();

  const accessToken = short(enrollment?.accessToken);
  const enrollmentId = short(enrollment?.enrollment?.id);
  const institutionName = short(enrollment?.enrollment?.institution?.name, 80) || "Bank";
  if (!accessToken || !enrollmentId) return { ok: false, error: "Teller didn't return an enrollment." };

  if (config.signingKey) {
    const valid = verifyTellerSignatures({
      signingKey: config.signingKey,
      signatures: Array.isArray(enrollment.signatures) ? enrollment.signatures.map((s) => short(s, 500)) : [],
      nonce: tellerNonce(ctx.key, session.idHash),
      accessToken,
      userId: short(enrollment?.user?.id),
      enrollmentId,
      environment: config.environment,
    });
    if (!valid) {
      logEvent(ctx.db, user.id, "link-refused", Date.now(), "Teller signature didn't verify");
      return { ok: false, error: "Teller's response couldn't be verified, so it wasn't saved." };
    }
  }

  try {
    const now = Date.now();
    const connection = saveConnection(
      ctx,
      { userId: user.id, provider: "teller", externalId: enrollmentId, institutionName, accessToken },
      now,
    );
    const result = await syncConnection(ctx, providers(), connection, now);
    logEvent(ctx.db, user.id, "linked", now, `${institutionName} (Teller)`);
    refresh();
    if (result.status !== "ok") return { ok: true, message: `Linked ${institutionName}, but the first refresh failed (${result.code}).` };
    return { ok: true, message: linked(result.accounts, institutionName) };
  } catch (error) {
    return failure(error);
  }
}

// ---------------------------------------------------------------------------
// Plaid
// ---------------------------------------------------------------------------

/** The token Plaid Link opens with: a new link for `purpose`, or update mode for `connectionId`. */
export async function plaidLinkTokenAction(
  input: { purpose: PlaidLinkPurpose } | { connectionId: number },
): Promise<{ ok: true; linkToken: string } | { ok: false; error: string }> {
  const { user, request } = await requireUser();
  if (!allowAttempt("link", user.username, request)) return { ok: false, error: "Too many tries. Wait a few minutes." };
  const config = plaidConfig();
  const plaid = providers().plaid;
  if (!config || !plaid) return { ok: false, error: "Plaid isn't set up on this server." };
  const ctx = appContext();

  try {
    if ("connectionId" in input) {
      const connection = getConnection(ctx.db, user.id, Number(input.connectionId));
      if (!connection || connection.provider !== "plaid") return { ok: false, error: "That connection doesn't exist." };
      return { ok: true, linkToken: await plaid.createLinkToken({ userId: user.id, accessToken: connectionToken(ctx, connection) }) };
    }
    if (config.environment === "production" && plaidItemsUsed(ctx.db) >= PLAID_TRIAL_ITEMS) {
      return { ok: false, error: `All ${PLAID_TRIAL_ITEMS} of Plaid's free links have been used. Removing one doesn't give it back.` };
    }
    const purpose: PlaidLinkPurpose = ["investments", "liabilities", "bank"].includes(input.purpose) ? input.purpose : "investments";
    return { ok: true, linkToken: await plaid.createLinkToken({ userId: user.id, purpose }) };
  } catch (error) {
    const result = failure(error);
    return result.ok ? { ok: false, error: "Couldn't start Plaid." } : result;
  }
}

export async function linkPlaidAction(input: { publicToken: string; institutionName?: string | null }): Promise<LinkResult> {
  const { user, request } = await requireUser();
  if (!allowAttempt("link", user.username, request)) return { ok: false, error: "Too many tries. Wait a few minutes." };
  const plaid = providers().plaid;
  if (!plaid) return { ok: false, error: "Plaid isn't set up on this server." };
  const ctx = appContext();
  const publicToken = short(input?.publicToken);
  if (!publicToken) return { ok: false, error: "Plaid didn't return a link." };

  try {
    const now = Date.now();
    const { accessToken, itemId } = await plaid.exchangePublicToken(publicToken);
    // Counted the moment the Item exists: that's when Plaid counts it.
    if (plaid.environment === "production") countPlaidItem(ctx.db);
    const institutionName = short(input.institutionName, 80) || "Institution";
    const connection = saveConnection(
      ctx,
      { userId: user.id, provider: "plaid", externalId: itemId, institutionName, accessToken },
      now,
    );
    const result = await syncConnection(ctx, providers(), connection, now);
    logEvent(ctx.db, user.id, "linked", now, `${institutionName} (Plaid)`);
    refresh();
    if (result.status !== "ok") {
      // Investments and liabilities can take a few minutes to be ready on a brand-new Item.
      return { ok: true, message: `Linked ${institutionName}. Balances will appear once Plaid has them (${result.code}).` };
    }
    return { ok: true, message: linked(result.accounts, institutionName) };
  } catch (error) {
    return failure(error);
  }
}

// ---------------------------------------------------------------------------
// Either provider
// ---------------------------------------------------------------------------

/** After a reconnect in update mode, or the Refresh button. */
export async function refreshConnectionAction(connectionId: number): Promise<LinkResult> {
  const { user, request } = await requireUser();
  if (!allowAttempt("refresh", user.username, request)) return { ok: false, error: "Refreshed a lot just now — wait a few minutes." };
  const ctx = appContext();
  const connection = getConnection(ctx.db, user.id, Number(connectionId));
  if (!connection) return { ok: false, error: "That connection doesn't exist." };
  const result = await syncConnection(ctx, providers(), connection, Date.now());
  refresh();
  if (result.status === "ok") return { ok: true, message: `${connection.institutionName} is up to date.` };
  if (result.status === "reconnect") return { ok: false, error: `${connection.institutionName} needs you to sign in again.` };
  return { ok: false, error: `${connection.institutionName} couldn't be refreshed (${result.code}). It'll retry within the hour.` };
}

/** Revokes access at the provider (best effort), then forgets the connection and its history. */
export async function removeConnectionAction(form: FormData) {
  const { user } = await requireUser();
  const ctx = appContext();
  const connection = getConnection(ctx.db, user.id, Number(form.get("connectionId")));
  if (!connection) return;
  const clients = providers();
  try {
    const token = connectionToken(ctx, connection);
    if (connection.provider === "teller") await clients.teller?.removeEnrollment(token);
    else await clients.plaid?.removeItem(token);
  } catch (error) {
    // Still removed here: the person asked, and a dead token is harmless.
    console.warn(`[moneyright] revoking connection #${connection.id} failed:`, error instanceof ProviderError ? error.code : "unexpected");
  }
  deleteConnection(ctx.db, user.id, connection.id);
  logEvent(ctx.db, user.id, "unlinked", Date.now(), connection.institutionName);
  refresh();
}

export async function setIncludeAction(form: FormData) {
  const { user } = await requireUser();
  setIncludeInNetWorth(appContext().db, user.id, Number(form.get("accountId")), form.get("include") === "1");
  refresh();
}
