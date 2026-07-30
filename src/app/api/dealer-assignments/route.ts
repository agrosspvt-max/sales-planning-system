import { type NextRequest } from "next/server";
import { handle, ok, requirePermission } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import {
  assignDealer,
  getDealerAssignmentHistory,
  listCurrentDealerAssignments,
} from "@/features/assignments/service.server";

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requirePermission("dealerAssignments", "read");
    const dealerId = req.nextUrl.searchParams.get("dealerId");
    if (dealerId) return ok(await getDealerAssignmentHistory(dealerId));
    const search = (req.nextUrl.searchParams.get("search") ?? "").trim();
    return ok(await listCurrentDealerAssignments(search));
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requirePermission("dealerAssignments", "create");
    const body = await req.json();
    await assignDealer(body);
    await writeAudit({ userId: auth.userId, action: "CREATE", entity: "dealerAssignments" });
    return ok({ success: true }, 201);
  });
}
