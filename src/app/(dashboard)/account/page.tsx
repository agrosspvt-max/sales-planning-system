import { auth } from "@/auth";
import { PageHeader } from "@/components/layout/page-header";
import { ChangePasswordCard } from "@/features/users/change-password-card";

export default async function AccountPage() {
  const session = await auth();
  return (
    <div className="space-y-5">
      <PageHeader title="My Account" subtitle={session!.user.name} showBreadcrumbs={false} />
      <ChangePasswordCard />
    </div>
  );
}
