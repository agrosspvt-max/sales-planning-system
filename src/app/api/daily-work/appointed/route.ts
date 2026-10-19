import { type NextRequest } from "next/server";
import { handle, ok } from "@/lib/http";
import { requirePartyAuth } from "@/lib/party-planning-access";
import { recordAppointedResult, resolveReportDateForOwner } from "@/features/daily-work/service.server";

// POST /api/daily-work/appointed — Daily Report "Appointed" for a market linked to the owner's approved Monthly Party Planning:
// the owner's monthly "Doc Send By SO" transition + the Daily Work result in ONE transaction (owner / report window / finalized day / eligibility enforced in the service).
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requirePartyAuth(); // the monthly transition is Party Planning: it follows PARTY_PLANNING_ENABLED
    const raw = await req.json();
    return ok(await recordAppointedResult(auth, { ...raw, workDate: await resolveReportDateForOwner(auth, raw?.workDate) }));
  });
}
