import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { createSchemePlan, listSchemePlans } from "@/features/schemes/scheme-planning.server";

/** Scoped scheme plans. `?schemeId=` narrows to one scheme; `?officerId=` narrows an RM/Admin to one
 *  Sales Officer (server-validated against the caller's scope). */
export async function GET(req: NextRequest) {
  const schemeId = req.nextUrl.searchParams.get("schemeId") ?? undefined;
  const officerId = req.nextUrl.searchParams.get("officerId") ?? undefined;
  // `bucket` enforces the Create Plan / View Plan status split server-side ("create" | "view"; omitted = all).
  const b = req.nextUrl.searchParams.get("bucket");
  const bucket = b === "view" || b === "create" ? b : undefined;
  return handle(async () => ok(await listSchemePlans(await requireAuth(), schemeId, officerId, bucket)));
}

/** Plan a dealer into a scheme (Sales Officer / RM own dealer). */
export async function POST(req: NextRequest) {
  return handle(async () => ok(await createSchemePlan(await requireAuth(), await req.json()), 201));
}
