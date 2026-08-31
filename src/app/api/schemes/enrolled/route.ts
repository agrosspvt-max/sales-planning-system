import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { enrolledSchemes } from "@/features/schemes/scheme-enrolled.server";

/** Schemes with at least one enrolled dealer in the caller's scope (Enrolled Scheme list).
 *  `?officerId=` narrows an RM/Admin to one Sales Officer (server-validated). */
export async function GET(req: NextRequest) {
  const officerId = req.nextUrl.searchParams.get("officerId") ?? undefined;
  return handle(async () => ok(await enrolledSchemes(await requireAuth(), officerId)));
}
