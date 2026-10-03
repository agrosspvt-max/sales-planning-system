import { isAdministrativeRole } from "@/features/accounts/permissions";
import { auth } from "@/auth";
import { Forbidden } from "@/components/layout/forbidden";
import { SchemePaymentsPage } from "@/features/schemes/scheme-payments-page";

export default async function Page() {
  const session = await auth();
  // Payment Management mirrors the Enrolled Scheme received-payment authority — Super Admin only.
  if (!isAdministrativeRole(session!.user.role)) return <Forbidden />;
  return <SchemePaymentsPage />;
}
