import { Role } from "@prisma/client";
import { auth } from "@/auth";
import { Forbidden } from "@/components/layout/forbidden";
import { SchemePaymentsPage } from "@/features/schemes/scheme-payments-page";

export default async function Page() {
  const session = await auth();
  // Payment Management mirrors the Enrolled Scheme received-payment authority — Super Admin only.
  if (session!.user.role !== Role.SUPER_ADMIN) return <Forbidden />;
  return <SchemePaymentsPage />;
}
