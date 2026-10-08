import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getMonthlySheet } from "@/features/party-planning/monthly.server";

// GET — ONE Monthly Plan by id: its season, month and rows (scope applied in the service).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await getMonthlySheet(await requireAuth(), id)); });
}
