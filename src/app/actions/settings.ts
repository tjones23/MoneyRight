"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { appContext, ensureSetupCode, hasUsers } from "@/server/context";
import {
  AccountError,
  changePassword,
  createInvite,
  regenerateRecoveryCodes,
  resetTotp,
  revokeInvite,
  revokeOtherSessions,
  revokeSession,
} from "@/server/accounts";
import { clearSessionCookie, requireAdmin, requireUser } from "@/server/auth";
import { makeBackup, recordBackupError } from "@/server/backup";
import { deleteFinancialData, deleteOwnAccount, removePerson } from "@/server/my-data";
import { providers } from "@/server/providers";

/** Settings: each action checks for itself who is signed in, and as what. */

export interface SettingsState {
  error?: string;
  done?: string;
  recoveryCodes?: string[];
  inviteToken?: string;
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

async function guarded(fn: () => Promise<SettingsState> | SettingsState): Promise<SettingsState> {
  try {
    const result = await fn();
    refresh();
    return result;
  } catch (error) {
    if (error instanceof AccountError) return { error: error.message };
    throw error;
  }
}

export async function changePasswordAction(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const { user, session } = await requireUser();
  if (field(form, "next") !== field(form, "confirm")) return { error: "The new passwords don't match." };
  return guarded(async () => {
    await changePassword(appContext().db, user.id, field(form, "current"), field(form, "next"), session.idHash, Date.now());
    return { done: "Password changed. Every other session was signed out." };
  });
}

export async function revokeSessionAction(form: FormData) {
  const { user, session } = await requireUser();
  const id = field(form, "id");
  if (id && id !== session.idHash) revokeSession(appContext().db, user.id, id, Date.now());
  refresh();
}

export async function signOutOthersAction() {
  const { user, session } = await requireUser();
  revokeOtherSessions(appContext().db, user.id, session.idHash, Date.now());
  refresh();
}

export async function regenerateCodesAction(): Promise<SettingsState> {
  const { user } = await requireUser();
  return guarded(() => ({ recoveryCodes: regenerateRecoveryCodes(appContext().db, user.id, Date.now()) }));
}

export async function createInviteAction(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const { user } = await requireAdmin();
  return guarded(() => ({ inviteToken: createInvite(appContext().db, user.id, field(form, "note"), Date.now()) }));
}

export async function revokeInviteAction(form: FormData) {
  const { user } = await requireAdmin();
  revokeInvite(appContext().db, user.id, field(form, "id"));
  refresh();
}

export async function resetTotpAction(form: FormData) {
  const { user } = await requireAdmin();
  resetTotp(appContext().db, user.id, Number(field(form, "userId")), Date.now());
  refresh();
}

export async function backupNowAction(): Promise<SettingsState> {
  await requireAdmin();
  const ctx = appContext();
  try {
    await makeBackup(ctx, Date.now());
  } catch (error) {
    recordBackupError(ctx, error);
    refresh();
    return { error: "The backup failed — see the server log." };
  }
  refresh();
  return { done: "Backed up." };
}

export async function deleteFinancialDataAction(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const { user } = await requireUser();
  if (field(form, "confirm").trim().toLowerCase() !== "delete") return { error: "Type “delete” to confirm." };
  await deleteFinancialData(appContext(), providers(), user.id, Date.now());
  refresh();
  return { done: "Every bank link was revoked, and all your accounts, balances and loans are gone." };
}

export async function deleteAccountAction(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const { user } = await requireUser();
  const ctx = appContext();
  try {
    await deleteOwnAccount(ctx, providers(), user.id, field(form, "password"));
  } catch (error) {
    if (error instanceof AccountError) return { error: error.message };
    throw error;
  }
  await clearSessionCookie();
  // The last account gone: MoneyRight is back to first-run, with a new setup code.
  if (!hasUsers(ctx.db)) {
    ensureSetupCode(ctx);
    redirect("/setup");
  }
  redirect("/login");
}

export async function removePersonAction(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const { user } = await requireAdmin();
  return guarded(async () => {
    await removePerson(appContext(), providers(), user.id, Number(field(form, "userId")), field(form, "confirm"), Date.now());
    return { done: "Removed." };
  });
}
