import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { AppShell } from "@/components/layout/app-shell";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <AppShell
      user={{
        name: session.user.name ?? session.user.username,
        username: session.user.username,
        role: session.user.role,
      }}
    >
      {children}
    </AppShell>
  );
}
