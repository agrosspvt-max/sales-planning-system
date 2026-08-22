import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { createSchemePlan, listSchemePlans } from "@/features/schemes/scheme-planning.server";

/** Scoped scheme plans. `?schemeId=` narrows to one scheme (the Scheme detail view). */
export async function GET(req: NextRequest) {
  const schemeId = req.nextUrl.searchParams.get("schemeId") ?? undefined;
  return handle(async () => ok(await listSchemePlans(await requireAuth(), schemeId)));
}

/** Plan a dealer into a scheme (Sales Officer / RM own dealer). */
export async function POST(req: NextRequest) {
  return handle(async () => ok(await createSchemePlan(await requireAuth(), await req.json()), 201));
}
