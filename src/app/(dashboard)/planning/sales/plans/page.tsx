import { auth } from "@/auth";
import { SalesPlanning } from "@/features/planning/sales-planning";

// View side of Sales Planning (approved, read-only). Same component as Create, mode="view".
export default async function Page() {
  const session = await auth();
  return <SalesPlanning role={session!.user.role} userId={session!.user.id} mode="view" />;
}
