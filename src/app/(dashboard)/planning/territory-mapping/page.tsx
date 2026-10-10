import { auth } from "@/auth";
import { TerritoryMappingPage } from "@/features/party-planning/territory-mapping-page";

// Territory Mapping (Dealer → Market / District) — a standalone Create/View Plans module, independent of Party Planning. Scope and
// permissions are enforced by the /api/territory-mapping APIs (and the partyPlanning page grant).
export default async function Page() {
  const session = await auth();
  return <TerritoryMappingPage role={session!.user.role} />;
}
