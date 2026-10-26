import { requireUser } from "@/server/auth";
import { appContext } from "@/server/context";
import { exportUserData } from "@/server/my-data";
import { todayKey } from "@/lib/local-date";

/** "Download my data": everything the signed-in person can see, as JSON. */
export async function GET() {
  const { user } = await requireUser();
  const body = JSON.stringify(exportUserData(appContext(), user.id), null, 2);
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="moneyright-${user.username}-${todayKey()}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
