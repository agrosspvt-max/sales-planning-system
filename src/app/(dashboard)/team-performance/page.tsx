import { Role } from "@prisma/client";
import { auth } from "@/auth";
import { Forbidden } from "@/components/layout/forbidden";
import { TeamPerformancePage } from "@/features/daily-work/team-performance-page";

// Team Performance — RM-only. An RM reviews their team's submitted Daily Work and rates each SO (immutable).
// Team membership + every review action is enforced server-side; this is only the entry-point role guard.
export default async function Page() {
  const session = await auth();
  if (session!.user.role !== Role.REGIONAL_MANAGER) return <Forbidden />;
  return <TeamPerformancePage />;
}
