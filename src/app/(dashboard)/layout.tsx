import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { AppShell } from "@/components/layout/app-shell";
import { NavHistoryProvider } from "@/features/navigation/history";
import { getCalendarEnabled } from "@/lib/recovery-config";
import { isAccountOwner } from "@/features/accounts/service.server";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const calendarEnabled = await getCalendarEnabled();
  const accountOwner = await isAccountOwner(session.user.id, session.user.role);

  return (
    <AppShell
      user={{
        name: session.user.name ?? session.user.username,
        username: session.user.username,
        role: session.user.role,
        designation: session.user.designation,
        permissions: session.user.permissions,
        accountOwner,
      }}
      calendarEnabled={calendarEnabled}
    >
      {/* Centralized navigation history — records the real journey so Back is history-aware. */}
      <Suspense fallback={null}>
        <NavHistoryProvider>{children}</NavHistoryProvider>
      </Suspense>
    </AppShell>
  );
}
