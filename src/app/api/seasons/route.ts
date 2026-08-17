import { type NextRequest } from "next/server";
import { handle, ok, requirePermission } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { createSeason, listSeasons } from "@/features/seasons/service.server";

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requirePermission("seasons", "read");
    const search = (req.nextUrl.searchParams.get("search") ?? "").trim();
    // active=true → only OPEN seasons (planning/recovery/import selectors). Omitted → all (management/reports).
    const activeOnly = req.nextUrl.searchParams.get("active") === "true";
    return ok(await listSeasons(search, activeOnly));
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requirePermission("seasons", "create");
    const season = await createSeason(await req.json());
    await writeAudit({
      userId: auth.userId,
      action: "CREATE",
      entity: "seasons",
      entityId: season.id,
    });
    return ok({ id: season.id }, 201);
  });
}
