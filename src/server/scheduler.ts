import { appContext } from "./context";
import { providers } from "./providers";
import { syncDue } from "./sync";
import { backupDue, makeBackup, recordBackupError } from "./backup";

/**
 * Refreshes balances in the background: shortly after the server starts,
 * then every hour, each pass doing only what's due (see sync.ts) — then, if
 * there's been none in a day, the nightly backup (backup.ts). In this
 * process, because nothing outside the tailnet can call in — no webhooks —
 * and there's nothing else running to do it.
 */

const FIRST_PASS_MS = 30_000;
const PASS_EVERY_MS = 60 * 60_000;

const globalForScheduler = globalThis as unknown as { __moneyrightScheduler?: boolean };

export function startScheduler() {
  // Once per process, even when dev-mode hot reloads run this again.
  if (globalForScheduler.__moneyrightScheduler) return;
  globalForScheduler.__moneyrightScheduler = true;

  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      await refreshAndBackUp();
    } finally {
      running = false;
    }
  };
  setTimeout(pass, FIRST_PASS_MS).unref();
  setInterval(pass, PASS_EVERY_MS).unref();
}

async function refreshAndBackUp() {
  try {
    const count = await syncDue(appContext(), providers(), Date.now());
    if (count) console.log(`[moneyright] refreshed ${count} connection${count === 1 ? "" : "s"}`);
  } catch (error) {
    console.error("[moneyright] refresh pass failed:", error instanceof Error ? error.name : "unknown");
  }
  const ctx = appContext();
  if (backupDue(ctx, Date.now())) {
    try {
      await makeBackup(ctx, Date.now());
      console.log("[moneyright] backup written");
    } catch (error) {
      recordBackupError(ctx, error);
      console.error("[moneyright] backup failed:", error instanceof Error ? error.name : "unknown");
    }
  }
}
