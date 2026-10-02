import { fail, ok, statefulGuard } from "@/lib/server/http";
import { marketsTable } from "@/lib/server/live";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  // The SIG read budget is per account: only the bot host reads SIG (Vercel proxies or declines).
  const g = await statefulGuard(req);
  if (g) return g;
  try {
    return ok(await marketsTable());
  } catch (e) {
    return fail(e);
  }
}
