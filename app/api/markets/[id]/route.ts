import { fail, ok } from "@/lib/server/http";
import { marketDetail } from "@/lib/server/live";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const d = await marketDetail(id);
    if (!d) return ok({ error: { code: "NOT_FOUND", message: `market ${id} not found` } }, { status: 404 });
    return ok(d);
  } catch (e) {
    return fail(e);
  }
}
