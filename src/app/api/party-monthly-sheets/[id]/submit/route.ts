import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { submitMonthlySheet } from "@/features/party-planning/monthly.server";

// POST — the owner submits the prepared Monthly Plan for review (owner-only; the service enforces it).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await submitMonthlySheet(await requireAuth(), id)); });
}
