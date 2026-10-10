import { handle, ok, requireAuth } from "@/lib/http";
import { listDistrictOptions } from "@/features/party-planning/territory.server";

// GET /api/territory-mapping/districts — the ACTIVE districts the caller may pick from, grouped by State (UserGroup id). Scope is applied in the service.
export async function GET() {
  return handle(async () => ok(await listDistrictOptions(await requireAuth())));
}
