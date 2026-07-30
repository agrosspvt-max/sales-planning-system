import { auth } from "@/auth";
import { SalesPlanning } from "@/features/planning/sales-planning";

// Create side of Sales Planning (editable / Draft plans).
export default async function Page() {
  const session = await auth();
  return <SalesPlanning role={session!.user.role} mode="create" />;
}
