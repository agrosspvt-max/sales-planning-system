import { type NextRequest } from "next/server";
import { handle, ok, requirePermission } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { createSeason, listSeasons } from "@/features/seasons/service.server";
import { hasAdminPermission, isAdministrativeRole } from "@/features/accounts/permissions";
import { ApiError } from "@/lib/http";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requirePermission("seasons", "read");
    const search = (req.nextUrl.searchParams.get("search") ?? "").trim();
    // Only the management view can include closed periods, so they can be reopened.
    const management = req.nextUrl.searchParams.get("management") === "true";
    if (management && !(isAdministrativeRole(auth.role) && hasAdminPermission(auth, "seasons", "read"))) {
      throw new ApiError(403, "Only Seasons management can view closed seasons");
    }
    const activeOnly = !management;
    return ok(await listSeasons(search, activeOnly));
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requirePermission("seasons", "create");
    const season = await createSeason(await req.json());
    await writeAudit({
      userId: auth.userId, actorDesignation: auth.designation,
      action: "CREATE",
      entity: "seasons",
      entityId: season.id,
    });
    return ok({ id: season.id }, 201);
  });
}
