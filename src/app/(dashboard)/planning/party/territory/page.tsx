import { auth } from "@/auth";
import { TerritoryMappingPage } from "@/features/party-planning/territory-mapping-page";

// Party Planning → Territory Mapping (Dealer → Market). Scope and permissions are enforced by the APIs.
export default async function Page() {
  const session = await auth();
  return <TerritoryMappingPage role={session!.user.role} />;
}
