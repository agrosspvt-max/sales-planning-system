import { type NextRequest } from "next/server";
import { requirePartyAuth } from "@/lib/party-planning-access";
import { handle, ok } from "@/lib/http";
import { submitSeasonalSheet } from "@/features/party-planning/seasonal.server";

// POST — the owner submits every editable entry of their Seasonal Plan as one batch (owner-only; the service enforces it).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => { const { id } = await params; return ok(await submitSeasonalSheet(await requirePartyAuth(), id)); });
}
