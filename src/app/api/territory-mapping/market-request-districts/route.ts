import { handle, ok, requireAuth } from "@/lib/http";
import { listRequesterDistricts } from "@/features/party-planning/territory.server";

// GET — the active districts of the requesting SO / RM's OWN State, for the Add Market form.
export async function GET() {
  return handle(async () => ok(await listRequesterDistricts(await requireAuth())));
}
