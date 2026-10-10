import { PartyPlanningUnavailable } from "@/features/party-planning/party-planning-unavailable";

// Rewrite target of the PARTY_PLANNING_ENABLED guard (see src/lib/party-planning-guard.ts).
export const dynamic = "force-dynamic";
export default function Page() {
  return <PartyPlanningUnavailable />;
}
