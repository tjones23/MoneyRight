"use server";

import { refresh } from "next/cache";
import { appContext } from "@/server/context";
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
import { requireAdmin, requireUser } from "@/server/auth";

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
