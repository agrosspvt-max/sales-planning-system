import { requireAuth } from "@/lib/http";
import { isAccountOwner } from "@/features/accounts/service.server";
import { AccountsPage } from "@/features/accounts/accounts-page";
import { Forbidden } from "@/components/layout/forbidden";
export default async function Page() {
  const ctx = await requireAuth();
  if (!await isAccountOwner(ctx.userId, ctx.role)) return <Forbidden />;
  if (ctx.authenticationMethod !== "credentials") return <p className="text-sm text-muted-foreground">Sign out and sign in with your normal username and password to use Account Management.</p>;
  return <AccountsPage />;
}
