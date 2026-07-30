import { type NextRequest } from "next/server";
import { handle, ok, requirePermission } from "@/lib/http";
import { parsePageParams } from "@/lib/pagination";
import { getAuditFilterOptions, listAudit } from "@/features/audit/service.server";

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requirePermission("audit", "read"); // Super Admin only
    const sp = req.nextUrl.searchParams;
    if (sp.get("options") === "1") return ok<unknown>(await getAuditFilterOptions());
    const page = parsePageParams(sp);
    const data = await listAudit(
      {
        userId: sp.get("user") ?? undefined,
        entity: sp.get("entity") ?? undefined,
        action: sp.get("action") ?? undefined,
        from: sp.get("from") ?? undefined,
        to: sp.get("to") ?? undefined,
      },
      page,
    );
    return ok<unknown>(data);
  });
}
