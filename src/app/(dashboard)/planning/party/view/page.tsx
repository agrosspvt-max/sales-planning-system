import { auth } from "@/auth";
import { PartyViewPage } from "@/features/party-planning/party-planning-page";

// Party Planning — View (Submitted | Approved). Admin gets Approve/Reject on the Submitted tab; scope is
// enforced server-side (SO own, RM team, Admin all).
export default async function Page() {
  const session = await auth();
  return <PartyViewPage role={session!.user.role} />;
}
