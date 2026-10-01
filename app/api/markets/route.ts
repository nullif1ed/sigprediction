import { fail, ok } from "@/lib/server/http";
import { marketsTable } from "@/lib/server/live";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    return ok(await marketsTable());
  } catch (e) {
    return fail(e);
  }
}
