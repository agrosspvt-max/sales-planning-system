import { PartyCreatePlanPage } from "@/features/party-planning/party-planning-page";

// Party Planning — Create Plan (the module's default). Any authenticated planning role can open it; the
// server enforces who may actually save/submit. Role is not needed here since Create Plan is always the
// caller's own editable set.
export default function Page() {
  return <PartyCreatePlanPage />;
}
