import { auth } from "@/auth";
import { partyPlanningGate } from "@/features/party-planning/party-planning-unavailable";
import { PartyViewPage } from "@/features/party-planning/party-planning-page";

// Party Planning — View (Submitted | Approved). Admin gets Approve/Reject on the Submitted tab; scope is
// enforced server-side (SO own, RM team, Admin all).
export default async function Page() {
  const unavailable = partyPlanningGate(); // PARTY_PLANNING_ENABLED off → friendly page
  if (unavailable) return unavailable;
  const session = await auth();
  return <PartyViewPage role={session!.user.role} />;
}
