/**
 * Runs once as the server starts: opens (and migrates) the database, so a
 * missing key or a bad migration stops the server at launch rather than on
 * someone's first page — and, on a brand-new install, writes the setup code
 * the launcher prints. Then starts the hourly balance refresh.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { appContext, ensureSetupCode, setupCodePath } = await import("./server/context");
  const ctx = appContext();
  if (ensureSetupCode(ctx)) {
    // The code itself stays out of the log; the launcher reads it from the file.
    console.log(`[moneyright] no accounts yet — the setup code is in ${setupCodePath(ctx.dataDir)}`);
  }
  const { startScheduler } = await import("./server/scheduler");
  startScheduler();
}
