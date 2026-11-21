import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { getSalesBinRestoreContext, restoreSalesBinPlan } from "@/features/planning/lifecycle.server";

const target = z.object({ kind: z.enum(["SEASONAL", "MONTHLY"]), id: z.string().min(1) });
const restore = target.extend({ mode: z.enum(["RESTORE", "REPLACE_ACTIVE", "HISTORICAL"]), expectedActiveIds: z.array(z.string().min(1)) });
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const { kind, id } = target.parse(Object.fromEntries(req.nextUrl.searchParams));
    return ok(await getSalesBinRestoreContext(ctx, kind, id));
  });
}
export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const { kind, id, mode, expectedActiveIds } = restore.parse(await req.json());
    return ok(await restoreSalesBinPlan(ctx, kind, id, mode, expectedActiveIds));
  });
}
