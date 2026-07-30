import { type NextRequest } from "next/server";
import { handle, ok, requirePermission } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import {
  assignRm,
  getRmAssignmentHistory,
  listCurrentRmAssignments,
} from "@/features/assignments/service.server";

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requirePermission("rmAssignments", "read");
    const officerId = req.nextUrl.searchParams.get("officerId");
    if (officerId) return ok(await getRmAssignmentHistory(officerId));
    const search = (req.nextUrl.searchParams.get("search") ?? "").trim();
    return ok(await listCurrentRmAssignments(search));
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requirePermission("rmAssignments", "create");
    const body = await req.json();
    await assignRm(body);
    await writeAudit({ userId: auth.userId, action: "CREATE", entity: "rmAssignments" });
    return ok({ success: true }, 201);
  });
}
