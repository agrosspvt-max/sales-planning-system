import { isPartyPlanningEnabled } from "@/lib/feature-flags";
import { PartyPlanningUnavailableView } from "./party-planning-unavailable-view";

/** What a Party Planning page shows while PARTY_PLANNING_ENABLED is off. No data is touched; the module returns when the flag is turned back on. */
export function PartyPlanningUnavailable() {
  return <PartyPlanningUnavailableView />;
}

/** Page-level guard (defence in depth next to the middleware): the unavailable page when the flag is off, else null. */
export function partyPlanningGate(): React.ReactNode | null {
  return isPartyPlanningEnabled() ? null : <PartyPlanningUnavailable />;
}
