import { auth } from "@/auth";
import { PerformancePage } from "@/features/daily-work/performance-page";

// Performance — one role-aware, date-range report (Phase 4). Sales Officer sees only their own rows; Regional
// Manager sees their authorized team; Super Admin sees the company. Scope, columns, filters and access
// rules are all enforced server-side by role; the page just renders the role's view.
export default async function Page() {
  const session = await auth();
  return <PerformancePage role={session!.user.role} />;
}
